import copy
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import UUID

import pytest
from django.db import close_old_connections, connections
from django.test import Client

from specmate.access.models import Membership
from specmate.cables.queries import inspect_revision
from specmate.design.models import Definition, Snapshot
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)
from specmate.queries import get_draft, get_revision

from .conftest import op
from .test_interfaces import create as create_interface
from .test_interfaces import freeze as freeze_interface
from .test_interfaces import pinout

STOCK = {
    "construction": "bundle",
    "structure": {
        "id": "stock",
        "label": "Synthetic stock",
        "kind": "group",
        "role": "stock",
        "children": [
            {"id": "core", "label": "Core", "kind": "conductor"},
            {"id": "screen", "label": "Screen", "kind": "shield"},
            {"id": "drain", "label": "Drain", "kind": "drain"},
            {"id": "jacket", "label": "Jacket", "kind": "jacket"},
        ],
    },
}


def capture(user, draft, operation="cable.freeze", **ctx):
    return op(
        user, operation, {"draft_id": draft["draft_id"]}, expected_state=draft["state"], **ctx
    )


def create(user, project, cable, **ctx):
    return op(
        user,
        "cable.create",
        {"project_id": project, "name": "Synthetic cable", "cable": cable},
        **ctx,
    )


def fixture(user, project):
    stock_draft = op(
        user,
        "wire_stock.create",
        {"project_id": project, "name": "Synthetic stock", "stock": STOCK},
    )
    stock = capture(user, stock_draft, "wire_stock.freeze")
    body_draft = create_interface(user, project)
    body = freeze_interface(user, body_draft)
    pins = freeze_interface(user, create_interface(user, project, pinout(body)))
    cable = {
        "stock_revision_id": stock["revision_id"],
        "endpoints": [
            {
                "local_id": side,
                "body_revision_id": body["revision_id"],
                "pinout_revision_id": pins["revision_id"],
            }
            for side in ("left", "right")
        ],
        "assignments": [
            {
                "endpoint_id": side,
                "element_path": "stock.core",
                "contact_id": contact,
                "basis": "Synthetic terminal table",
            }
            for side, contact in (("left", "a"), ("right", "b"))
        ],
        "review": "reviewed",
        "review_basis": "Checked against synthetic terminal table",
    }
    return stock_draft, body_draft, stock, body, pins, cable


def test_reviewed_two_end_cable_preserves_identity_exact_pins_unknowns_and_immutability(
    users, project
):
    user = users["owner"]
    _, _, stock, body, pins, cable = fixture(user, project)
    draft = create(user, project, cable)
    frozen = capture(user, draft)
    result = inspect_revision(user, frozen["revision_id"])
    core, screen, drain = result["conductors"]
    assert core["element_path"] == "stock.core"
    assert core["stock_revision_id"] == stock["revision_id"]
    assert [e["assignment"]["contact_id"] for e in core["ends"]] == ["a", "b"]
    assert screen["kind"] == "shield" and drain["kind"] == "drain"
    assert all(e["assignment"] is None for row in (screen, drain) for e in row["ends"])
    assert result["endpoints"][0]["pinout"]["assignments"][0]["electrical"]["current_max_a"] is None
    assert result["endpoints"][0]["body"]["contacts"][0]["position_mm"] is None
    assert (
        result["continuity"]
        == result["compatibility"]
        == result["physical_qualification"]
        == "not_evaluated"
    )
    snapshot = Snapshot.objects.get(id=frozen["snapshot_id"])
    assert set(snapshot.dependencies.values_list("revision_id", flat=True)) == {
        UUID(r["revision_id"]) for r in (stock, body, pins)
    }
    canonical = bytes(snapshot.canonical)
    changed = copy.deepcopy(cable)
    changed["assignments"][1]["contact_id"] = "a"
    op(
        user,
        "cable.update",
        {"draft_id": draft["draft_id"], "cable": changed},
        expected_state=frozen["draft"]["state"],
    )
    freeze_interface(user, body["draft"])
    assert inspect_revision(user, frozen["revision_id"]) == result
    assert bytes(Snapshot.objects.get(id=snapshot.id).canonical) == canonical


@pytest.mark.parametrize(
    "change",
    [
        lambda c: c["assignments"].append({**c["assignments"][0], "contact_id": "b"}),
        lambda c: c["assignments"].append({**c["assignments"][0], "element_path": "stock.drain"}),
        lambda c: c["assignments"][0].update(element_path="stock.jacket"),
        lambda c: c["assignments"][0].update(element_path="stock"),
        lambda c: c["assignments"][0].update(element_path="missing.core"),
        lambda c: c["assignments"][0].update(contact_id="key"),
        lambda c: c["assignments"][0].update(contact_id="missing"),
        lambda c: c["assignments"][0].update(endpoint_id="missing"),
        lambda c: c["endpoints"][1].update(local_id="left"),
        lambda c: c.update(review_basis=None),
    ],
)
def test_invalid_assignments_roll_back_without_effects(users, project, change):
    *_, cable = fixture(users["owner"], project)
    change(cable)
    before = Definition.objects.count()
    with pytest.raises(ValidationFailed):
        create(users["owner"], project, cable)
    assert Definition.objects.count() == before


