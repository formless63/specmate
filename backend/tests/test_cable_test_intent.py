"""ACC-CAB-004 synthetic declared expectations, never physical test evidence."""

import copy
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import UUID

import pytest
from django.db import close_old_connections, connections

from specmate.access.models import WorkspaceMember
from specmate.cable_test_intent.contracts import InspectTarget
from specmate.cable_test_intent.queries import inspect_target, portable_package, result
from specmate.design.models import Definition, Snapshot
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    Unauthenticated,
    ValidationFailed,
)
from specmate.queries import get_draft, get_revision

from .conftest import ensure_member, op, remove_member
from .scope_helpers import workspace_of
from .test_assemblies import create as create_assembly
from .test_assemblies import freeze as freeze_assembly
from .test_assemblies import occ, part
from .test_cables import capture as freeze_cable
from .test_cables import create as create_cable
from .test_cables import fixture as cable_fixture
from .test_catalog_matching import source_evidence
from .test_transports import api, post_op


def contact(endpoint, contact_id):
    return {"endpoint_id": endpoint, "kind": "contact", "contact_id": contact_id}


def feature(endpoint, path):
    return {"endpoint_id": endpoint, "kind": "stock_feature", "element_path": path}


def expectation(first, second, intent="unknown", local_id="pair"):
    return {
        "local_id": local_id,
        "first": first,
        "second": second,
        "intent": intent,
        "basis": "Independent synthetic bench expectation",
    }


def create(user, project, plan, **ctx):
    return op(
        user,
        "cable_test_plan.create",
        {
            "workspace_id": workspace_of(project),
            "name": "Synthetic cable test plan",
            "test_plan": plan,
        },
        **ctx,
    )


def freeze(user, draft, **ctx):
    return op(
        user,
        "cable_test_plan.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
        **ctx,
    )


def foreign_cable(users):
    """A frozen cable in the outsider's separate workspace."""
    outsider = users["outsider"]
    remote = op(outsider, "project.create", {"name": "Foreign cable bench"})["project_id"]
    *_, specification = cable_fixture(outsider, remote)
    return freeze_cable(outsider, create_cable(outsider, remote, specification))


@pytest.fixture
def cable(users, project):
    *_, specification = cable_fixture(users["owner"], project)
    return freeze_cable(users["owner"], create_cable(users["owner"], project, specification))


@pytest.fixture
def plan(cable):
    return {
        "root_revision_id": cable["revision_id"],
        "cable_revision_id": cable["revision_id"],
        "pairs": [
            expectation(contact("left", "a"), contact("right", "b"), "continuity", "core"),
            expectation(contact("left", "a"), contact("left", "shell"), "isolation", "screen"),
            expectation(
                feature("left", "stock.drain"), feature("right", "stock.drain"), local_id="drain"
            ),
        ],
        "labels": [
            {"local_id": "cable", "text": "Synthetic test article", "basis": "Declared label"},
            {"local_id": "end", "text": "LEFT", "endpoint_id": "left", "basis": "Declared label"},
            {
                "local_id": "core",
                "text": "CORE",
                "terminal": feature("left", "stock.core"),
                "basis": "Declared label",
            },
        ],
    }


def test_exact_unknown_expectations_portable_closure_and_immutable_history(
    users, project, cable, plan
):
    owner = users["owner"]
    draft = create(owner, project, plan)
    frozen = freeze(owner, draft)
    inspected = result(users["viewer"], frozen["revision_id"])
    assert [p["intent"] for p in inspected["test_plan"]["pairs"]] == [
        "continuity",
        "isolation",
        "unknown",
    ]
    assert inspected["physical_test"] == "not_performed"
    assert (
        inspected["physical_continuity"] == inspected["physical_qualification"] == "not_evaluated"
    )
    assert inspected["evidence"][0]["evidence"]["status"] == "unknown"
    assert {
        t["terminal"]["element_path"]
        for t in inspected["terminals"]
        if t["terminal"]["kind"] == "stock_feature"
    } == {"stock.core", "stock.screen", "stock.drain"}
    snapshot = Snapshot.objects.get(id=frozen["snapshot_id"])
    before = bytes(snapshot.canonical)
    assert list(snapshot.dependencies.values_list("revision_id", flat=True)) == [
        UUID(cable["revision_id"])
    ]
    data, digest = portable_package(users["viewer"], frozen["revision_id"])
    assert digest == hashlib.sha256(data).hexdigest()
    package = json.loads(data)
    assert package["test_plan"]["pairs"] == inspected["test_plan"]["pairs"]
    assert (
        package["source_bytes"] == "not_included"
        and package["distribution_rights"] == "not_evaluated"
    )
    for row in [package["plan_snapshot"], *package["design_revisions"]]:
        assert (
            row["sha256"]
            == hashlib.sha256(
                json.dumps(
                    row["canonical"], sort_keys=True, separators=(",", ":"), ensure_ascii=False
                ).encode()
            ).hexdigest()
        )
    assert len(package["design_revisions"]) == 4  # Cable, stock, body, pinout.
    changed = copy.deepcopy(plan)
    changed["pairs"][0]["intent"] = "isolation"
    updated = op(
        owner,
        "cable_test_plan.update",
        {"draft_id": draft["draft_id"], "test_plan": changed},
        expected_state=frozen["draft"]["state"],
    )
    second = op(
        owner, "draft.freeze", {"draft_id": updated["draft_id"]}, expected_state=updated["state"]
    )
    assert result(owner, second["revision_id"])["test_plan"]["pairs"][0]["intent"] == "isolation"
    assert result(owner, frozen["revision_id"]) == inspected
    assert bytes(Snapshot.objects.get(id=snapshot.id).canonical) == before
    assert portable_package(owner, frozen["revision_id"])[0] == data


