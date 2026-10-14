"""Explicit source ownership of the board outline and reconciled extracted projections.

Accepted reports use the shared intake/request/accept operations; only the runner's
successful output is simulated, as in the PCB intake tests. Native re-extraction of an
edited board is a separate real-tool checkpoint.
"""

import copy

import pytest
from django.db import DatabaseError, transaction
from django.test import Client

from specmate.access.models import WorkspaceMember
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    Unauthenticated,
    Unsupported,
    ValidationFailed,
)
from specmate.pcb.models import PropertyAuthority, PropertyOwnerChange, PropertyProjection

from .conftest import op, remove_member
from .scope_helpers import workspace_of
from .test_pcb import BOARD, digest, recipe, report_payload, source, successful_output  # noqa: F401
from .test_sources import register

SQUARE = [[0.0, 0.0], [50.0, 0.0], [50.0, 30.0], [0.0, 30.0]]
WIDER = [[0.0, 0.0], [60.0, 0.0], [60.0, 30.0], [0.0, 30.0]]


def derive(users, revision_id, name="Editable synthetic board"):
    return op(
        users["editor"],
        "source.derive_bundle",
        {"source_revision_id": revision_id, "name": name},
    )


def accepted(users, workspace, revision_id, board, outline=(SQUARE,), key="x", cutouts=()):
    intake = op(
        users["editor"],
        "pcb.register_intake",
        {
            "workspace_id": workspace_of(workspace),
            "source_revision_id": revision_id,
            "board_path": "board.kicad_pcb",
        },
    )
    from specmate.pcb.pack import recipe_for

    attempt = op(
        users["owner"],
        "pcb.request_extraction",
        {
            "intake_id": intake["intake_id"],
            "recipe_id": recipe_for("board.kicad_pcb", "AGPL-3.0-only")["id"],
        },
        idempotency_key=f"extract-{key}",
    )
    report = copy.deepcopy(report_payload())
    report["source_sha256"] = digest(board)
    if outline is not None:
        report["outline"] = list(outline)
        report["cutouts"] = list(cutouts)
        report["coverage"]["outline"] = "closed-line-polygons"
        report["unsupported"][0] = "arcs and curved outlines unsupported"
    successful_output(attempt, report)
    return op(users["editor"], "pcb.accept_extraction", {"attempt_id": attempt["attempt_id"]})


def edit_owner(users, workspace, baseline, board):
    """Outline edit through the owning source: export handoff, change, reviewed submit."""
    client = Client()
    client.force_login(users["editor"])
    exported = client.get(f"/api/v0/sources/revisions/{baseline['revision_id']}/handoff")
    assert exported.status_code == 200
    import io
    import zipfile

    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        entries = {name: archive.read(name) for name in archive.namelist()}
    entries["board.kicad_pcb"] = board
    for data in entries.values():
        register(users["editor"], workspace, data)
    payload = {
        "baseline_revision_id": baseline["revision_id"],
        "files": [{"path": p, "sha256": digest(d)} for p, d in entries.items()],
    }
    review = op(users["editor"], "source.preview_edit", payload)
    return op(
        users["editor"],
        "source.submit_edit",
        {
            **payload,
            "target": "next_revision",
            "summary": "Synthetic Edge.Cuts edit",
            "reviewed_sha256": review["review_sha256"],
        },
        expected_state=review["state"],
    )


def declare(users, revision_id, key=None, user="editor"):
    return op(
        users[user],
        "source_property.declare",
        {
            "owner_revision_id": revision_id,
            "path": "board.kicad_pcb",
            "property": "pcb.board_outline",
            "basis": "Edge.Cuts is maintained in the native board.",
        },
        **({"idempotency_key": key} if key else {}),
    )


def reconcile(users, authority, interpretation, state, user="editor", **ctx):
    return op(
        users[user],
        "source_property.reconcile",
        {
            "authority_id": authority,
            "interpretation_id": interpretation["interpretation_id"],
            "basis": "Reviewed accepted extraction of the owner.",
        },
        expected_state=state,
        **ctx,
    )


def read(users, authority, user="editor"):
    return op(users[user], "source_property.read", {"authority_id": authority})