def test_exact_body_pinout_agreement_and_kinds(users, project):
    *_, cable = fixture(users["owner"], project)
    other = freeze_interface(users["owner"], create_interface(users["owner"], project))
    for field, replacement in (
        ("body_revision_id", other["revision_id"]),
        ("pinout_revision_id", other["revision_id"]),
    ):
        invalid = copy.deepcopy(cable)
        invalid["endpoints"][0][field] = replacement
        with pytest.raises(ValidationFailed):
            create(users["owner"], project, invalid)


def test_shield_and_drain_are_distinct_explicit_assignments(users, project):
    *_, cable = fixture(users["owner"], project)
    cable["assignments"] += [
        {
            "endpoint_id": "left",
            "element_path": "stock.screen",
            "contact_id": "shell",
            "basis": "Declared screen termination",
        },
        {
            "endpoint_id": "right",
            "element_path": "stock.drain",
            "contact_id": "shell",
            "basis": "Declared drain termination",
        },
    ]
    result = inspect_revision(
        users["owner"],
        capture(users["owner"], create(users["owner"], project, cable))["revision_id"],
    )
    assert result["conductors"][1]["ends"][1]["assignment"] is None
    assert result["conductors"][2]["ends"][0]["assignment"] is None


def test_generic_hooks_derive_pins_validate_content_and_recheck_reads(users, project):
    *_, cable = fixture(users["owner"], project)
    draft = op(
        users["owner"],
        "definition.create",
        {
            "project_id": project,
            "name": "Generic cable",
            "kind": "cable",
            "content": {"cable": cable},
        },
    )
    frozen = capture(users["owner"], draft, "draft.freeze")
    assert Snapshot.objects.get(id=frozen["snapshot_id"]).dependencies.count() == 3
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "definition.create",
            {
                "project_id": project,
                "name": "Wrong kind",
                "kind": "board",
                "content": {"cable": cable},
            },
        )
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "draft.freeze",
            {"draft_id": draft["draft_id"], "dependencies": [cable["stock_revision_id"]]},
            expected_state=frozen["draft"]["state"],
        )
    unfinished = op(
        users["owner"],
        "definition.create",
        {"project_id": project, "name": "Incomplete", "kind": "cable"},
    )
    with pytest.raises(ValidationFailed):
        capture(users["owner"], unfinished, "draft.freeze")


def test_replay_stale_conflicts_permissions_and_http(users, project):
    user = users["owner"]
    *_, cable = fixture(user, project)
    draft = create(user, project, cable, idempotency_key="create-cable")
    assert create(user, project, cable, idempotency_key="create-cable") == draft
    changed = {**cable, "review": "unreviewed"}
    with pytest.raises(IdempotencyMismatch):
        create(user, project, changed, idempotency_key="create-cable")
    frozen = capture(user, draft, idempotency_key="freeze-cable")
    assert capture(user, draft, idempotency_key="freeze-cable") == frozen
    with pytest.raises(Conflict):
        op(
            user,
            "cable.update",
            {"draft_id": draft["draft_id"], "cable": cable},
            expected_state=draft["state"],
        )
    for actor, error in (("viewer", PermissionDenied), ("outsider", NotFound)):
        with pytest.raises(error):
            create(users[actor], project, cable)
    client = Client()
    client.force_login(user)
    response = client.post(
        "/api/v0/operations",
        data=json.dumps(
            {
                "operation": "cable.read",
                "request_id": "cable-http",
                "payload": {"revision_id": frozen["revision_id"]},
            }
        ),
        content_type="application/json",
    )
    assert response.status_code == 200
    assert response.json()["result"]["conductors"][0]["element_path"] == "stock.core"
    assert client.get(f"/api/v0/cables/drafts/{draft['draft_id']}").status_code == 200
    assert client.get(f"/api/v0/cables/revisions/{frozen['revision_id']}").status_code == 200
    client.force_login(users["outsider"])
    assert client.get(f"/api/v0/cables/revisions/{frozen['revision_id']}").status_code == 404


@pytest.mark.django_db(transaction=True)
def test_concurrent_updates_preserve_cas(users, project):
    *_, cable = fixture(users["owner"], project)
    draft = create(users["owner"], project, cable)
    barrier = Barrier(2)

    def update(basis):
        close_old_connections()
        try:
            barrier.wait(timeout=5)
            op(
                users["owner"],
                "cable.update",
                {"draft_id": draft["draft_id"], "cable": {**cable, "review_basis": basis}},
                expected_state=draft["state"],
            )
            return "saved"
        except Conflict:
            return "conflict"
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(update, ["First review", "Second review"])) == ["conflict", "saved"]


