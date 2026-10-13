"""One reviewed adoption path for GUI, API, MCP and trusted jobs.

Selections only replace an outer contextual firmware pin. Child copper, population,
native interpretations and frozen firmware/assembly revisions remain exact inputs.
"""

import copy
import hashlib

from specmate.access.permissions import Perm
from specmate.assemblies.queries import Closure, get_snapshot
from specmate.design.operations import (
    UpdateDraft,
    authorize_design_content,
    authorize_snapshot,
    canonical_bytes,
    check_state,
    scoped_draft,
    update_draft,
)
from specmate.firmware_occurrences.contracts import (
    AdoptOccurrence,
    InspectOccurrences,
    ReadAdoption,
    ReviewOccurrence,
)
from specmate.firmware_occurrences.models import FirmwareAdoption
from specmate.operations import Conflict, Context, NotFound, ValidationFailed, operation
from specmate.operations.models import IdempotencyRecord
from specmate.operations.scope import LEGACY_SCOPE
from specmate.pcb.firmware import STATUS, read_revision


def owning_draft(ctx, draft_id, permission=Perm.PROJECT_READ, *, lock=False):
    draft = scoped_draft(ctx, draft_id, permission, lock=lock)
    if draft.base_revision_id:
        authorize_snapshot(ctx.user, draft.base_revision.snapshot)
    closure = Closure(ctx.user, draft.content, kind=draft.definition.kind)
    if draft.definition.kind != "assembly" or closure.root is None:
        raise ValidationFailed("Select an assembly draft.")
    return draft, closure


def inputs(ctx, p, *, edit=False, lock=False):
    draft, closure = owning_draft(
        ctx, p.draft_id, Perm.DESIGN_EDIT if edit else Perm.PROJECT_READ, lock=lock
    )
    # Resolve the candidate's complete source/dependency closure before path diagnostics.
    candidate = read_revision(ctx.user, p.firmware_revision_id) if p.firmware_revision_id else None
    return draft, closure, candidate


def planned_review(ctx, p, draft, closure, candidate):
    node = closure.nodes.get(tuple(p.path))
    if node is None:
        raise NotFound("Occurrence unavailable.")
    assigned = closure.assignments.get(tuple(p.path)) or node.occurrence.assignments
    previous = (
        read_revision(ctx.user, assigned.firmware_revision_id)
        if assigned.firmware_revision_id
        else None
    )
    matches = candidate is None or (
        node.revision.definition.kind == "pcb_population"
        and candidate["content"]["firmware"]["target"]["population_revision_id"]
        == str(node.revision.id)
        and candidate["evaluation"]["readiness"] != "blocked"
    )
    result = {
        "draft_id": str(draft.id),
        "state": draft.state_token,
        "content_sha256": hashlib.sha256(canonical_bytes(draft.content)).hexdigest(),
        "path": list(p.path),
        "firmware_revision_id": str(p.firmware_revision_id) if p.firmware_revision_id else None,
        "display_ref": node.occurrence.display_ref,
        "occurrence_revision_id": str(node.revision.id),
        "occurrence_snapshot_sha256": node.revision.snapshot.sha256,
        "occurrence_kind": node.revision.definition.kind,
        "previous": previous,
        "candidate": candidate,
        "eligible": matches,
        "message": (
            "Explicitly leave this contextual occurrence unassigned."
            if candidate is None
            else "The firmware declares this exact frozen population as its target."
            if matches
            else "The firmware does not declare a valid target for this exact population."
        ),
        **STATUS,
    }
    return {**result, "review_sha256": hashlib.sha256(canonical_bytes(result)).hexdigest()}


def adoption_result(ctx, adoption_id, *, edit=False):
    row = (
        FirmwareAdoption.objects.select_related("draft__definition").filter(id=adoption_id).first()
    )
    if row is None:
        raise NotFound("Firmware adoption unavailable.")
    draft, _ = owning_draft(ctx, row.draft_id, Perm.DESIGN_EDIT if edit else Perm.PROJECT_READ)
    # Displaced declarations and ancestors remain part of retained evidence authority.
    for content in (row.before_content, row.after_content):
        authorize_design_content(ctx.user, draft.definition, content)
    if row.firmware_revision_id:
        read_revision(ctx.user, row.firmware_revision_id)
    return {
        "adoption_id": str(row.id),
        "draft_id": str(row.draft_id),
        "draft_version": row.draft_version,
        "path": row.path,
        "firmware_revision_id": str(row.firmware_revision_id) if row.firmware_revision_id else None,
        "basis": row.basis,
        "review": row.review,
        "created_at": row.created_at.isoformat(),
        **STATUS,
    }


def adoption_replay(ctx, p, stored):
    inputs(ctx, p, edit=True)
    adoption_result(ctx, stored["adoption_id"], edit=True)
    draft, _ = owning_draft(ctx, stored["draft_id"], Perm.DESIGN_EDIT)
    authorize_design_content(ctx.user, draft.definition, stored["content"])


