import copy
import json
from uuid import UUID

import pytest
from django.db import DatabaseError, transaction
from django.test import Client

from specmate.access.models import Membership
from specmate.bom.queries import inspect_revision
from specmate.design.models import Definition, Snapshot
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)

from .conftest import op


def capture(user, draft, operation="draft.freeze", **kwargs):
    return op(
        user, operation, {"draft_id": draft["draft_id"]}, expected_state=draft["state"], **kwargs
    )


def part(user, project, name):
    return capture(
        user, op(user, "definition.create", {"project_id": project, "kind": "part", "name": name})
    )


def assembly(user, project, children):
    return capture(
        user,
        op(
            user,
            "assembly.create",
            {
                "project_id": project,
                "name": "Synthetic assembly",
                "assembly": {
                    "occurrences": [
                        {"local_id": name, "revision_id": rev["revision_id"]}
                        for name, rev in children
                    ]
                },
            },
        ),
        "assembly.freeze",
    )


def policy(path, revision, decision):
    return {
        "path": path,
        "revision_id": revision["revision_id"],
        "decision": decision,
        "basis": "Explicit synthetic planning decision",
    }


def fixture(user, project):
    component = part(user, project, "Synthetic resistor")
    board = assembly(user, project, [("resistor", component)])
    root = assembly(user, project, [("left", board), ("right", board)])
    plan = {
        "assembly_revision_id": root["revision_id"],
        "quantity": {"status": "known", "amount": 1},
        "policies": [
            policy([], root, "make"),
            policy(["left"], board, "buy"),
            policy(["right"], board, "make"),
            policy(["right", "resistor"], component, "buy"),
        ],
    }
    return component, board, root, plan


def create(user, project, plan, **kwargs):
    return op(
        user, "bom.create", {"project_id": project, "name": "Synthetic plan", "bom": plan}, **kwargs
    )


def test_bought_board_boundary_repeated_occurrences_exact_closure_and_immutable_history(
    users, project
):
    user = users["owner"]
    component, board, root, plan = fixture(user, project)
    draft = create(user, project, plan)
    frozen = capture(user, draft, "bom.freeze")
    view = inspect_revision(user, frozen["revision_id"])
    assert [
        (r["address"]["path"], r["revision_id"], r["quantity"]["amount"]) for r in view["rows"]
    ] == [(["left"], board["revision_id"], 1), (["right", "resistor"], component["revision_id"], 1)]
    assert len(inspect_revision(user, frozen["revision_id"], "assembly_contents")["rows"]) == 4
    snapshot = Snapshot.objects.get(id=frozen["snapshot_id"])
    assert set(snapshot.dependencies.values_list("revision_id", flat=True)) == {
        UUID(r["revision_id"]) for r in (component, board, root)
    }
    before = bytes(snapshot.canonical)
    plan["policies"][1]["decision"] = "make"
    op(
        user,
        "bom.update",
        {"draft_id": draft["draft_id"], "bom": plan},
        expected_state=frozen["draft"]["state"],
    )
    assert bytes(Snapshot.objects.get(id=snapshot.id).canonical) == before
    assert inspect_revision(user, frozen["revision_id"])["rows"] == view["rows"]
    with pytest.raises(DatabaseError), transaction.atomic():
        Snapshot.objects.filter(id=snapshot.id).update(canonical=b"changed")


def test_root_buy_unknown_scope_does_not_bypass_and_unknown_count(users, project):
    user = users["owner"]
    _, _, root, plan = fixture(user, project)
    plan["policies"] = [policy([], root, "buy")]
    frozen = capture(user, create(user, project, plan), "bom.freeze")
    view = inspect_revision(user, frozen["revision_id"])
    assert len(view["rows"]) == 1
    assert view["rows"][0]["revision_id"] == root["revision_id"]
    plan["scope_paths"] = [["left", "resistor"]]
    frozen = capture(user, create(user, project, plan), "bom.freeze")
    assert inspect_revision(user, frozen["revision_id"])["rows"] == []
    assert inspect_revision(user, frozen["revision_id"])["boundaries"][0]["decision"] == "buy"
    plan.pop("scope_paths")
    plan["policies"] = []
    frozen = capture(user, create(user, project, plan), "bom.freeze")
    assert (
        inspect_revision(user, frozen["revision_id"])["unresolved"][0]["reason"]
        == "make_buy_unknown"
    )
    plan["policies"] = [policy([], root, "buy")]
    plan["quantity"] = {"status": "unknown"}
    frozen = capture(user, create(user, project, plan), "bom.freeze")
    assert inspect_revision(user, frozen["revision_id"])["rows"][0]["quantity"]["amount"] is None


