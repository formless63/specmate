import copy
import hashlib
import io
import json
from uuid import UUID

import pytest
from django.test import Client

from specmate.access.models import WorkspaceMember
from specmate.design.models import Definition, Snapshot
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)
from specmate.pcb_disagreement.queries import inspect_revision, projection
from specmate.queries import get_draft
from specmate.sources.models import SourceBundleFile

from .conftest import op, remove_member
from .test_copper import board_population
from .test_pcb import attempt as pcb_attempt  # noqa: F401
from .test_pcb import intake, recipe, source  # noqa: F401


def source_pin(user, workspace, role="schematic"):
    data = f"Preserved unparsed synthetic {role} original.".encode()
    sha = hashlib.sha256(data).hexdigest()
    op(
        user,
        "source.register_blob",
        {"workspace_id": workspace, "sha256": sha, "size": len(data), "media_type": "text/plain"},
        attachments={"content": io.BytesIO(data)},
    )
    result = op(
        user,
        "source.create_original_bundle",
        {
            "workspace_id": workspace,
            "name": f"Synthetic {role}",
            "files": [
                {
                    "path": f"source.{role}",
                    "sha256": sha,
                    "media_type": "text/plain",
                    "rights": "synthetic-test",
                }
            ],
        },
    )
    file = SourceBundleFile.objects.get(revision_id=result["revision_id"])
    return {
        "source_revision_id": result["revision_id"],
        "manifest_sha256": file.revision.manifest_sha256,
        "path": file.path,
        "sha256": sha,
        "rights": file.rights,
    }


def assertion(pin, names=("left", "left", "right"), coverage="partial"):
    return {
        "kind": "pcb_assertion",
        "source": pin,
        "source_role": "schematic",
        "coverage": coverage,
        "coverage_basis": "Explicit synthetic review subset",
        "terminals": [
            {
                "local_id": name,
                "component_ref": "J1",
                "pin": str(i + 1),
                "net_state": "assigned" if net is not None else "unknown",
                "net_name": net,
                "basis": "Human terminal table",
            }
            for i, (name, net) in enumerate(zip(("first", "second", "third"), names, strict=True))
        ],
    }


def create(user, workspace, value, **ctx):
    return op(
        user,
        "pcb_disagreement.create",
        {"workspace_id": workspace, "name": "Synthetic source review", "value": value},
        **ctx,
    )


def freeze(user, draft, **ctx):
    return op(
        user,
        "pcb_disagreement.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
        **ctx,
    )


def update(user, draft, value, **ctx):
    return op(
        user,
        "pcb_disagreement.update",
        {"draft_id": draft["draft_id"], "value": value},
        expected_state=draft["state"],
        **ctx,
    )


def pin(revision):
    snapshot = Snapshot.objects.get(id=revision["snapshot_id"])
    return {
        "kind": "assertion_revision",
        "revision_id": revision["revision_id"],
        "snapshot_sha256": snapshot.sha256,
    }


def compare_value(left, right):
    return {
        "kind": "pcb_comparison",
        "left": pin(left),
        "right": pin(right),
        "correspondences": [
            {
                "local_id": name,
                "left_terminal_id": name,
                "right_terminal_id": name,
                "basis": "Explicit independent correspondence",
            }
            for name in ("first", "second", "third")
        ],
    }


def pair(users, workspace, names=("left", "right", "right")):
    owner = users["owner"]
    left_source = source_pin(owner, workspace)
    right_source = source_pin(owner, workspace, "netlist")
    left = freeze(owner, create(owner, workspace, assertion(left_source)))
    right_value = assertion(right_source, names)
    right_value["source_role"] = "netlist"
    right = freeze(owner, create(owner, workspace, right_value))
    return left, right, compare_value(left, right)


def review_projection(user, draft):
    from specmate.design.models import Draft

    record = Draft.objects.select_related("definition").get(id=draft["draft_id"])
    return projection(user, record.definition, record.content)