def adoption_scope(ctx, p):
    draft, _, _ = inputs(ctx, p, edit=True)
    scope = f"project:{draft.definition.project_id}"
    # Authorize current and retained outcomes before changed-payload/legacy conflicts.
    for prior in IdempotencyRecord.objects.select_for_update().filter(
        actor=ctx.user,
        operation="firmware_occurrence.adopt",
        key=ctx.idempotency_key,
        scope__in=[scope, LEGACY_SCOPE],
    ):
        adoption_replay(ctx, p, prior.result)
    return scope


@operation(
    "firmware_occurrence.inspect",
    InspectOccurrences,
    summary="Inspect exact board occurrences and their independent firmware pins.",
    supports_idempotency=False,
)
def inspect(ctx: Context, p: InspectOccurrences):
    history = []
    history_truncated = False
    if p.draft_id:
        draft, closure = owning_draft(ctx, p.draft_id)
        owner = {"draft_id": str(draft.id), "state": draft.state_token, "snapshot_id": None}
        retained = list(FirmwareAdoption.objects.filter(draft=draft).order_by("-created_at")[:101])
        history_truncated = len(retained) > 100
        for row in retained[:100]:
            evidence = adoption_result(ctx, row.id)
            history.append(
                {key: evidence[key] for key in ("adoption_id", "path", "basis", "created_at")}
            )
    else:
        snapshot, closure = get_snapshot(ctx.user, p.snapshot_id)
        owner = {"draft_id": None, "state": None, "snapshot_id": str(snapshot.id)}
    rows = []
    for path, node in closure.nodes.items():
        assigned = closure.assignments.get(path) or node.occurrence.assignments
        rows.append(
            {
                "path": list(path),
                "display_ref": node.occurrence.display_ref,
                "name": node.revision.definition.name,
                "kind": node.revision.definition.kind,
                "revision_id": str(node.revision.id),
                "snapshot_sha256": node.revision.snapshot.sha256,
                "firmware_revision_id": (
                    str(assigned.firmware_revision_id) if assigned.firmware_revision_id else None
                ),
            }
        )
    return {
        **owner,
        "occurrences": rows,
        "adoptions": history,
        "history_truncated": history_truncated,
        **STATUS,
    }


@operation(
    "firmware_occurrence.review",
    ReviewOccurrence,
    summary="Review an exact contextual firmware selection without changing the assembly.",
    supports_idempotency=False,
)
def review(ctx: Context, p: ReviewOccurrence):
    draft, closure, candidate = inputs(ctx, p)
    return planned_review(ctx, p, draft, closure, candidate)


@operation(
    "firmware_occurrence.adopt",
    AdoptOccurrence,
    summary="Adopt an explicitly reviewed firmware pin into one contextual occurrence.",
    requires_expected_state=True,
    idempotency_scope=adoption_scope,
    authorize_replay=adoption_replay,
)
def adopt(ctx: Context, p: AdoptOccurrence):
    draft, closure, candidate = inputs(ctx, p, edit=True, lock=True)
    check_state(ctx, draft)
    preview = planned_review(ctx, p, draft, closure, candidate)
    if preview["review_sha256"] != p.review_sha256:
        raise Conflict("Firmware selection changed; review this occurrence again.")
    if not preview["eligible"]:
        raise ValidationFailed("The reviewed firmware target does not match this occurrence.")
    before = copy.deepcopy(draft.content)
    assembly = copy.deepcopy(before["assembly"])
    assembly["assignments"] = [
        record for record in assembly.get("assignments", []) if record["path"] != list(p.path)
    ]
    assembly["assignments"].append(
        {
            "path": list(p.path),
            "assignments": {
                "firmware_revision_id": str(p.firmware_revision_id)
                if p.firmware_revision_id
                else None
            },
        }
    )
    result = update_draft(ctx, UpdateDraft(draft_id=draft.id, changes={"assembly": assembly}))
    draft.refresh_from_db()
    evidence = FirmwareAdoption.objects.create(
        draft=draft,
        draft_version=draft.version,
        firmware_revision_id=p.firmware_revision_id,
        path=list(p.path),
        review_sha256=p.review_sha256,
        review=preview,
        before_content=before,
        after_content=result["content"],
        basis=p.basis,
        adopted_by=ctx.user,
    )
    return {**result, "adoption_id": str(evidence.id), "review": preview, **STATUS}


@operation(
    "firmware_occurrence.read_adoption",
    ReadAdoption,
    summary="Read immutable contextual firmware adoption evidence under current authority.",
    supports_idempotency=False,
)
def read_adoption(ctx: Context, p: ReadAdoption):
    return adoption_result(ctx, p.adoption_id)