def test_purpose_needs_separate_from_contents_and_suppressed_at_buy(users, project):
    user = users["owner"]
    _, _, _, plan = fixture(user, project)
    needs = [part(user, project, name) for name in ("Blank", "Population kit", "Cleaning wipe")]
    plan["needs"] = [
        {
            "local_id": purpose,
            "context_path": ["right"],
            "revision_id": revision["revision_id"],
            "purpose": purpose,
            "quantity": {"status": "known", "amount": 2},
            "basis": "Synthetic process declaration",
        }
        for purpose, revision in zip(
            ("pcb_fabrication", "pcb_population", "consumables"), needs, strict=True
        )
    ]
    frozen = capture(user, create(user, project, plan), "bom.freeze")
    for purpose in ("pcb_fabrication", "pcb_population", "consumables"):
        rows = inspect_revision(user, frozen["revision_id"], purpose)["rows"]
        assert (
            len(rows) == 1 and rows[0]["need_id"] == purpose and rows[0]["quantity"]["amount"] == 2
        )
    assert len(inspect_revision(user, frozen["revision_id"], "assembly_contents")["rows"]) == 4
    assert all(
        r["need_id"] != "consumables" for r in inspect_revision(user, frozen["revision_id"])["rows"]
    )
    plan["policies"][2]["decision"] = "buy"
    frozen = capture(user, create(user, project, plan), "bom.freeze")
    assert inspect_revision(user, frozen["revision_id"], "consumables")["rows"] == []


@pytest.mark.parametrize(
    "mutation",
    [
        lambda p: p.update(quantity={"status": "known", "amount": True}),
        lambda p: p.update(quantity={"status": "known", "amount": 0}),
        lambda p: p.update(quantity={"status": "known", "amount": 1.2}),
        lambda p: p.update(scope_paths=[["left"], ["left", "resistor"]]),
        lambda p: p["policies"][1].update(path=["missing"]),
        lambda p: p["policies"][1].update(revision_id=p["assembly_revision_id"]),
    ],
)
def test_invalid_plan_rolls_back(users, project, mutation):
    *_, plan = fixture(users["owner"], project)
    mutation(plan)
    before = Definition.objects.count()
    with pytest.raises(ValidationFailed):
        create(users["owner"], project, plan)
    assert Definition.objects.count() == before


def test_replay_cas_authorization_and_dependency_revocation(users, project):
    user = users["editor"]
    Membership.objects.filter(user=user, project_id=project).update(grants=["design.freeze"])
    private = op(users["owner"], "project.create", {"name": "Private reference"})["project_id"]
    member = Membership.objects.create(user=user, project_id=private, role="viewer")
    *_, plan = fixture(users["owner"], private)
    draft = create(user, project, plan, idempotency_key="create")
    assert create(user, project, plan, idempotency_key="create") == draft
    changed = copy.deepcopy(plan)
    changed["quantity"]["amount"] = 2
    with pytest.raises(IdempotencyMismatch):
        create(user, project, changed, idempotency_key="create")
    frozen = capture(user, draft, "bom.freeze", idempotency_key="freeze")
    assert capture(user, draft, "bom.freeze", idempotency_key="freeze") == frozen
    with pytest.raises(Conflict):
        op(
            user,
            "bom.update",
            {"draft_id": draft["draft_id"], "bom": plan},
            expected_state=draft["state"],
        )
    with pytest.raises(PermissionDenied):
        create(users["viewer"], project, plan)
    member.delete()
    for action in (
        lambda: create(user, project, plan, idempotency_key="create"),
        lambda: capture(user, draft, "bom.freeze", idempotency_key="freeze"),
        lambda: inspect_revision(user, frozen["revision_id"]),
        lambda: op(
            user, "bom.update", {"draft_id": draft["draft_id"], "bom": plan}, expected_state="stale"
        ),
    ):
        with pytest.raises(NotFound):
            action()


def test_http_jobs_and_generic_capture_hooks(users, project):
    *_, plan = fixture(users["owner"], project)
    client = Client()
    client.force_login(users["owner"])
    response = client.post(
        "/api/v0/operations",
        data=json.dumps(
            {
                "operation": "bom.create",
                "request_id": "bom-http",
                "payload": {"project_id": project, "name": "HTTP plan", "bom": plan},
            }
        ),
        content_type="application/json",
    )
    assert response.status_code == 200
    draft = response.json()["result"]
    frozen = capture(users["owner"], draft)
    assert len(Snapshot.objects.get(id=frozen["snapshot_id"]).dependencies.all()) == 3
    response = client.get(
        f"/api/v0/bom/revisions/{frozen['revision_id']}", {"purpose": "procurement"}
    )
    assert response.status_code == 200
    assert op(users["owner"], "bom.read", {"revision_id": frozen["revision_id"]}) == response.json()
    client.force_login(users["outsider"])
    assert client.get(f"/api/v0/bom/revisions/{frozen['revision_id']}").status_code == 404
    assert client.get(f"/api/v0/bom/drafts/{draft['draft_id']}").status_code == 404