def test_inconsistent_net_is_reviewable_without_selecting_or_mutating_source(users, workspace):
    owner = users["owner"]
    left, right, value = pair(users, workspace)
    originals = {
        rid: bytes(Snapshot.objects.get(id=rid).canonical)
        for rid in (left["snapshot_id"], right["snapshot_id"])
    }
    draft = create(owner, workspace, value)
    report = review_projection(owner, draft)
    assert {f["kind"] for f in report["findings"]} == {
        "net_name_difference",
        "net_membership_difference",
    }
    assert all(f["review"] is None for f in report["findings"])
    assert report["inputs"]["left"]["method"] == "human_assertion"
    assert report["inputs"]["right"]["source_role"] == "netlist"
    assert report["parity"] == "not_evaluated"
    finding = report["findings"][0]
    reviewed = copy.deepcopy(value)
    reviewed["reviews"] = [
        {
            "finding_id": finding["finding_id"],
            "status": "requires_source_correction",
            "basis": "Review original net assignment",
        }
    ]
    saved = update(owner, draft, reviewed)
    frozen = freeze(owner, saved)
    old = inspect_revision(owner, frozen["revision_id"])
    assert (
        next(f for f in old["projection"]["findings"] if f["finding_id"] == finding["finding_id"])[
            "review"
        ]["status"]
        == "requires_source_correction"
    )
    assert old["projection"]["comparison_status"] == "findings_present"
    assert all(
        bytes(Snapshot.objects.get(id=rid).canonical) == data for rid, data in originals.items()
    )
    assert set(
        Snapshot.objects.get(id=frozen["snapshot_id"]).dependencies.values_list(
            "revision_id", flat=True
        )
    ) == {UUID(left["revision_id"]), UUID(right["revision_id"])}


def test_net_rename_is_distinct_from_membership_change(users, workspace):
    *_, value = pair(users, workspace, ("renamed", "renamed", "other"))
    report = review_projection(users["owner"], create(users["owner"], workspace, value))
    assert {f["kind"] for f in report["findings"]} == {"net_name_difference"}


def test_unknown_assignment_does_not_become_unconnected_or_agreement(users, workspace):
    *_, value = pair(users, workspace, (None, "left", "right"))
    report = review_projection(users["owner"], create(users["owner"], workspace, value))
    assert {f["kind"] for f in report["findings"]} == {"unknown_net_assignment"}


@pytest.mark.parametrize(
    "coverage,expected",
    [("partial", "unknown_missing_coverage"), ("declared_complete", "declared_missing_terminal")],
)
def test_declared_missing_counterpart_respects_source_coverage(
    users, workspace, coverage, expected
):
    owner = users["owner"]
    _left, _, value = pair(users, workspace)
    right = freeze(
        owner,
        create(
            owner, workspace, assertion(source_pin(owner, workspace, "another"), coverage=coverage)
        ),
    )
    value["right"] = pin(right)
    value["correspondences"][0]["right_terminal_id"] = None
    report = review_projection(owner, create(owner, workspace, value))
    assert expected in {f["kind"] for f in report["findings"]}
    assert "unmapped_terminal" in {f["kind"] for f in report["findings"]}


def test_duplicate_labels_remain_separate_and_never_automatically_matched(users, workspace):
    owner = users["owner"]
    data = assertion(source_pin(owner, workspace))
    for terminal in data["terminals"]:
        terminal["component_ref"] = "same"
        terminal["pin"] = "1"
    left = freeze(owner, create(owner, workspace, data))
    data["source"] = source_pin(owner, workspace, "netlist")
    right = freeze(owner, create(owner, workspace, data))
    value = compare_value(left, right)
    value["correspondences"] = []
    report = review_projection(owner, create(owner, workspace, value))
    assert len(report["findings"]) == 6
    assert {f["kind"] for f in report["findings"]} == {"unmapped_terminal"}


