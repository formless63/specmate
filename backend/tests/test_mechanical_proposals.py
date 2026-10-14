"""Shared operation, authority, concurrency and persistence tests for parametric proposals.

Board extraction is simulated as in the other PCB tests: the runner's successful output is
inserted and accepted through the shared operations. Real native extraction is a separate
checkpoint.
"""

import json
from uuid import UUID, uuid4

import pytest
from django.db import DatabaseError, transaction
from django.test import Client

from specmate.access.models import WorkspaceMember
from specmate.mechanical_proposals.models import ProposalDraft, ProposalRevision
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)

from .conftest import op
from .test_mechanical_proposal_generators import FULL, HOLES, J1, board_report
from .test_pcb import BOARD, digest, recipe, source, successful_output  # noqa: F401


@pytest.fixture
def board(users, workspace, source, recipe):  # noqa: F811
    intake = op(
        users["editor"],
        "pcb.register_intake",
        {
            "workspace_id": workspace,
            "source_revision_id": source["revision_id"],
            "board_path": "board.kicad_pcb",
        },
    )
    attempt = op(
        users["owner"],
        "pcb.request_extraction",
        {"intake_id": intake["intake_id"], "recipe_id": recipe["id"]},
        idempotency_key="proposal-extract",
    )
    report = json.loads(board_report().model_dump_json())
    report["source_sha256"] = digest(BOARD)
    successful_output(attempt, report)
    return op(users["editor"], "pcb.accept_extraction", {"attempt_id": attempt["attempt_id"]})


def create(user, workspace, board, parameters=None, name="Enclosure proposal", **ctx):
    return op(
        user,
        "mechanical_proposal.create",
        {
            "workspace_id": workspace,
            "interpretation_id": board["interpretation_id"],
            "name": name,
            "parameters": parameters or {},
        },
        **ctx,
    )


def update(user, draft, parameters, **ctx):
    ctx.setdefault("expected_state", draft["state"])
    return op(
        user,
        "mechanical_proposal.update",
        {"draft_id": draft["draft_id"], "parameters": parameters},
        **ctx,
    )


def test_create_read_update_retain_flow_never_touches_design_state(users, workspace, board):
    from specmate.design.models import Definition, Draft, Revision, Snapshot

    before = (
        Definition.objects.count(),
        Draft.objects.count(),
        Revision.objects.count(),
        Snapshot.objects.count(),
    )
    editor = users["editor"]
    draft = create(editor, workspace, board)
    assert draft["state"] == "proposal-v1"
    assert draft["proposal"]["status"] == "incomplete"
    assert draft["proposal"]["board"]["interpretation_sha256"] == board["sha256"]
    updated = update(editor, draft, FULL)
    assert updated["state"] == "proposal-v2"
    assert updated["proposal"]["status"] == "declared_inputs_complete"
    read = op(users["viewer"], "mechanical_proposal.read", {"draft_id": draft["draft_id"]})
    assert read["proposal"] == updated["proposal"]
    retained = op(
        editor,
        "mechanical_proposal.retain",
        {"draft_id": draft["draft_id"]},
        expected_state=updated["state"],
        idempotency_key="retain-1",
    )
    assert retained["number"] == 1 and retained["status"] == "declared_inputs_complete"
    exact = op(
        users["viewer"],
        "mechanical_proposal.read_retained",
        {"revision_id": retained["revision_id"], "workspace_id": workspace},
    )
    assert exact["document"]["proposal"] == updated["proposal"]
    assert exact["document"]["draft_version"] == 2
    assert (
        Definition.objects.count(),
        Draft.objects.count(),
        Revision.objects.count(),
        Snapshot.objects.count(),
    ) == before


def test_incomplete_proposal_can_be_retained_without_becoming_complete(users, workspace, board):
    draft = create(users["editor"], workspace, board)
    retained = op(
        users["editor"],
        "mechanical_proposal.retain",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )
    assert retained["status"] == "incomplete"
    document = op(
        users["owner"],
        "mechanical_proposal.read_retained",
        {"revision_id": retained["revision_id"]},
    )["document"]["proposal"]
    assert document["unresolved"] and document["qualification"]["physical"] is False