def test_deep_source_revocation_precedes_diagnostics_replay_and_stale_state(users, project):
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
    raw = b"Synthetic cable reference."
    digest = hashlib.sha256(raw).hexdigest()
    blob = SourceBlob.objects.create(
        project_id=project,
        sha256=digest,
        size=len(raw),
        media_type="text/plain",
        registered_by=owner,
    )
    bundle = SourceBundle.objects.create(
        project_id=project, name="Synthetic evidence", role="original", created_by=owner
    )
    source = SourceBundleRevision.objects.create(
        bundle=bundle,
        number=1,
        manifest=b"{}",
        manifest_sha256=hashlib.sha256(b"{}").hexdigest(),
        created_by=owner,
    )
    SourceBundleFile.objects.create(
        revision=source,
        path="reference.txt",
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
                "bundle_revision_id": str(source.id),
                "path": "reference.txt",
                "locator": "line 1",
                "sha256": digest,
                "rights": "synthetic-test",
            },
        },
    )
    practice = op(
        owner,
        "workshop_profile.create",
        {"project_id": project, "name": "Synthetic practice", "profile": documented},
    )
    practice_revision = capture(owner, practice, "workshop_profile.freeze")
    stock_draft, _, stock, _, _, cable = fixture(owner, project)
    referenced_stock = op(
        owner,
        "draft.freeze",
        {"draft_id": stock_draft["draft_id"], "dependencies": [practice_revision["revision_id"]]},
        expected_state=stock["draft"]["state"],
    )
    cable["stock_revision_id"] = referenced_stock["revision_id"]
    draft = create(user, project, cable, idempotency_key="source-cable")
    frozen = capture(user, draft, idempotency_key="source-freeze")
    hidden = op(owner, "project.create", {"name": "Restricted evidence"})["project_id"]
    bundle.project_id = hidden
    bundle.save(update_fields=["project"])
    invalid = copy.deepcopy(cable)
    invalid["assignments"][0]["contact_id"] = "missing"
    actions = [
        lambda: create(user, project, cable),
        lambda: create(user, project, invalid),
        lambda: create(user, project, cable, idempotency_key="source-cable"),
        lambda: capture(user, draft, idempotency_key="source-freeze"),
        lambda: inspect_revision(user, frozen["revision_id"]),
        lambda: get_revision(user, frozen["revision_id"]),
        lambda: get_draft(user, draft["draft_id"]),
    ]
    for state in (frozen["draft"]["state"], "stale"):
        actions.append(
            lambda state=state: op(
                user,
                "cable.update",
                {"draft_id": draft["draft_id"], "cable": invalid},
                expected_state=state,
            )
        )
    for action in actions:
        with pytest.raises(NotFound):
            action()
    client = Client()
    client.force_login(user)
    for path in (
        f"cables/revisions/{frozen['revision_id']}",
        f"cables/drafts/{draft['draft_id']}",
        f"revisions/{frozen['revision_id']}/snapshot",
    ):
        response = client.get(f"/api/v0/{path}")
        assert response.status_code == 404
        assert referenced_stock["revision_id"].encode() not in response.content


def test_retained_create_and_update_results_authorize_original_references(users, project):
    owner, user = users["owner"], users["editor"]
    private = op(owner, "project.create", {"name": "Shared then restricted"})["project_id"]
    grant = Membership.objects.create(user=user, project_id=private, role="viewer")
    *_, old = fixture(owner, private)
    *_, current = fixture(owner, project)
    draft = create(user, project, old, idempotency_key="retained-create")
    updated = op(
        user,
        "cable.update",
        {"draft_id": draft["draft_id"], "cable": old},
        expected_state=draft["state"],
        idempotency_key="retained-update",
    )
    op(
        user,
        "cable.update",
        {"draft_id": draft["draft_id"], "cable": current},
        expected_state=updated["state"],
    )
    grant.delete()
    assert (
        get_draft(user, draft["draft_id"])["content"]["cable"]["stock_revision_id"]
        == current["stock_revision_id"]
    )
    with pytest.raises(NotFound):
        create(user, project, old, idempotency_key="retained-create")
    with pytest.raises(NotFound):
        op(
            user,
            "cable.update",
            {"draft_id": draft["draft_id"], "cable": old},
            expected_state=draft["state"],
            idempotency_key="retained-update",
        )


def test_new_reference_authority_precedes_stale_token(users, project):
    owner, user = users["owner"], users["editor"]
    *_, current = fixture(owner, project)
    private = op(owner, "project.create", {"name": "Private endpoint references"})["project_id"]
    *_, hidden = fixture(owner, private)
    draft = create(user, project, current)
    with pytest.raises(NotFound):
        op(
            user,
            "cable.update",
            {"draft_id": draft["draft_id"], "cable": hidden},
            expected_state="stale",
        )