@pytest.mark.parametrize(
    "mutate",
    [
        lambda v: v["correspondences"][1].update(left_terminal_id="first"),
        lambda v: v["correspondences"][0].update(right_terminal_id="absent"),
        lambda v: v["left"].update(snapshot_sha256="0" * 64),
        lambda v: v.update(
            reviews=[
                {"finding_id": "finding-" + "0" * 64, "status": "acknowledged", "basis": "Stale"}
            ]
        ),
    ],
)
def test_invalid_correspondence_hash_or_stale_review_rolls_back(users, workspace, mutate):
    *_, value = pair(users, workspace)
    mutate(value)
    before = Definition.objects.count()
    with pytest.raises(ValidationFailed):
        create(users["owner"], workspace, value)
    assert Definition.objects.count() == before


def test_cas_idempotency_old_revision_and_current_source_authority(users, workspace):
    editor = users["editor"]
    WorkspaceMember.objects.filter(user=editor, workspace_id=workspace).update(
        grants=["design.freeze"]
    )
    *_, value = pair(users, workspace)
    draft = create(editor, workspace, value, idempotency_key="compare-create")
    assert create(editor, workspace, value, idempotency_key="compare-create") == draft
    with pytest.raises(IdempotencyMismatch):
        create(
            editor, workspace, {**value, "correspondences": []}, idempotency_key="compare-create"
        )
    frozen = freeze(editor, draft, idempotency_key="compare-freeze")
    assert freeze(editor, draft, idempotency_key="compare-freeze") == frozen
    with pytest.raises(Conflict):
        update(editor, draft, value)
    assert inspect_revision(editor, frozen["revision_id"])["projection"]["findings"]
    remove_member(editor)
    for action in (
        lambda: create(editor, workspace, value, idempotency_key="compare-create"),
        lambda: freeze(editor, draft, idempotency_key="compare-freeze"),
        lambda: inspect_revision(editor, frozen["revision_id"]),
        lambda: get_draft(editor, draft["draft_id"]),
        lambda: update(editor, draft, value),
    ):
        with pytest.raises(NotFound):
            action()


def test_non_member_denied_before_mismatched_hash_diagnostic(users, workspace):
    editor = users["editor"]
    *_, value = pair(users, workspace)
    value["left"]["snapshot_sha256"] = "0" * 64
    with pytest.raises(ValidationFailed):
        create(editor, workspace, value)
    remove_member(editor)
    with pytest.raises(NotFound):
        create(editor, workspace, value)


def test_replay_rechecks_membership_after_draft_retargets(users, workspace):
    editor = users["editor"]
    *_, old = pair(users, workspace)
    draft = create(editor, workspace, old, idempotency_key="old-compare")
    *_, current = pair(users, workspace)
    updated = update(editor, draft, current)
    assert (
        get_draft(editor, updated["draft_id"])["content"]["pcb_comparison"]["left"]
        == current["left"]
    )
    assert create(editor, workspace, old, idempotency_key="old-compare") == draft
    remove_member(editor)
    with pytest.raises(NotFound):
        create(editor, workspace, old, idempotency_key="old-compare")


@pytest.mark.parametrize("operation", ["create", "update", "freeze"])
def test_changed_review_payload_authorizes_retained_content_before_mismatch(
    users, workspace, operation
):
    owner, editor = users["owner"], users["editor"]
    WorkspaceMember.objects.filter(user=editor, workspace_id=workspace).update(
        grants=["design.freeze"]
    )
    old_source = source_pin(owner, workspace)
    old_value = assertion(old_source)
    current_value = assertion(source_pin(owner, workspace, role="netlist"))
    key = "retained-review"
    draft = create(
        editor, workspace, old_value, **({"idempotency_key": key} if operation == "create" else {})
    )
    if operation == "update":
        draft = update(editor, draft, old_value, idempotency_key=key)
    elif operation == "freeze":
        draft = freeze(editor, draft, idempotency_key=key)["draft"]
    current = update(editor, draft, current_value)

    def changed():
        if operation == "create":
            return create(editor, workspace, current_value, idempotency_key=key)
        if operation == "update":
            return update(editor, current, current_value, idempotency_key=key)
        return freeze(editor, current, idempotency_key=key)

    with pytest.raises(IdempotencyMismatch):
        changed()
    assert (
        get_draft(editor, current["draft_id"])["content"]["pcb_assertion"]["source"]
        == (current_value["source"])
    )
    remove_member(editor)
    with pytest.raises(NotFound):
        changed()