def test_repeated_nested_occurrences_have_independent_intent_and_no_parent_package_content(
    users, project, cable, plan
):
    owner = users["owner"]
    nested = freeze_assembly(
        owner, create_assembly(owner, project, [occ("cable", cable, "Repeated")])
    )
    _, unrelated = part(owner, project, name="Synthetic unrelated parent item")
    root = freeze_assembly(
        owner,
        create_assembly(
            owner, project, [occ("one", nested), occ("two", nested), occ("other", unrelated)]
        ),
    )
    frozen = []
    for path, intent in ((["one", "cable"], "continuity"), (["two", "cable"], "isolation")):
        value = copy.deepcopy(plan)
        value.update(root_revision_id=root["revision_id"], occurrence_path=path)
        value["pairs"][0]["intent"] = intent
        frozen.append(freeze(owner, create(owner, project, value)))
    assert [result(owner, f["revision_id"])["test_plan"]["pairs"][0]["intent"] for f in frozen] == [
        "continuity",
        "isolation",
    ]
    package = json.loads(portable_package(owner, frozen[0]["revision_id"])[0])
    assert package["scope"]["occurrence_path"] == ["one", "cable"]
    embedded = {r["revision_id"] for r in package["design_revisions"]}
    assert root["revision_id"] not in embedded and unrelated["revision_id"] not in embedded
    target = inspect_target(
        owner,
        InspectTarget(
            root_revision_id=root["revision_id"],
            cable_revision_id=cable["revision_id"],
            occurrence_path=["two", "cable"],
        ),
    )
    assert target["root_snapshot_id"] == root["snapshot_id"]
    assert target["occurrence_path"] == ["two", "cable"]
    wrong = {**plan, "root_revision_id": root["revision_id"], "occurrence_path": ["other"]}
    with pytest.raises(ValidationFailed):
        create(owner, project, wrong)


@pytest.mark.parametrize(
    "change",
    [
        lambda p: p["pairs"][0]["first"].update(contact_id="key"),
        lambda p: p["pairs"][0]["first"].update(endpoint_id="missing"),
        lambda p: p["pairs"][2]["first"].update(element_path="stock.jacket"),
        lambda p: p["pairs"][2]["first"].update(element_path="stock"),
        lambda p: p["labels"][1].update(endpoint_id="missing"),
        lambda p: p["labels"][2]["terminal"].update(element_path="stock.missing"),
        lambda p: p["pairs"][0].update(second=p["pairs"][0]["first"]),
        lambda p: p["pairs"].append(
            {
                **p["pairs"][0],
                "local_id": "again",
                "first": p["pairs"][0]["second"],
                "second": p["pairs"][0]["first"],
            }
        ),
        lambda p: p["labels"].append(p["labels"][0]),
        lambda p: p.update(physical_test="passed"),
        lambda p: p["pairs"][0].update(basis="   "),
        lambda p: p["labels"][0].update(text="   "),
    ],
)
def test_invalid_pairs_labels_and_false_test_fields_rollback(users, project, plan, change):
    change(plan)
    before = Definition.objects.count()
    with pytest.raises(ValidationFailed):
        create(users["owner"], project, plan)
    assert Definition.objects.count() == before