@pytest.fixture
def owner(users, workspace, source, recipe):  # noqa: F811
    return derive(users, source["revision_id"])


EDITED = BOARD + b"\n# synthetic Edge.Cuts edit\n"


def test_outline_edit_goes_through_owner_and_reconciles_projection(users, workspace, owner):
    authority = declare(users, owner["revision_id"])
    assert authority["state"] == "authority-v1"
    first = read(users, authority["authority_id"])
    assert first["status"] == "unreconciled" and first["projection"] is None
    assert first["owner"]["editable"] and first["owner"]["path"] == "board.kicad_pcb"
    assert "no editable copy" in first["editable_copy"]

    original = accepted(users, workspace, owner["revision_id"], BOARD)
    projected = reconcile(users, authority["authority_id"], original, "authority-v1")
    assert projected["status"] == "known" and projected["changes"]["kind"] == "initial"
    current = read(users, authority["authority_id"])
    assert current["status"] == "current"
    pinned = current["projection"]
    assert pinned["value"] == {"outline": [SQUARE], "cutouts": []}
    assert pinned["summary"]["net_area_mm2"] == 1500
    assert pinned["source_revision_id"] == owner["revision_id"]
    assert pinned["source_sha256"] == digest(BOARD)
    assert pinned["report_sha256"] == original["sha256"]
    assert pinned["adapter"] == "kicad-intake-v1" and pinned["tool_version"] == "10.0.6"

    # The edit is made in the owning native file and re-enters as the owner's next revision.
    edited = edit_owner(users, workspace, owner, EDITED)
    stale = read(users, authority["authority_id"])
    assert stale["status"] == "stale"
    assert stale["owner"]["head_revision_id"] == edited["revision_id"]
    assert stale["projection"]["projection_id"] == projected["projection_id"]
    with pytest.raises(Conflict, match="newer revision"):
        reconcile(users, authority["authority_id"], original, "authority-v2")

    extracted = accepted(users, workspace, edited["revision_id"], EDITED, outline=[WIDER], key="y")
    with pytest.raises(Conflict, match="changed since"):
        reconcile(users, authority["authority_id"], extracted, "authority-v1")
    result = reconcile(users, authority["authority_id"], extracted, "authority-v2")
    assert result["changes"]["kind"] == "changed"
    assert result["changes"]["before"]["net_area_mm2"] == 1500
    assert result["changes"]["after"]["net_area_mm2"] == 1800
    assert result["changes"]["vertices"] == {"added": 2, "removed": 2}
    reconciled = read(users, authority["authority_id"])
    assert reconciled["status"] == "current" and reconciled["state"] == "authority-v3"
    assert [h["version"] for h in reconciled["history"]] == [3, 2]
    # Historic projections and their source pins remain exact.
    assert reconciled["history"][1] == pinned
    with pytest.raises(ValidationFailed, match="already reflects"):
        reconcile(users, authority["authority_id"], extracted, "authority-v3")