def test_supplemental_hidden_dependency_rechecked_before_bad_path_and_after_freeze(users, project):
    user = users["editor"]
    Membership.objects.filter(user=user, project_id=project).update(grants=["design.freeze"])
    private = op(users["owner"], "project.create", {"name": "Restricted process input"})[
        "project_id"
    ]
    membership = Membership.objects.create(user=user, project_id=private, role="viewer")
    hidden = part(users["owner"], private, "Synthetic restricted wipe")
    *_, plan = fixture(users["owner"], project)
    plan["needs"] = [
        {
            "local_id": "wipe",
            "context_path": [],
            "revision_id": hidden["revision_id"],
            "purpose": "consumables",
            "basis": "Explicit need",
        }
    ]
    draft = create(user, project, plan)
    frozen = capture(user, draft, "bom.freeze")
    assert (
        inspect_revision(user, frozen["revision_id"], "consumables")["rows"][0]["quantity"][
            "status"
        ]
        == "unknown"
    )
    membership.delete()
    with pytest.raises(NotFound):
        inspect_revision(user, frozen["revision_id"])
    plan["needs"][0]["context_path"] = ["invalid"]
    with pytest.raises(NotFound):
        create(user, project, plan)


def test_supplemental_cannot_duplicate_retained_child_and_freeze_requires_current_grant(
    users, project
):
    user = users["editor"]
    Membership.objects.filter(user=user, project_id=project).update(grants=["design.freeze"])
    component, _, _, plan = fixture(users["owner"], project)
    invalid = copy.deepcopy(plan)
    invalid["needs"] = [
        {
            "local_id": "duplicated",
            "context_path": ["right"],
            "revision_id": component["revision_id"],
            "purpose": "pcb_population",
            "basis": "Invalid duplicate demand",
        }
    ]
    with pytest.raises(ValidationFailed):
        create(user, project, invalid)
    draft = create(user, project, plan)
    capture(user, draft, "bom.freeze", idempotency_key="freeze-grant")
    Membership.objects.filter(user=user, project_id=project).update(grants=[])
    with pytest.raises(PermissionDenied):
        capture(user, draft, "bom.freeze", idempotency_key="freeze-grant")


def test_generic_mutations_cannot_bypass_bom_kind_validation_or_pin_capture(users, project):
    user = users["owner"]
    *_, plan = fixture(user, project)
    with pytest.raises(ValidationFailed):
        op(
            user,
            "definition.create",
            {"project_id": project, "name": "Bad kind", "kind": "part", "content": {"bom": plan}},
        )
    empty = op(
        user, "definition.create", {"project_id": project, "name": "Unfinished", "kind": "bom_plan"}
    )
    with pytest.raises(ValidationFailed):
        capture(user, empty)
    draft = create(user, project, plan)
    with pytest.raises(ValidationFailed):
        op(
            user,
            "draft.freeze",
            {"draft_id": draft["draft_id"], "dependencies": [plan["assembly_revision_id"]]},
            expected_state=draft["state"],
        )


@pytest.mark.django_db(transaction=True)
def test_concurrent_bom_updates_have_one_winner(users, project):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from django.db import close_old_connections, connections

    *_, plan = fixture(users["owner"], project)
    draft = create(users["owner"], project, plan)
    barrier = Barrier(2)

    def update(amount):
        close_old_connections()
        try:
            changed = copy.deepcopy(plan)
            changed["quantity"]["amount"] = amount
            barrier.wait(timeout=5)
            op(
                users["owner"],
                "bom.update",
                {"draft_id": draft["draft_id"], "bom": changed},
                expected_state=draft["state"],
            )
            return "saved"
        except Conflict:
            return "conflict"
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(update, [2, 3])) == ["conflict", "saved"]