def test_generic_design_guards_and_exact_dependency_capture(users, project, plan, cable):
    owner = users["owner"]
    draft = op(
        owner,
        "definition.create",
        {
            "workspace_id": workspace_of(project),
            "name": "Synthetic generic plan",
            "kind": "cable_test_plan",
            "content": {"test_plan": plan},
        },
    )
    _, arbitrary = part(owner, project)
    with pytest.raises(ValidationFailed):
        op(
            owner,
            "draft.freeze",
            {"draft_id": draft["draft_id"], "dependencies": [arbitrary["revision_id"]]},
            expected_state=draft["state"],
        )
    frozen = op(
        owner, "draft.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"]
    )
    assert list(
        map(
            str,
            Snapshot.objects.get(id=frozen["snapshot_id"]).dependencies.values_list(
                "revision_id", flat=True
            ),
        )
    ) == [cable["revision_id"]]
    bad = copy.deepcopy(plan)
    bad["pairs"][0]["first"]["contact_id"] = "key"
    with pytest.raises(ValidationFailed):
        op(
            owner,
            "draft.update",
            {"draft_id": draft["draft_id"], "changes": {"test_plan": bad}},
            expected_state=frozen["draft"]["state"],
        )
    with pytest.raises(ValidationFailed):
        op(
            owner,
            "definition.create",
            {
                "workspace_id": workspace_of(project),
                "name": "Wrong kind",
                "kind": "part",
                "content": {"test_plan": plan},
            },
        )


def test_cas_replay_permission_and_api_download(users, project, plan):
    owner = users["owner"]
    draft = create(owner, project, plan, idempotency_key="plan")
    assert create(owner, project, plan, idempotency_key="plan") == draft
    changed = copy.deepcopy(plan)
    changed["labels"][0]["text"] = "New text"
    with pytest.raises(IdempotencyMismatch):
        create(owner, project, changed, idempotency_key="plan")
    updated = op(
        owner,
        "cable_test_plan.update",
        {"draft_id": draft["draft_id"], "test_plan": changed},
        expected_state=draft["state"],
    )
    with pytest.raises(Conflict):
        op(
            owner,
            "cable_test_plan.update",
            {"draft_id": draft["draft_id"], "test_plan": plan},
            expected_state=draft["state"],
        )
    snapshot = op(
        owner,
        "cable_test_plan.snapshot",
        {"draft_id": updated["draft_id"]},
        expected_state=updated["state"],
    )
    assert Snapshot.objects.get(id=snapshot["snapshot_id"]).sha256 == snapshot["sha256"]
    frozen = freeze(owner, updated)
    viewer = api(users["viewer"])
    assert viewer.get(f"/api/v0/cable-test-intent/drafts/{draft['draft_id']}").status_code == 200
    assert (
        viewer.get(f"/api/v0/cable-test-intent/revisions/{frozen['revision_id']}").status_code
        == 200
    )
    response = viewer.get(f"/api/v0/cable-test-intent/revisions/{frozen['revision_id']}/package")
    assert response.status_code == 200 and response["Cache-Control"] == "private, no-store"
    assert response["Digest"] == f"sha-256={hashlib.sha256(response.content).hexdigest()}"
    assert (
        post_op(
            viewer,
            "cable_test_plan.update",
            {"draft_id": draft["draft_id"], "test_plan": changed},
            expected_state=frozen["draft"]["state"],
        ).status_code
        == 403
    )
    with pytest.raises(PermissionDenied):
        create(users["viewer"], project, plan)
    with pytest.raises(PermissionDenied):
        freeze(users["contributor"], frozen["draft"])
    with pytest.raises(NotFound):
        result(users["outsider"], frozen["revision_id"])
    assert (
        api(users["outsider"])
        .get(f"/api/v0/cable-test-intent/revisions/{frozen['revision_id']}/package")
        .status_code
        == 404
    )
    assert (
        api()
        .get(f"/api/v0/cable-test-intent/revisions/{frozen['revision_id']}/package")
        .status_code
        == 401
    )


def test_live_actor_refresh_at_all_direct_query_boundaries(users, project, plan):
    owner = users["owner"]
    frozen = freeze(owner, create(owner, project, plan))
    stale = users["viewer"]
    type(stale).objects.filter(pk=stale.pk).update(is_active=False)
    assert stale.is_active
    for query in (
        lambda: result(stale, frozen["revision_id"]),
        lambda: portable_package(stale, frozen["revision_id"]),
        lambda: inspect_target(
            stale,
            InspectTarget(
                **{k: v for k, v in plan.items() if k in {"root_revision_id", "cable_revision_id"}}
            ),
        ),
    ):
        with pytest.raises(Unauthenticated):
            query()