def test_competing_sources_and_owners_are_refused_and_preserved(users, workspace, owner):
    authority = declare(users, owner["revision_id"])
    owned = reconcile(
        users,
        authority["authority_id"],
        accepted(users, workspace, owner["revision_id"], BOARD),
        "authority-v1",
    )
    # A fork of the same lineage cannot become a second owner of the same property.
    fork = derive(users, owner["revision_id"], "Competing fork")
    with pytest.raises(Conflict, match="already has a designated owner") as conflict:
        declare(users, fork["revision_id"])
    assert conflict.value.details["authority_id"] == authority["authority_id"]
    forked_board = BOARD + b"\n# fork edit\n"
    forked = edit_owner(users, workspace, fork, forked_board)
    evidence = accepted(
        users, workspace, forked["revision_id"], forked_board, outline=[WIDER], key="f"
    )
    with pytest.raises(ValidationFailed, match="designated owning source"):
        reconcile(users, authority["authority_id"], evidence, "authority-v2")
    view = read(users, authority["authority_id"])
    assert view["status"] == "current"
    assert view["projection"]["projection_id"] == owned["projection_id"]
    preserved = view["non_owner_evidence"]["items"]
    assert [(i["interpretation_id"], i["differs_from_projection"]) for i in preserved] == [
        (evidence["interpretation_id"], True)
    ]
    assert preserved[0]["bundle_name"] == "Competing fork"
    # Transfer is refused while the fork lacks the owner's latest revision ...
    edited = edit_owner(users, workspace, owner, EDITED)
    with pytest.raises(Conflict, match="would compete"):
        op(
            users["editor"],
            "source_property.transfer",
            {
                "authority_id": authority["authority_id"],
                "new_owner_revision_id": forked["revision_id"],
                "basis": "Adopt fork",
            },
            expected_state="authority-v2",
        )
    # ... and allowed to a successor that contains it; the projection is then stale.
    successor = derive(users, edited["revision_id"], "Successor working copy")
    moved = op(
        users["editor"],
        "source_property.transfer",
        {
            "authority_id": authority["authority_id"],
            "new_owner_revision_id": successor["revision_id"],
            "basis": "Continue in a new working copy.",
        },
        expected_state="authority-v2",
        idempotency_key="transfer",
    )
    assert moved["state"] == "authority-v3"
    after = read(users, authority["authority_id"])
    assert after["owner"]["bundle_id"] == successor["bundle_id"]
    assert after["status"] == "stale"
    assert [c["owner_revision_id"] for c in after["owner_changes"]] == [
        owner["revision_id"],
        successor["revision_id"],
    ]


def test_disagreeing_extractions_and_unknown_coverage_are_explicit(users, workspace, owner):
    authority = declare(users, owner["revision_id"])
    first = accepted(users, workspace, owner["revision_id"], BOARD, key="a")
    second = accepted(users, workspace, owner["revision_id"], BOARD, outline=[WIDER], key="b")
    view = read(users, authority["authority_id"])
    assert view["status"] == "conflicting" and view["head_candidates_agree"] is False
    assert {c["interpretation_id"] for c in view["head_candidates"]} == {
        first["interpretation_id"],
        second["interpretation_id"],
    }
    for chosen in (first, second):
        with pytest.raises(Conflict, match="disagree"):
            reconcile(users, authority["authority_id"], chosen, "authority-v1")
    assert not PropertyProjection.objects.exists()

    # Unsupported coverage becomes an explicit unknown, never the previous outline.
    edited = edit_owner(users, workspace, owner, EDITED)
    unknown = accepted(users, workspace, edited["revision_id"], EDITED, outline=None, key="u")
    result = reconcile(users, authority["authority_id"], unknown, "authority-v1")
    assert result["status"] == "unknown"
    view = read(users, authority["authority_id"])
    assert view["status"] == "current"
    assert view["projection"]["value"]["outline"] is None
    assert view["projection"]["summary"] == {
        "status": "unknown",
        "reason": ["outline unresolved"],
    }


def test_declaration_requires_supported_current_owner_file(users, workspace, owner, source):  # noqa: F811
    with pytest.raises(Unsupported):
        op(
            users["editor"],
            "source_property.declare",
            {
                "owner_revision_id": owner["revision_id"],
                "path": "schematic.kicad_sch",
                "property": "pcb.board_outline",
                "basis": "x",
            },
        )
    edited = edit_owner(users, workspace, owner, EDITED)
    with pytest.raises(Conflict, match="current revision"):
        declare(users, owner["revision_id"])
    # Declaring on the preserved original makes it the read-only owner of its lineage.
    authority = declare(users, source["revision_id"])
    assert read(users, authority["authority_id"])["owner"]["editable"] is False
    # The editable derivative shares the original's lineage, so it cannot also own it.
    with pytest.raises(Conflict, match="already has a designated owner"):
        declare(users, edited["revision_id"])