def test_retained_revisions_are_content_addressed_and_numbered(users, workspace, board):
    editor = users["editor"]
    draft = create(editor, workspace, board)
    first = op(
        editor,
        "mechanical_proposal.retain",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )
    again = op(
        editor,
        "mechanical_proposal.retain",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )
    assert again["revision_id"] == first["revision_id"]
    changed = update(editor, draft, FULL)
    second = op(
        editor,
        "mechanical_proposal.retain",
        {"draft_id": draft["draft_id"]},
        expected_state=changed["state"],
    )
    assert second["number"] == 2 and second["sha256"] != first["sha256"]
    assert ProposalRevision.objects.filter(draft_id=draft["draft_id"]).count() == 2
    # Earlier retained bytes are unaffected by later edits.
    old = op(editor, "mechanical_proposal.read_retained", {"revision_id": first["revision_id"]})
    assert old["document"]["draft_version"] == 1


def test_permissions_and_cross_workspace_scope(users, workspace, other_workspace, board):
    draft = create(users["editor"], workspace, board)
    with pytest.raises(PermissionDenied):
        create(users["viewer"], workspace, board)
    with pytest.raises(PermissionDenied):
        update(users["viewer"], draft, FULL)
    with pytest.raises(PermissionDenied):
        op(
            users["viewer"],
            "mechanical_proposal.retain",
            {"draft_id": draft["draft_id"]},
            expected_state=draft["state"],
        )
    for user_op, payload in (
        ("mechanical_proposal.read", {"draft_id": draft["draft_id"]}),
        ("mechanical_proposal.list", {"workspace_id": workspace}),
        ("mechanical_proposal.board_choices", {"workspace_id": workspace}),
    ):
        with pytest.raises(NotFound):
            op(users["outsider"], user_op, payload)
    with pytest.raises(NotFound):
        create(users["outsider"], workspace, board)
    with pytest.raises(NotFound):
        # The outsider's own workspace does not contain the board.
        create(users["outsider"], other_workspace, board)
    with pytest.raises(NotFound):
        op(
            users["outsider"],
            "mechanical_proposal.read_retained",
            {"revision_id": str(uuid4())},
        )


def test_stale_expected_state_conflicts_and_changes_nothing(users, workspace, board):
    editor = users["editor"]
    draft = create(editor, workspace, board)
    update(editor, draft, FULL)
    with pytest.raises(Conflict) as stale:
        update(editor, draft, {})
    assert stale.value.details["current_state"] == "proposal-v2"
    with pytest.raises(Conflict):
        op(
            editor,
            "mechanical_proposal.retain",
            {"draft_id": draft["draft_id"]},
            expected_state=draft["state"],
        )
    assert ProposalDraft.objects.get(id=draft["draft_id"]).parameters["shell"]["wall_mm"] == 2
    assert not ProposalRevision.objects.exists()
    with pytest.raises(ValidationFailed):
        op(editor, "mechanical_proposal.update", {"draft_id": draft["draft_id"], "parameters": {}})


def test_idempotent_replay_mismatch_and_replay_authority(users, workspace, board):
    editor = users["editor"]
    first = create(editor, workspace, board, idempotency_key="create-key")
    replay_run = op(
        editor,
        "mechanical_proposal.create",
        {
            "workspace_id": workspace,
            "interpretation_id": board["interpretation_id"],
            "name": "Enclosure proposal",
            "parameters": {},
        },
        idempotency_key="create-key",
    )
    assert replay_run["draft_id"] == first["draft_id"]
    assert ProposalDraft.objects.count() == 1
    with pytest.raises(IdempotencyMismatch):
        create(editor, workspace, board, name="Different", idempotency_key="create-key")
    saved = update(editor, first, FULL, idempotency_key="update-key")
    assert update(editor, first, FULL, idempotency_key="update-key")["version"] == saved["version"]
    assert ProposalDraft.objects.get(id=first["draft_id"]).version == 2
    with pytest.raises(IdempotencyMismatch):
        update(editor, first, {}, idempotency_key="update-key")
    # A member whose edit grant is removed cannot replay a retained outcome.
    WorkspaceMember.objects.filter(workspace_id=workspace, user=editor).update(role="viewer")
    with pytest.raises(PermissionDenied):
        update(editor, first, FULL, idempotency_key="update-key")