def test_registered_evidence_retains_rights_hash_and_revocation_precedes_diagnostics(
    users, project, plan
):
    owner = users["owner"]
    evidence = source_evidence(users, project, rights="synthetic-test")
    plan["pairs"][0]["evidence"] = evidence
    draft = create(owner, project, plan, idempotency_key="retained")
    frozen = freeze(owner, draft)
    output = result(users["viewer"], frozen["revision_id"])
    source = output["evidence"][0]["evidence"]
    assert source["sha256"] and source["rights"] == "synthetic-test"
    assert source["source_bundle_revision_id"] == evidence["source_bundle_revision_id"]
    # Sources share the workspace boundary: membership loss hides evidence and results.
    remove_member(users["viewer"])
    remove_member(users["editor"])
    invalid = copy.deepcopy(plan)
    invalid["pairs"][0]["first"]["contact_id"] = "missing"
    for query in (
        lambda: result(users["viewer"], frozen["revision_id"]),
        lambda: portable_package(users["viewer"], frozen["revision_id"]),
        lambda: create(users["editor"], project, invalid),
        lambda: get_draft(users["viewer"], draft["draft_id"]),
        lambda: get_revision(users["viewer"], frozen["revision_id"]),
    ):
        with pytest.raises(NotFound):
            query()


def test_retained_key_authority_checked_before_mismatch_even_after_draft_replaced(
    users, project, plan
):
    editor = users["editor"]
    old = copy.deepcopy(plan)
    old["pairs"][0]["evidence"] = source_evidence(users, project)
    draft = create(editor, project, old, idempotency_key="old-reference")
    op(
        editor,
        "cable_test_plan.update",
        {"draft_id": draft["draft_id"], "test_plan": plan},
        expected_state=draft["state"],
    )
    remove_member(editor)
    with pytest.raises(NotFound):
        create(editor, project, plan, idempotency_key="old-reference")


def test_incoming_scope_authority_precedes_wrong_root_occurrence_diagnostics(users, project, plan):
    # A cable from a foreign workspace reads as missing before any occurrence diagnostic.
    other = foreign_cable(users)
    invalid = {**plan, "cable_revision_id": other["revision_id"], "occurrence_path": ["missing"]}
    with pytest.raises(NotFound, match=r"^Not found\.$"):
        create(users["editor"], project, invalid)
    with pytest.raises(NotFound, match=r"^Not found\.$"):
        inspect_target(
            users["viewer"],
            InspectTarget(
                **{
                    k: invalid[k]
                    for k in ("root_revision_id", "cable_revision_id", "occurrence_path")
                }
            ),
        )


def test_full_root_closure_authority_required_even_when_package_omits_unrelated_contents(
    users, project, cable, plan
):
    owner = users["owner"]
    hidden = op(owner, "project.create", {"name": "Temporary sibling scope"})["project_id"]
    ensure_member(users["viewer"], "viewer", project=hidden)
    _, sibling = part(owner, hidden)
    root = freeze_assembly(
        owner, create_assembly(owner, project, [occ("chosen", cable), occ("sibling", sibling)])
    )
    plan.update(root_revision_id=root["revision_id"], occurrence_path=["chosen"])
    frozen = freeze(owner, create(owner, project, plan))
    assert json.loads(portable_package(users["viewer"], frozen["revision_id"])[0])["scope"][
        "occurrence_path"
    ] == ["chosen"]
    WorkspaceMember.objects.filter(workspace__projects=hidden, user=users["viewer"]).delete()
    for read in (
        lambda: result(users["viewer"], frozen["revision_id"]),
        lambda: portable_package(users["viewer"], frozen["revision_id"]),
        lambda: inspect_target(
            users["viewer"],
            InspectTarget(
                root_revision_id=root["revision_id"],
                cable_revision_id=cable["revision_id"],
                occurrence_path=["chosen"],
            ),
        ),
    ):
        with pytest.raises(NotFound):
            read()


@pytest.mark.django_db(transaction=True)
def test_competing_plan_writes_use_independent_compare_and_set(users, project, plan):
    draft = create(users["owner"], project, plan)
    barrier = Barrier(2)

    def change(text):
        close_old_connections()
        value = copy.deepcopy(plan)
        value["labels"][0]["text"] = text
        try:
            barrier.wait(timeout=10)
            return op(
                users["owner"],
                "cable_test_plan.update",
                {"draft_id": draft["draft_id"], "test_plan": value},
                expected_state=draft["state"],
            )["state"]
        except Conflict:
            return "conflict"
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(change, ["Label one", "Label two"]))
    assert sorted(results) == ["conflict", "draft-v2"]
    stored = get_draft(users["owner"], draft["draft_id"])
    assert stored["content"]["test_plan"]["labels"][0]["text"] in {"Label one", "Label two"}