def test_api_generic_contract_and_read_permissions(users, workspace):
    owner = users["owner"]
    *_, value = pair(users, workspace)
    draft = op(
        owner,
        "definition.create",
        {
            "workspace_id": workspace,
            "kind": "pcb_comparison",
            "name": "Generic comparison",
            "content": {"pcb_comparison": value},
        },
    )
    frozen = op(
        owner, "draft.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"]
    )
    client = Client()
    client.force_login(users["viewer"])
    assert client.get(f"/api/v0/pcb-disagreement/drafts/{draft['draft_id']}").status_code == 200
    assert client.get(f"/api/v0/pcb-disagreement/revisions/{frozen['revision_id']}").json()[
        "projection"
    ]["findings"]
    response = client.post(
        "/api/v0/operations",
        data=json.dumps(
            {
                "operation": "pcb_disagreement.read",
                "request_id": "source-review",
                "payload": {"revision_id": frozen["revision_id"]},
            }
        ),
        content_type="application/json",
    )
    assert response.status_code == 200
    with pytest.raises(PermissionDenied):
        create(users["viewer"], workspace, value)
    client.force_login(users["outsider"])
    assert (
        client.get(f"/api/v0/pcb-disagreement/revisions/{frozen['revision_id']}").status_code == 404
    )
    with pytest.raises(ValidationFailed):
        op(
            owner,
            "definition.create",
            {
                "workspace_id": workspace,
                "kind": "board",
                "name": "Wrong owner",
                "content": {"pcb_comparison": value},
            },
        )


def test_accepted_board_extraction_compares_independent_manual_netlist_and_preserves_report(
    users, workspace, request
):
    owner = users["owner"]
    population, native = board_population(users, request.getfixturevalue("pcb_attempt"))
    content = population["content"]["pcb_population"]
    from specmate.pcb.models import PcbInterpretation

    interpretation = PcbInterpretation.objects.select_related(
        "attempt__intake__source_revision"
    ).get(id=content["interpretation_id"])
    file = SourceBundleFile.objects.get(
        revision_id=content["source_revision_id"], path=interpretation.attempt.intake.board_path
    )
    board_source = {
        "source_revision_id": str(file.revision_id),
        "manifest_sha256": file.revision.manifest_sha256,
        "path": file.path,
        "sha256": file.blob.sha256,
        "rights": file.rights,
    }
    right = freeze(
        owner, create(owner, workspace, assertion(source_pin(owner, workspace, "netlist")))
    )
    value = {
        "kind": "pcb_comparison",
        "left": {
            "kind": "pcb_interpretation",
            "interpretation_id": str(interpretation.id),
            "report_sha256": interpretation.sha256,
            "source": board_source,
        },
        "right": pin(right),
        "correspondences": [
            {
                "local_id": name,
                "left_terminal_id": native["pads"][i]["id"],
                "right_terminal_id": name,
                "basis": "Explicit native UUID correspondence",
            }
            for i, name in enumerate(("first", "second", "third"))
        ],
    }
    before = bytes(interpretation.canonical)
    comparison = freeze(owner, create(owner, workspace, value))
    result = inspect_revision(owner, comparison["revision_id"])["projection"]
    assert result["inputs"]["left"]["method"] == "accepted_board_extraction"
    assert result["inputs"]["left"]["extractor"]["tool_version"] == "10.0.6"
    assert result["inputs"]["left"]["extractor"]["report_sha256"] == interpretation.sha256
    assert "net_membership_difference" in {f["kind"] for f in result["findings"]}
    interpretation.refresh_from_db()
    assert bytes(interpretation.canonical) == before
    assert result["parity"] == "not_evaluated"