def test_invalid_payloads_and_unknown_identities_are_rejected_atomically(users, workspace, board):
    editor = users["editor"]
    for parameters in (
        {"shell": {"wall_mm": -1}},
        {"shell": {"wall_mm": float("inf")}},
        {"shell": {"wall_mm": "2"}},
        {"shell": {"unexpected": 1}},
        {"connectors": [{"component_id": str(J1), "side": "up"}]},
        {"vents": [{"local_id": "v", "face": "lid"}, {"local_id": "v", "face": "floor"}]},
    ):
        with pytest.raises(ValidationFailed):
            create(editor, workspace, board, parameters)
    with pytest.raises(ValidationFailed, match="native hole"):
        create(editor, workspace, board, {"mounts": [{"pad_id": str(UUID(int=7)), "use": True}]})
    with pytest.raises(ValidationFailed, match="native component"):
        create(
            editor,
            workspace,
            board,
            {"connectors": [{"component_id": str(uuid4()), "side": "east"}]},
        )
    assert not ProposalDraft.objects.exists()
    draft = create(editor, workspace, board)
    with pytest.raises(ValidationFailed):
        update(editor, draft, {"mounts": [{"pad_id": str(uuid4()), "use": True}]})
    assert ProposalDraft.objects.get(id=draft["draft_id"]).version == 1