def evidence_derivative(users, project, kind):
    if kind == "derivative":
        ancestor = source_evidence(users, project)
        derived = op(
            users["owner"],
            "source.derive_bundle",
            {
                "source_revision_id": ancestor["source_bundle_revision_id"],
                "name": "Synthetic derived test evidence",
            },
        )
        path = ancestor["source_path"]
        ancestor_id = ancestor["source_bundle_revision_id"]
    elif kind == "archive":
        from .test_source_zip import archive, payload, preserve

        ancestor = preserve(users, project, archive())
        derived = op(users["owner"], "source.expand_zip", payload(ancestor))
        path = "src/board.native"
        ancestor_id = ancestor["revision_id"]
    else:
        from .test_source_editing import edited_zip, original, preview, submit

        baseline = original(users, project)
        uploaded = edited_zip(
            users,
            project,
            baseline["revision_id"],
            lambda entries: entries.update({"board/main.native": b"synthetic edit"}),
        )
        payload = {"baseline_revision_id": baseline["revision_id"], "archive": uploaded}
        review = preview(users["owner"], payload)
        derived = submit(users["owner"], payload, review)
        path = "board/main.native"
        ancestor_id = uploaded["revision_id"]
    return {
        "status": "registered_file",
        "source_bundle_revision_id": derived["revision_id"],
        "source_path": path,
    }, ancestor_id


@pytest.mark.parametrize("kind", ["derivative", "archive", "edit"])
@pytest.mark.parametrize("target_kind", ["pair", "label"])
def test_evidence_source_ancestry_revocation_denies_reads_exports_and_generic_state(
    users, project, plan, kind, target_kind
):
    owner = users["owner"]
    evidence, _ = evidence_derivative(users, project, kind)
    rows = plan["pairs"] if target_kind == "pair" else plan["labels"]
    rows[0]["evidence"] = evidence
    draft = create(owner, project, plan)
    frozen = freeze(owner, draft)
    inspected = result(users["viewer"], frozen["revision_id"])
    resolved = next(row for row in inspected["evidence"] if row["kind"] == target_kind)
    assert (
        resolved["evidence"]["source_bundle_revision_id"] == evidence["source_bundle_revision_id"]
    )
    # Ancestry shares the workspace boundary: membership loss is the remaining revocation.
    remove_member(users["viewer"])
    remove_member(users["editor"])
    for read in (
        lambda: result(users["viewer"], frozen["revision_id"]),
        lambda: portable_package(users["viewer"], frozen["revision_id"]),
        lambda: get_draft(users["viewer"], draft["draft_id"]),
        lambda: get_revision(users["viewer"], frozen["revision_id"]),
    ):
        with pytest.raises(NotFound):
            read()
    client = api(users["viewer"])
    assert (
        client.get(
            f"/api/v0/cable-test-intent/revisions/{frozen['revision_id']}/package"
        ).status_code
        == 404
    )
    invalid = copy.deepcopy(plan)
    invalid["pairs"][0]["first"]["contact_id"] = "missing"
    invalid["labels"][0]["evidence"] = {**evidence, "source_path": "absent.txt"}
    with pytest.raises(NotFound, match=r"^Not found\.$"):
        create(users["editor"], project, invalid)


@pytest.mark.parametrize("kind", ["derivative", "archive", "edit"])
def test_retained_evidence_ancestry_authority_precedes_key_mismatch(users, project, plan, kind):
    editor = users["editor"]
    evidence, _ = evidence_derivative(users, project, kind)
    old = copy.deepcopy(plan)
    old["pairs"][0]["evidence"] = evidence
    draft = create(editor, project, old, idempotency_key="ancestor-key")
    op(
        editor,
        "cable_test_plan.update",
        {"draft_id": draft["draft_id"], "test_plan": plan},
        expected_state=draft["state"],
    )
    remove_member(editor)
    with pytest.raises(NotFound, match=r"^Not found\.$"):
        create(editor, project, plan, idempotency_key="ancestor-key")


def test_scope_and_retained_authority_precede_missing_evidence_path_diagnostics(
    users, project, plan
):
    evidence = source_evidence(users, project)
    missing = copy.deepcopy(plan)
    missing["pairs"][0]["evidence"] = {**evidence, "source_path": "absent.txt"}
    create(users["editor"], project, plan, idempotency_key="authorized-key")
    with pytest.raises(IdempotencyMismatch):
        create(users["editor"], project, missing, idempotency_key="authorized-key")
    cable = foreign_cable(users)
    missing.update(root_revision_id=cable["revision_id"], cable_revision_id=cable["revision_id"])
    with pytest.raises(NotFound, match=r"^Not found\.$"):
        create(users["editor"], project, missing)