def test_changed_correspondence_cannot_silently_reuse_review_decision(users, workspace):
    owner = users["owner"]
    *_, value = pair(users, workspace)
    draft = create(owner, workspace, value)
    finding = review_projection(owner, draft)["findings"][0]
    reviewed = copy.deepcopy(value)
    reviewed["reviews"] = [
        {"finding_id": finding["finding_id"], "status": "acknowledged", "basis": "First review"}
    ]
    saved = update(owner, draft, reviewed)
    frozen = freeze(owner, saved)
    changed = copy.deepcopy(reviewed)
    changed["correspondences"][0]["basis"] = "Different matching evidence"
    with pytest.raises(ValidationFailed, match="stale or absent"):
        update(owner, frozen["draft"], changed)
    assert inspect_revision(owner, frozen["revision_id"])["projection"]["findings"]


def test_source_file_picker_is_current_scoped_metadata_without_parsing_originals(users, workspace):
    owner = users["owner"]
    selected = source_pin(owner, workspace)
    client = Client()
    client.force_login(users["viewer"])
    path = f"/api/v0/pcb-disagreement/sources/{selected['source_revision_id']}"
    result = client.get(path)
    assert result.status_code == 200
    assert result.json()["files"] == [selected]
    assert result.json()["coverage"] == "preserved_unparsed"
    client.force_login(users["outsider"])
    assert client.get(path).status_code == 404


def test_membership_precedes_file_presence_and_pin_diagnostics(users, workspace):
    owner, editor = users["owner"], users["editor"]
    pin = source_pin(owner, workspace)
    remove_member(editor)
    client = Client()
    client.force_login(editor)
    errors = []
    responses = []
    for path in (pin["path"], "absent-original.kicad_sch"):
        value = assertion({**pin, "path": path, "sha256": "0" * 64, "rights": "wrong"})
        with pytest.raises(NotFound) as denied:
            create(editor, workspace, value)
        errors.append(str(denied.value))
        response = client.post(
            "/api/v0/operations",
            data=json.dumps(
                {
                    "operation": "pcb_disagreement.create",
                    "request_id": "hidden-file",
                    "payload": {"workspace_id": str(workspace), "name": "Hidden", "value": value},
                    "idempotency_key": "hidden-" + path,
                }
            ),
            content_type="application/json",
        )
        responses.append((response.status_code, response.json()))
    assert errors == ["Not found.", "Not found."]
    assert responses[0] == responses[1]
    assert responses[0][0] == 404


def test_split_net_finding_detail_bound_rolls_back_after_membership_check(users, workspace):
    owner, editor = users["owner"], users["editor"]
    left = assertion(source_pin(owner, workspace))
    right = assertion(source_pin(owner, workspace, "netlist"))
    left["terminals"] = [
        {**left["terminals"][0], "local_id": f"pin-{i}", "pin": str(i)} for i in range(120)
    ]
    right["terminals"] = [
        {**terminal, "net_name": f"separate-{i}"} for i, terminal in enumerate(left["terminals"])
    ]
    a = freeze(owner, create(owner, workspace, left))
    b = freeze(owner, create(owner, workspace, right))
    value = {
        "kind": "pcb_comparison",
        "left": pin(a),
        "right": pin(b),
        "correspondences": [
            {
                "local_id": f"pair-{i}",
                "left_terminal_id": f"pin-{i}",
                "right_terminal_id": f"pin-{i}",
                "basis": "Explicit independent split-net oracle",
            }
            for i in range(120)
        ],
    }
    before = Definition.objects.count()
    with pytest.raises(ValidationFailed, match="20000 finding-detail reference bound"):
        create(editor, workspace, value)
    assert Definition.objects.count() == before
    remove_member(editor)
    with pytest.raises(NotFound, match="Not found"):
        create(editor, workspace, value)
    assert Definition.objects.count() == before