def test_current_authority_precedes_diagnostics_and_retained_conflicts(users, workspace, owner):
    authority = declare(users, owner["revision_id"], key="declare")
    interpretation = accepted(users, workspace, owner["revision_id"], BOARD)
    with pytest.raises(PermissionDenied):
        reconcile(users, authority["authority_id"], interpretation, "authority-v9", user="viewer")
    with pytest.raises(NotFound):
        read(users, authority["authority_id"], user="outsider")
    assert read(users, authority["authority_id"], user="viewer")["status"] == "unreconciled"
    done = reconcile(
        users, authority["authority_id"], interpretation, "authority-v1", idempotency_key="r"
    )
    assert (
        reconcile(
            users, authority["authority_id"], interpretation, "authority-v1", idempotency_key="r"
        )
        == done
    )
    with pytest.raises(IdempotencyMismatch):
        op(
            users["editor"],
            "source_property.reconcile",
            {
                "authority_id": authority["authority_id"],
                "interpretation_id": interpretation["interpretation_id"],
                "basis": "different",
            },
            expected_state="authority-v1",
            idempotency_key="r",
        )
    WorkspaceMember.objects.filter(workspace_id=workspace, user=users["editor"]).update(
        role="viewer"
    )
    for key, basis in (("r", "Reviewed accepted extraction of the owner."), ("r", "different")):
        with pytest.raises(PermissionDenied):
            op(
                users["editor"],
                "source_property.reconcile",
                {
                    "authority_id": authority["authority_id"],
                    "interpretation_id": interpretation["interpretation_id"],
                    "basis": basis,
                },
                expected_state="authority-v1",
                idempotency_key=key,
            )
    with pytest.raises(PermissionDenied):
        declare(users, owner["revision_id"], key="declare")
    WorkspaceMember.objects.filter(workspace_id=workspace, user=users["editor"]).update(
        role="editor"
    )
    # Losing membership hides the authority before any detail.
    remove_member(users["editor"])
    with pytest.raises(NotFound):
        read(users, authority["authority_id"])
    with pytest.raises(NotFound):
        reconcile(users, authority["authority_id"], interpretation, "authority-v2")


def test_database_guards_keep_owner_identity_and_projections_immutable(users, workspace, owner):
    authority = declare(users, owner["revision_id"])
    reconcile(
        users,
        authority["authority_id"],
        accepted(users, workspace, owner["revision_id"], BOARD),
        "authority-v1",
    )
    row = PropertyAuthority.objects.get(id=authority["authority_id"])
    for change in (
        {"owner_path": "other.kicad_pcb", "version": row.version + 1},
        {"version": row.version + 5},
    ):
        with pytest.raises(DatabaseError), transaction.atomic():
            PropertyAuthority.objects.filter(id=row.id).update(**change)
    for model in (PropertyAuthority, PropertyProjection, PropertyOwnerChange):
        with pytest.raises(DatabaseError), transaction.atomic():
            model.objects.all().delete()
    with pytest.raises(DatabaseError), transaction.atomic():
        PropertyProjection.objects.update(basis="rewritten")


def test_http_reads_refresh_actor_and_expose_provenance(users, workspace, owner):
    authority = declare(users, owner["revision_id"])
    client = Client()
    client.force_login(users["viewer"])
    listed = client.get(f"/api/v0/pcb/workspaces/{workspace}/property-authorities")
    assert listed.status_code == 200
    assert listed.json()["authorities"][0]["owner_path"] == "board.kicad_pcb"
    detail = client.get(f"/api/v0/pcb/property-authorities/{authority['authority_id']}")
    assert detail.status_code == 200 and detail.json()["status"] == "unreconciled"
    users["viewer"].is_active = False
    users["viewer"].save()
    assert client.get(
        f"/api/v0/pcb/property-authorities/{authority['authority_id']}"
    ).status_code in (
        401,
        403,
    )


def test_declare_existing_authority_requires_current_membership(
    users,
    workspace,
    owner,
    source,  # noqa: F811
):
    authority = declare(users, owner["revision_id"])
    assert read(users, authority["authority_id"])["status"] == "unreconciled"
    # A second declaration over the same owner lineage is a conflict for members; a
    # non-member sees nothing at all.
    remove_member(users["editor"])
    with pytest.raises(NotFound):
        read(users, authority["authority_id"])
    with pytest.raises(NotFound):
        declare(users, source["revision_id"])


def test_declare_checks_membership_before_head_diagnostic(users, workspace, owner):
    edited = edit_owner(users, workspace, owner, EDITED)
    assert edited["revision_id"] != owner["revision_id"]
    remove_member(users["editor"])
    with pytest.raises(NotFound):
        declare(users, owner["revision_id"])


