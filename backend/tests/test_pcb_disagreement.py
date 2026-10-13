import copy
import hashlib
import io
import json
from uuid import UUID

import pytest
from django.test import Client

from specmate.access.models import Membership
from specmate.design.models import Definition, Snapshot
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)
from specmate.operations.models import IdempotencyRecord
from specmate.pcb_disagreement.queries import inspect_revision, projection
from specmate.queries import get_draft
from specmate.sources.models import SourceBundle, SourceBundleFile

from .conftest import op
from .test_copper import board_population
from .test_pcb import attempt as pcb_attempt  # noqa: F401
from .test_pcb import intake, recipe, source  # noqa: F401


def source_pin(user, project, role="schematic"):
    data = f"Preserved unparsed synthetic {role} original.".encode()
    sha = hashlib.sha256(data).hexdigest()
    op(
        user,
        "source.register_blob",
        {"project_id": project, "sha256": sha, "size": len(data), "media_type": "text/plain"},
        attachments={"content": io.BytesIO(data)},
    )
    result = op(
        user,
        "source.create_original_bundle",
        {
            "project_id": project,
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


def create(user, project, value, **ctx):
    return op(
        user,
        "pcb_disagreement.create",
        {"project_id": project, "name": "Synthetic source review", "value": value},
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


def pair(users, project, names=("left", "right", "right")):
    owner = users["owner"]
    left_source = source_pin(owner, project)
    right_source = source_pin(owner, project, "netlist")
    left = freeze(owner, create(owner, project, assertion(left_source)))
    right_value = assertion(right_source, names)
    right_value["source_role"] = "netlist"
    right = freeze(owner, create(owner, project, right_value))
    return left, right, compare_value(left, right)


def review_projection(user, draft):
    from specmate.design.models import Draft

    record = Draft.objects.select_related("definition").get(id=draft["draft_id"])
    return projection(user, record.definition, record.content)


def test_inconsistent_net_is_reviewable_without_selecting_or_mutating_source(users, project):
    owner = users["owner"]
    left, right, value = pair(users, project)
    originals = {
        rid: bytes(Snapshot.objects.get(id=rid).canonical)
        for rid in (left["snapshot_id"], right["snapshot_id"])
    }
    draft = create(owner, project, value)
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


def test_net_rename_is_distinct_from_membership_change(users, project):
    *_, value = pair(users, project, ("renamed", "renamed", "other"))
    report = review_projection(users["owner"], create(users["owner"], project, value))
    assert {f["kind"] for f in report["findings"]} == {"net_name_difference"}


def test_unknown_assignment_does_not_become_unconnected_or_agreement(users, project):
    *_, value = pair(users, project, (None, "left", "right"))
    report = review_projection(users["owner"], create(users["owner"], project, value))
    assert {f["kind"] for f in report["findings"]} == {"unknown_net_assignment"}


@pytest.mark.parametrize(
    "coverage,expected",
    [("partial", "unknown_missing_coverage"), ("declared_complete", "declared_missing_terminal")],
)
def test_declared_missing_counterpart_respects_source_coverage(users, project, coverage, expected):
    owner = users["owner"]
    _left, _, value = pair(users, project)
    right = freeze(
        owner,
        create(owner, project, assertion(source_pin(owner, project, "another"), coverage=coverage)),
    )
    value["right"] = pin(right)
    value["correspondences"][0]["right_terminal_id"] = None
    report = review_projection(owner, create(owner, project, value))
    assert expected in {f["kind"] for f in report["findings"]}
    assert "unmapped_terminal" in {f["kind"] for f in report["findings"]}


def test_duplicate_labels_remain_separate_and_never_automatically_matched(users, project):
    owner = users["owner"]
    data = assertion(source_pin(owner, project))
    for terminal in data["terminals"]:
        terminal["component_ref"] = "same"
        terminal["pin"] = "1"
    left = freeze(owner, create(owner, project, data))
    data["source"] = source_pin(owner, project, "netlist")
    right = freeze(owner, create(owner, project, data))
    value = compare_value(left, right)
    value["correspondences"] = []
    report = review_projection(owner, create(owner, project, value))
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
def test_invalid_correspondence_hash_or_stale_review_rolls_back(users, project, mutate):
    *_, value = pair(users, project)
    mutate(value)
    before = Definition.objects.count()
    with pytest.raises(ValidationFailed):
        create(users["owner"], project, value)
    assert Definition.objects.count() == before


def test_cas_idempotency_old_revision_and_current_source_authority(users, project):
    owner, editor = users["owner"], users["editor"]
    Membership.objects.filter(user=editor, project_id=project).update(grants=["design.freeze"])
    left, _right, value = pair(users, project)
    draft = create(editor, project, value, idempotency_key="compare-create")
    assert create(editor, project, value, idempotency_key="compare-create") == draft
    with pytest.raises(IdempotencyMismatch):
        create(editor, project, {**value, "correspondences": []}, idempotency_key="compare-create")
    frozen = freeze(editor, draft, idempotency_key="compare-freeze")
    assert freeze(editor, draft, idempotency_key="compare-freeze") == frozen
    with pytest.raises(Conflict):
        update(editor, draft, value)
    assert inspect_revision(editor, frozen["revision_id"])["projection"]["findings"]
    source_id = inspect_revision(owner, left["revision_id"])["projection"]["assertion"]["source"][
        "source_revision_id"
    ]
    hidden = op(owner, "project.create", {"name": "Restricted original"})["project_id"]
    SourceBundle.objects.filter(revisions__id=source_id).update(project_id=hidden)
    for action in (
        lambda: create(editor, project, value, idempotency_key="compare-create"),
        lambda: freeze(editor, draft, idempotency_key="compare-freeze"),
        lambda: inspect_revision(editor, frozen["revision_id"]),
        lambda: get_draft(editor, draft["draft_id"]),
        lambda: update(editor, draft, value),
    ):
        with pytest.raises(NotFound):
            action()


def test_later_hidden_input_denied_before_earlier_mismatched_hash_diagnostic(users, project):
    owner, editor = users["owner"], users["editor"]
    _left, right, value = pair(users, project)
    source_id = inspect_revision(owner, right["revision_id"])["projection"]["assertion"]["source"][
        "source_revision_id"
    ]
    hidden = op(owner, "project.create", {"name": "Restricted right input"})["project_id"]
    SourceBundle.objects.filter(revisions__id=source_id).update(project_id=hidden)
    value["left"]["snapshot_sha256"] = "0" * 64
    with pytest.raises(NotFound):
        create(editor, project, value)


def test_replay_retains_old_source_authority_after_draft_retargets(users, project):
    owner, editor = users["owner"], users["editor"]
    left, _, old = pair(users, project)
    draft = create(editor, project, old, idempotency_key="old-compare")
    *_, current = pair(users, project)
    updated = update(editor, draft, current)
    old_source = inspect_revision(owner, left["revision_id"])["projection"]["assertion"]["source"][
        "source_revision_id"
    ]
    hidden = op(owner, "project.create", {"name": "Old source becomes private"})["project_id"]
    SourceBundle.objects.filter(revisions__id=old_source).update(project_id=hidden)
    assert (
        get_draft(editor, updated["draft_id"])["content"]["pcb_comparison"]["left"]
        == current["left"]
    )
    with pytest.raises(NotFound):
        create(editor, project, old, idempotency_key="old-compare")


@pytest.mark.parametrize("operation", ["create", "update", "freeze"])
@pytest.mark.parametrize("legacy", [False, True])
def test_changed_review_payload_authorizes_retained_content_before_mismatch(
    users, project, operation, legacy
):
    owner, editor = users["owner"], users["editor"]
    Membership.objects.filter(user=editor, project_id=project).update(grants=["design.freeze"])
    old_source = source_pin(owner, project)
    old_value = assertion(old_source)
    current_value = assertion(source_pin(owner, project, role="netlist"))
    key = "retained-review"
    draft = create(
        editor, project, old_value, **({"idempotency_key": key} if operation == "create" else {})
    )
    if operation == "update":
        draft = update(editor, draft, old_value, idempotency_key=key)
    elif operation == "freeze":
        draft = freeze(editor, draft, idempotency_key=key)["draft"]
    current = update(editor, draft, current_value)
    name = "pcb_disagreement." + operation
    if legacy:
        IdempotencyRecord.objects.filter(actor=editor, operation=name, key=key).update(
            scope="legacy"
        )

    def changed():
        if operation == "create":
            return create(editor, project, current_value, idempotency_key=key)
        if operation == "update":
            return update(editor, current, current_value, idempotency_key=key)
        return freeze(editor, current, idempotency_key=key)

    with pytest.raises(Conflict if legacy else IdempotencyMismatch):
        changed()
    hidden = op(owner, "project.create", {"name": "Revoked retained review origin"})["project_id"]
    SourceBundle.objects.filter(revisions__id=old_source["source_revision_id"]).update(
        project_id=hidden
    )
    assert (
        get_draft(editor, current["draft_id"])["content"]["pcb_assertion"]["source"]
        == (current_value["source"])
    )
    with pytest.raises(NotFound):
        changed()


def test_api_generic_contract_and_read_permissions(users, project):
    owner = users["owner"]
    *_, value = pair(users, project)
    draft = op(
        owner,
        "definition.create",
        {
            "project_id": project,
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
        create(users["viewer"], project, value)
    client.force_login(users["outsider"])
    assert (
        client.get(f"/api/v0/pcb-disagreement/revisions/{frozen['revision_id']}").status_code == 404
    )
    with pytest.raises(ValidationFailed):
        op(
            owner,
            "definition.create",
            {
                "project_id": project,
                "kind": "board",
                "name": "Wrong owner",
                "content": {"pcb_comparison": value},
            },
        )


def test_accepted_board_extraction_compares_independent_manual_netlist_and_preserves_report(
    users, project, request
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
    right = freeze(owner, create(owner, project, assertion(source_pin(owner, project, "netlist"))))
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
    comparison = freeze(owner, create(owner, project, value))
    result = inspect_revision(owner, comparison["revision_id"])["projection"]
    assert result["inputs"]["left"]["method"] == "accepted_board_extraction"
    assert result["inputs"]["left"]["extractor"]["tool_version"] == "10.0.6"
    assert result["inputs"]["left"]["extractor"]["report_sha256"] == interpretation.sha256
    assert "net_membership_difference" in {f["kind"] for f in result["findings"]}
    interpretation.refresh_from_db()
    assert bytes(interpretation.canonical) == before
    assert result["parity"] == "not_evaluated"


def test_changed_correspondence_cannot_silently_reuse_review_decision(users, project):
    owner = users["owner"]
    *_, value = pair(users, project)
    draft = create(owner, project, value)
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


def test_source_file_picker_is_current_scoped_metadata_without_parsing_originals(users, project):
    owner = users["owner"]
    selected = source_pin(owner, project)
    client = Client()
    client.force_login(users["viewer"])
    path = f"/api/v0/pcb-disagreement/sources/{selected['source_revision_id']}"
    result = client.get(path)
    assert result.status_code == 200
    assert result.json()["files"] == [selected]
    assert result.json()["coverage"] == "preserved_unparsed"
    client.force_login(users["outsider"])
    assert client.get(path).status_code == 404


def test_hidden_bundle_authority_precedes_file_presence_and_pin_diagnostics(users, project):
    owner, editor = users["owner"], users["editor"]
    pin = source_pin(owner, project)
    hidden = op(owner, "project.create", {"name": "Hidden original owner"})["project_id"]
    SourceBundle.objects.filter(revisions__id=pin["source_revision_id"]).update(project_id=hidden)
    client = Client()
    client.force_login(editor)
    errors = []
    responses = []
    for path in (pin["path"], "absent-original.kicad_sch"):
        value = assertion({**pin, "path": path, "sha256": "0" * 64, "rights": "wrong"})
        with pytest.raises(NotFound) as denied:
            create(editor, project, value)
        errors.append(str(denied.value))
        response = client.post(
            "/api/v0/operations",
            data=json.dumps(
                {
                    "operation": "pcb_disagreement.create",
                    "request_id": "hidden-file",
                    "payload": {"project_id": str(project), "name": "Hidden", "value": value},
                    "idempotency_key": "hidden-" + path,
                }
            ),
            content_type="application/json",
        )
        responses.append((response.status_code, response.json()))
    assert errors == ["Project not found.", "Project not found."]
    assert responses[0] == responses[1]
    assert responses[0][0] == 404


def test_split_net_finding_detail_bound_rolls_back_after_current_source_authority(users, project):
    owner, editor = users["owner"], users["editor"]
    left = assertion(source_pin(owner, project))
    right = assertion(source_pin(owner, project, "netlist"))
    left["terminals"] = [
        {**left["terminals"][0], "local_id": f"pin-{i}", "pin": str(i)} for i in range(120)
    ]
    right["terminals"] = [
        {**terminal, "net_name": f"separate-{i}"} for i, terminal in enumerate(left["terminals"])
    ]
    a = freeze(owner, create(owner, project, left))
    b = freeze(owner, create(owner, project, right))
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
        create(editor, project, value)
    assert Definition.objects.count() == before
    hidden = op(owner, "project.create", {"name": "Hidden bounded source"})["project_id"]
    SourceBundle.objects.filter(revisions__id=right["source"]["source_revision_id"]).update(
        project_id=hidden
    )
    with pytest.raises(NotFound, match="Project not found"):
        create(editor, project, value)
    assert Definition.objects.count() == before