def test_retain_failure_rolls_back_all_rows(users, workspace, board, monkeypatch):
    draft = create(users["editor"], workspace, board)
    from specmate.mechanical_proposals import operations

    original = operations.revision_record
    calls = {"n": 0}

    def fail_after_insert(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ValidationFailed("integrity")
        return original(*args, **kwargs)

    monkeypatch.setattr(operations, "revision_record", fail_after_insert)
    with pytest.raises(ValidationFailed):
        op(
            users["editor"],
            "mechanical_proposal.retain",
            {"draft_id": draft["draft_id"]},
            expected_state=draft["state"],
            idempotency_key="rollback",
        )
    assert not ProposalRevision.objects.exists()


def test_database_guards_protect_retained_and_draft_rows(users, workspace, board):
    editor = users["editor"]
    draft = create(editor, workspace, board)
    retained = op(
        editor,
        "mechanical_proposal.retain",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )
    revision = ProposalRevision.objects.get(id=retained["revision_id"])
    with pytest.raises(DatabaseError), transaction.atomic():
        ProposalRevision.objects.filter(id=revision.id).update(status="declared_inputs_complete")
    with pytest.raises(DatabaseError), transaction.atomic():
        revision.delete()
    with pytest.raises(DatabaseError), transaction.atomic():
        ProposalDraft.objects.filter(id=draft["draft_id"]).delete()
    # The draft keeps its board and advances exactly one version per edit.
    with pytest.raises(DatabaseError), transaction.atomic():
        ProposalDraft.objects.filter(id=draft["draft_id"]).update(version=5)
    with pytest.raises(DatabaseError), transaction.atomic():
        ProposalDraft.objects.filter(id=draft["draft_id"]).update(name="x", version=1)
    # A forged retained row cannot claim a different content hash or physical qualification.
    forged = bytes(revision.canonical).replace(b'"physical":false', b'"physical":true')
    with pytest.raises(DatabaseError), transaction.atomic():
        ProposalRevision.objects.create(
            draft_id=revision.draft_id,
            workspace_id=revision.workspace_id,
            number=9,
            interpretation_id=revision.interpretation_id,
            interpretation_sha256=revision.interpretation_sha256,
            generator=revision.generator,
            draft_version=revision.draft_version,
            status=revision.status,
            canonical=forged,
            sha256=digest(forged),
            created_by_id=revision.created_by_id,
            request_id="forged",
        )
    with pytest.raises(DatabaseError), transaction.atomic():
        ProposalRevision.objects.create(
            draft_id=revision.draft_id,
            workspace_id=revision.workspace_id,
            number=10,
            interpretation_id=revision.interpretation_id,
            interpretation_sha256=revision.interpretation_sha256,
            generator=revision.generator,
            draft_version=revision.draft_version,
            status=revision.status,
            canonical=bytes(revision.canonical) + b" ",
            sha256="0" * 64,
            created_by_id=revision.created_by_id,
            request_id="forged",
        )


def test_board_inputs_expose_native_identities_for_choices(users, workspace, board):
    inputs = op(
        users["viewer"],
        "mechanical_proposal.board_inputs",
        {"workspace_id": workspace, "interpretation_id": board["interpretation_id"]},
    )
    assert {h["pad_id"] for h in inputs["holes"]} == {str(p) for p, _ in HOLES.values()}
    assert all(h["mounting_status"] == "candidate-not-reviewed" for h in inputs["holes"])
    assert str(J1) in {c["component_id"] for c in inputs["components"]}
    choices = op(users["viewer"], "mechanical_proposal.board_choices", {"workspace_id": workspace})
    assert choices["boards"][0]["hole_candidates"] == 4
    assert choices["boards"][0]["outline"] == "closed-line-polygons"


def test_http_reads_and_generic_envelope_call_the_same_operations(users, workspace, board):
    draft = create(users["editor"], workspace, board, FULL)
    client = Client()
    client.force_login(users["viewer"])
    response = client.get(f"/api/v0/mechanical-proposals/drafts/{draft['draft_id']}")
    assert response.status_code == 200 and response.json()["proposal"] == draft["proposal"]
    listing = client.get(f"/api/v0/mechanical-proposals/workspaces/{workspace}/drafts").json()
    assert [d["draft_id"] for d in listing["drafts"]] == [draft["draft_id"]]
    assert (
        client.get(f"/api/v0/mechanical-proposals/workspaces/{workspace}/boards").status_code == 200
    )
    denied = client.post(
        "/api/v0/operations",
        data=json.dumps(
            {
                "operation": "mechanical_proposal.create",
                "request_id": "viewer-create",
                "payload": {
                    "workspace_id": workspace,
                    "interpretation_id": board["interpretation_id"],
                    "name": "x",
                },
            }
        ),
        content_type="application/json",
    )
    assert denied.status_code == 403
    client.force_login(users["editor"])
    created = client.post(
        "/api/v0/operations",
        data=json.dumps(
            {
                "operation": "mechanical_proposal.create",
                "request_id": "editor-create",
                "payload": {
                    "workspace_id": workspace,
                    "interpretation_id": board["interpretation_id"],
                    "name": "HTTP proposal",
                },
            }
        ),
        content_type="application/json",
    )
    assert created.status_code == 200
    anonymous = Client()
    assert (
        anonymous.get(f"/api/v0/mechanical-proposals/drafts/{draft['draft_id']}").status_code == 401
    )


def test_losing_project_access_hides_drafts_and_retained_records(users, workspace, board):
    editor = users["editor"]
    draft = create(editor, workspace, board, FULL)
    retained = op(
        editor,
        "mechanical_proposal.retain",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )
    WorkspaceMember.objects.filter(workspace_id=workspace, user=editor).delete()
    with pytest.raises(NotFound):
        op(editor, "mechanical_proposal.read", {"draft_id": draft["draft_id"]})
    with pytest.raises(NotFound):
        op(editor, "mechanical_proposal.read_retained", {"revision_id": retained["revision_id"]})