def test_direct_list_refreshes_current_actor(users, workspace, owner):
    from specmate.pcb.authority import list_authorities

    declare(users, owner["revision_id"])
    type(users["viewer"]).objects.filter(pk=users["viewer"].pk).update(is_active=False)
    with pytest.raises(Unauthenticated):
        list_authorities(users["viewer"], workspace)


def test_retained_projection_checks_authority_before_changed_request_diagnostics(
    users, workspace, owner
):
    authority = declare(users, owner["revision_id"])
    first = accepted(users, workspace, owner["revision_id"], BOARD, key="retained-first")
    other = accepted(users, workspace, owner["revision_id"], BOARD, key="retained-other")
    reconcile(users, authority["authority_id"], first, "authority-v1", idempotency_key="retained")
    with pytest.raises(IdempotencyMismatch):
        reconcile(
            users, authority["authority_id"], other, "authority-v1", idempotency_key="retained"
        )
    WorkspaceMember.objects.filter(workspace_id=workspace, user=users["editor"]).delete()
    with pytest.raises(NotFound):
        reconcile(
            users, authority["authority_id"], other, "authority-v1", idempotency_key="retained"
        )


def test_non_owner_evidence_requires_membership_before_truncated_flag(
    users, workspace, owner, monkeypatch
):
    import specmate.pcb.authority as authority_module

    monkeypatch.setattr(authority_module, "MAX_EVIDENCE", 1)
    authority = declare(users, owner["revision_id"])
    first = derive(users, owner["revision_id"], "First non-owner")
    second = derive(users, owner["revision_id"], "Second non-owner")
    accepted(users, workspace, first["revision_id"], BOARD, key="first-nonowner")
    accepted(users, workspace, second["revision_id"], BOARD, key="second-nonowner")
    assert read(users, authority["authority_id"])["non_owner_evidence"]
    remove_member(users["editor"])
    with pytest.raises(NotFound):
        read(users, authority["authority_id"])


@pytest.mark.parametrize("invalid", ["self", "missing_previous", "source_hash", "value_hash"])
def test_projection_insert_rejects_invalid_history_or_hash(users, workspace, owner, invalid):
    import uuid

    authority = declare(users, owner["revision_id"])
    result = reconcile(
        users,
        authority["authority_id"],
        accepted(users, workspace, owner["revision_id"], BOARD),
        "authority-v1",
    )
    row = PropertyProjection.objects.get(id=result["projection_id"])
    clone = {
        field.attname: getattr(row, field.attname)
        for field in PropertyProjection._meta.fields
        if field.name not in ("id", "created_at")
    }
    next_id = uuid.uuid4()
    clone.update(id=next_id, previous_id=row.id, version=3)
    if invalid == "self":
        clone["previous_id"] = next_id
    elif invalid == "missing_previous":
        clone["previous_id"] = None
    elif invalid == "source_hash":
        clone["source_sha256"] = "0" * 64
    else:
        clone["value_sha256"] = "0" * 64
    with pytest.raises(DatabaseError), transaction.atomic():
        PropertyAuthority.objects.filter(id=authority["authority_id"]).update(version=3)
        PropertyProjection.objects.create(**clone)


def test_projection_history_allows_transfer_version_gap(users, workspace, owner):
    authority = declare(users, owner["revision_id"])
    first = reconcile(
        users,
        authority["authority_id"],
        accepted(users, workspace, owner["revision_id"], BOARD, key="before-transfer"),
        "authority-v1",
    )
    successor = derive(users, owner["revision_id"], "Successor owner")
    moved = op(
        users["editor"],
        "source_property.transfer",
        {
            "authority_id": authority["authority_id"],
            "new_owner_revision_id": successor["revision_id"],
            "basis": "Deliberate owner transfer",
        },
        expected_state="authority-v2",
    )
    final = reconcile(
        users,
        authority["authority_id"],
        accepted(users, workspace, successor["revision_id"], BOARD, key="after-transfer"),
        moved["state"],
    )
    projection = PropertyProjection.objects.get(id=final["projection_id"])
    assert projection.version == 4
    assert str(projection.previous_id) == first["projection_id"]
    assert read(users, authority["authority_id"])["status"] == "current"