@pytest.mark.parametrize("reference_kind", ["supplemental", "assembly_child"])
def test_typed_source_revocation_denies_all_bom_paths_even_below_buy_boundary(
    users, project, reference_kind
):
    import hashlib

    from specmate.sources.models import (
        SourceBlob,
        SourceBundle,
        SourceBundleFile,
        SourceBundleRevision,
    )

    from .test_workshop_profiles import profile, stock_revision

    owner, user = users["owner"], users["editor"]
    Membership.objects.filter(user=user, project_id=project).update(grants=["design.freeze"])
    stock_id, _ = stock_revision(users, project)
    raw = b"Synthetic process instruction."
    digest = hashlib.sha256(raw).hexdigest()
    blob = SourceBlob.objects.create(
        project_id=project,
        sha256=digest,
        size=len(raw),
        media_type="text/plain",
        registered_by=owner,
    )
    bundle = SourceBundle.objects.create(
        project_id=project, name="Synthetic provenance", role="original", created_by=owner
    )
    source_revision = SourceBundleRevision.objects.create(
        bundle=bundle,
        number=1,
        manifest=b"{}",
        manifest_sha256=hashlib.sha256(b"{}").hexdigest(),
        created_by=owner,
    )
    SourceBundleFile.objects.create(
        revision=source_revision,
        path="instruction.txt",
        blob=blob,
        media_type="text/plain",
        rights="synthetic-test",
    )
    documented = profile(
        stock_id,
        foil_visibility={
            "value": "hide",
            "basis": "documented",
            "source": {
                "kind": "source_file",
                "bundle_revision_id": str(source_revision.id),
                "path": "instruction.txt",
                "locator": "line 1",
                "sha256": digest,
                "rights": "synthetic-test",
            },
        },
    )
    profile_draft = op(
        owner,
        "workshop_profile.create",
        {
            "project_id": project,
            "name": "Synthetic referenced profile",
            "profile": documented,
        },
    )
    profile_revision = capture(owner, profile_draft, "workshop_profile.freeze")
    root = assembly(
        owner,
        project,
        [("process", profile_revision)] if reference_kind == "assembly_child" else [],
    )
    plan = {
        "assembly_revision_id": root["revision_id"],
        "quantity": {"status": "known", "amount": 1},
        "policies": [policy([], root, "buy")],
        "needs": []
        if reference_kind == "assembly_child"
        else [
            {
                "local_id": "process",
                "context_path": [],
                "revision_id": profile_revision["revision_id"],
                "purpose": "consumables",
                "basis": "Explicit planning reference",
            }
        ],
    }
    draft = create(user, project, plan, idempotency_key="source-backed-bom")
    frozen = capture(user, draft, "bom.freeze", idempotency_key="source-backed-freeze")
    assert len(inspect_revision(user, frozen["revision_id"])["rows"]) == 1
    hidden_project = op(owner, "project.create", {"name": "Restricted provenance"})["project_id"]
    bundle.project_id = hidden_project
    bundle.save(update_fields=["project"])
    malformed = copy.deepcopy(plan)
    malformed["scope_paths"] = [["missing"]]
    malformed_demand = copy.deepcopy(plan)
    malformed_demand["occurrence_demands"] = [
        {
            "path": [],
            "revision_id": root["revision_id"],
            "quantity": {"status": "known", "amount": "1", "unit": "m"},
            "basis": "Synthetic dimension diagnostic must follow source authority",
            "waste": {
                "quantity": {"status": "known", "amount": "1", "unit": "kg"},
                "basis": "Deliberately mismatched synthetic waste",
            },
        }
    ]
    malformed_count = copy.deepcopy(malformed_demand)
    malformed_count["occurrence_demands"][0]["quantity"] = {
        "status": "known",
        "amount": "0.1",
        "unit": "ea",
    }
    actions = [
        lambda: create(user, project, plan),
        lambda: create(user, project, malformed),
        lambda: create(user, project, malformed_demand),
        lambda: create(user, project, malformed_count),
        lambda: create(user, project, plan, idempotency_key="source-backed-bom"),
        lambda: capture(user, draft, "bom.freeze", idempotency_key="source-backed-freeze"),
        lambda: inspect_revision(user, frozen["revision_id"]),
        lambda: op(user, "bom.read", {"revision_id": frozen["revision_id"]}),
    ]
    for state in (frozen["draft"]["state"], "stale"):
        with pytest.raises(NotFound):
            op(
                user,
                "bom.update",
                {"draft_id": draft["draft_id"], "bom": plan},
                expected_state=state,
            )
    for action in actions:
        with pytest.raises(NotFound):
            action()
    client = Client()
    client.force_login(user)
    for path in (f"revisions/{frozen['revision_id']}", f"drafts/{draft['draft_id']}"):
        response = client.get(f"/api/v0/bom/{path}")
        assert response.status_code == 404
        assert profile_revision["revision_id"].encode() not in response.content
        assert str(source_revision.id).encode() not in response.content


def test_nested_authorization_cycle_fails_bounded_and_resets_context(monkeypatch):
    from types import SimpleNamespace
    from uuid import uuid4

    from specmate.bom import queries

    revision = SimpleNamespace(snapshot_id=uuid4(), snapshot=object())
    calls = []

    def recursive_authorize(user, snapshot):
        calls.append(snapshot)
        queries.authorize_reference(user, revision)

    monkeypatch.setattr(queries, "authorize_snapshot", recursive_authorize)
    with pytest.raises(ValidationFailed, match="nesting limit or dependency cycle"):
        queries.authorize_reference(None, revision)
    assert calls == [revision.snapshot]
    monkeypatch.setattr(
        queries, "authorize_snapshot", lambda user, snapshot: calls.append(snapshot)
    )
    queries.authorize_reference(None, revision)
    assert calls == [revision.snapshot, revision.snapshot]
