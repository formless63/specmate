"""Shared operations for reviewable parametric proposals.

Drafts hold declared parameters; the proposal itself is recomputed deterministically
from the pinned accepted board report on every read, so a view can never drift from its
inputs. Retaining writes an immutable derived record. Nothing here edits a design draft,
snapshot, placement or source, and no native tool runs.
"""

import hashlib
import json

from django.db import IntegrityError, transaction
from pydantic import ValidationError as PydanticValidationError

from specmate.access.permissions import Perm, authorize
from specmate.catalog_matching.queries import current_actor
from specmate.mechanical_proposals.contracts import (
    GENERATOR,
    BoardInputs,
    CreateProposal,
    DraftRef,
    ListProposals,
    Parameters,
    RetainedRef,
    RetainProposal,
    UpdateProposal,
)
from specmate.mechanical_proposals.generators import UnknownReference, generate
from specmate.mechanical_proposals.models import ProposalDraft, ProposalRevision
from specmate.operations import Conflict, Context, NotFound, ValidationFailed, operation
from specmate.operations.scope import project_scope
from specmate.pcb.models import PcbInterpretation
from specmate.pcb.population import scoped_interpretation
from specmate.pcb.report import Report
from specmate.sources.authority import authorize_revision

LIST_LIMIT = 100


def canonical_bytes(document) -> bytes:
    return json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def state_token(draft) -> str:
    return f"proposal-v{draft.version}"


# ---------------------------------------------------------------- authority


def board_report(user, project_id, interpretation_id):
    """Fresh authority over the exact accepted board interpretation, then its report."""
    interpretation = scoped_interpretation(user, project_id, interpretation_id)
    authorize_revision(user, interpretation.attempt.intake.source_revision, Perm.PROJECT_READ)
    try:
        report = Report.model_validate_json(bytes(interpretation.canonical))
    except PydanticValidationError:
        raise ValidationFailed("Accepted board report is invalid.") from None
    if hashlib.sha256(bytes(interpretation.canonical)).hexdigest() != interpretation.sha256:
        raise ValidationFailed("Accepted board report integrity check failed.")
    return interpretation, report


def authorized_draft(user, draft_id, permission=Perm.PROJECT_READ, lock=False):
    user = current_actor(user)
    query = ProposalDraft.objects.select_related("interpretation")
    draft = (query.select_for_update(of=("self",)) if lock else query).filter(id=draft_id).first()
    if draft is None:
        raise NotFound("Proposal draft not found.")
    authorize(user, draft.project_id, permission)
    board_report(user, draft.project_id, draft.interpretation_id)
    return draft


def compute(user, project_id, interpretation_id, parameters: Parameters):
    interpretation, report = board_report(user, project_id, interpretation_id)
    try:
        proposal = generate(report, parameters)
    except UnknownReference as exc:
        raise ValidationFailed(str(exc)) from None
    proposal["board"] = {
        "interpretation_id": str(interpretation.id),
        "interpretation_sha256": interpretation.sha256,
        "source_revision_id": str(interpretation.attempt.intake.source_revision_id),
        "source_sha256": report.source_sha256,
        "adapter": report.adapter,
        "tool_version": report.tool_version,
    }
    return proposal


# ---------------------------------------------------------------- views


def draft_view(user, draft):
    parameters = Parameters.model_validate(draft.parameters)
    return {
        "draft_id": str(draft.id),
        "project_id": str(draft.project_id),
        "interpretation_id": str(draft.interpretation_id),
        "name": draft.name,
        "parameters": parameters.model_dump(mode="json"),
        "version": draft.version,
        "state": state_token(draft),
        "created_by_id": draft.created_by_id,
        "updated_by_id": draft.updated_by_id,
        "created_at": draft.created_at.isoformat(),
        "updated_at": draft.updated_at.isoformat(),
        "proposal": compute(user, draft.project_id, draft.interpretation_id, parameters),
        "revisions": [
            {"revision_id": str(r.id), "number": r.number, "sha256": r.sha256, "status": r.status}
            for r in draft.revisions.order_by("number")
        ],
    }


def revision_record(user, revision_id, project_id=None):
    user = current_actor(user)
    query = ProposalRevision.objects.select_related("interpretation")
    revision = query.filter(id=revision_id).first()
    if revision is None or (project_id is not None and str(revision.project_id) != str(project_id)):
        raise NotFound("Retained proposal not found.")
    authorize(user, revision.project_id, Perm.PROJECT_READ)
    board_report(user, revision.project_id, revision.interpretation_id)
    data = bytes(revision.canonical)
    if hashlib.sha256(data).hexdigest() != revision.sha256:
        raise ValidationFailed("Retained proposal integrity check failed.")
    return revision


def revision_view(revision, with_proposal=True):
    view = {
        "revision_id": str(revision.id),
        "draft_id": str(revision.draft_id),
        "project_id": str(revision.project_id),
        "number": revision.number,
        "interpretation_id": str(revision.interpretation_id),
        "interpretation_sha256": revision.interpretation_sha256,
        "generator": revision.generator,
        "draft_version": revision.draft_version,
        "status": revision.status,
        "sha256": revision.sha256,
        "created_at": revision.created_at.isoformat(),
    }
    if with_proposal:
        view["document"] = json.loads(bytes(revision.canonical))
    return view


# ---------------------------------------------------------------- operations


def create_scope(ctx, p: CreateProposal):
    user = current_actor(ctx.user)
    scope = project_scope(ctx, p.project_id, Perm.DESIGN_EDIT)
    board_report(user, p.project_id, p.interpretation_id)
    return scope


def draft_scope(ctx, p):
    draft = authorized_draft(ctx.user, p.draft_id, Perm.DESIGN_EDIT)
    return f"project:{draft.project_id}"


def create_replay(ctx, p, stored):
    create_scope(ctx, p)
    authorized_draft(ctx.user, stored["draft_id"], Perm.DESIGN_EDIT)


def draft_replay(ctx, p, stored):
    authorized_draft(ctx.user, p.draft_id, Perm.DESIGN_EDIT)
    if "revision_id" in stored:
        revision_record(ctx.user, stored["revision_id"], stored["project_id"])


@operation(
    "mechanical_proposal.create",
    CreateProposal,
    summary="Create a reviewable parametric proposal draft for one accepted board, "
    "with unknown inputs kept explicit.",
    idempotency_scope=create_scope,
    authorize_replay=create_replay,
)
def create(ctx: Context, p: CreateProposal):
    user = current_actor(ctx.user)
    authorize(user, p.project_id, Perm.DESIGN_EDIT)
    compute(user, p.project_id, p.interpretation_id, p.parameters)  # validates references
    draft = ProposalDraft.objects.create(
        project_id=p.project_id,
        interpretation_id=p.interpretation_id,
        name=p.name,
        parameters=p.parameters.model_dump(mode="json"),
        created_by=user,
        updated_by=user,
    )
    return draft_view(user, draft)


@operation(
    "mechanical_proposal.update",
    UpdateProposal,
    summary="Replace a proposal draft's declared parameters under compare-and-set.",
    requires_expected_state=True,
    idempotency_scope=draft_scope,
    authorize_replay=draft_replay,
)
def update(ctx: Context, p: UpdateProposal):
    user = current_actor(ctx.user)
    draft = authorized_draft(user, p.draft_id, Perm.DESIGN_EDIT, lock=True)
    if ctx.require_expected_state() != state_token(draft):
        raise Conflict(
            "Proposal draft changed since it was read; nothing was saved.",
            details={"current_state": state_token(draft), "version": draft.version},
        )
    compute(user, draft.project_id, draft.interpretation_id, p.parameters)
    draft.parameters = p.parameters.model_dump(mode="json")
    if p.name is not None:
        draft.name = p.name
    draft.version += 1
    draft.updated_by = user
    draft.save()
    return draft_view(user, draft)


@operation(
    "mechanical_proposal.retain",
    RetainProposal,
    summary="Retain the exact current proposal as an immutable derived record, "
    "incomplete or not. Edits no design state.",
    requires_expected_state=True,
    idempotency_scope=draft_scope,
    authorize_replay=draft_replay,
)
def retain(ctx: Context, p: RetainProposal):
    user = current_actor(ctx.user)
    draft = authorized_draft(user, p.draft_id, Perm.DESIGN_EDIT, lock=True)
    if ctx.require_expected_state() != state_token(draft):
        raise Conflict(
            "Proposal draft changed since it was read; nothing was retained.",
            details={"current_state": state_token(draft), "version": draft.version},
        )
    parameters = Parameters.model_validate(draft.parameters)
    proposal = compute(user, draft.project_id, draft.interpretation_id, parameters)
    document = {
        "draft_id": str(draft.id),
        "draft_name": draft.name,
        "draft_version": draft.version,
        "parameters": parameters.model_dump(mode="json"),
        "proposal": proposal,
    }
    data = canonical_bytes(document)
    digest = hashlib.sha256(data).hexdigest()
    existing = draft.revisions.filter(sha256=digest).first()
    if existing is not None:
        return revision_view(revision_record(user, existing.id), with_proposal=False)
    number = (draft.revisions.order_by("-number").values_list("number", flat=True).first() or 0) + 1
    try:
        with transaction.atomic():
            revision = ProposalRevision.objects.create(
                draft=draft,
                project_id=draft.project_id,
                number=number,
                interpretation=draft.interpretation,
                interpretation_sha256=draft.interpretation.sha256,
                generator=GENERATOR,
                draft_version=draft.version,
                status=proposal["status"],
                canonical=data,
                sha256=digest,
                created_by=user,
                request_id=ctx.request_id,
            )
    except IntegrityError:
        raise Conflict("A concurrent retention won; read the draft again.") from None
    return revision_view(revision_record(user, revision.id), with_proposal=False)


@operation(
    "mechanical_proposal.read",
    DraftRef,
    summary="Read a proposal draft and its freshly generated proposal after current "
    "board-source authority.",
    supports_idempotency=False,
)
def read(ctx: Context, p: DraftRef):
    user = current_actor(ctx.user)
    return draft_view(user, authorized_draft(user, p.draft_id))


@operation(
    "mechanical_proposal.read_retained",
    RetainedRef,
    summary="Read an immutable retained proposal under fresh authority and integrity checks.",
    supports_idempotency=False,
)
def read_retained(ctx: Context, p: RetainedRef):
    return revision_view(revision_record(ctx.user, p.revision_id, p.project_id))


@operation(
    "mechanical_proposal.list",
    ListProposals,
    summary="List proposal drafts in a project, fully reauthorized before names escape.",
    supports_idempotency=False,
)
def list_proposals(ctx: Context, p: ListProposals):
    user = current_actor(ctx.user)
    authorize(user, p.project_id, Perm.PROJECT_READ)
    drafts = list(
        ProposalDraft.objects.filter(project_id=p.project_id).order_by("-created_at", "id")[
            : LIST_LIMIT + 1
        ]
    )
    for draft in drafts[:LIST_LIMIT]:
        board_report(user, draft.project_id, draft.interpretation_id)
    return {
        "truncated": len(drafts) > LIST_LIMIT,
        "drafts": [
            {
                "draft_id": str(d.id),
                "name": d.name,
                "interpretation_id": str(d.interpretation_id),
                "version": d.version,
                "state": state_token(d),
                "updated_at": d.updated_at.isoformat(),
                "revision_count": d.revisions.count(),
            }
            for d in drafts[:LIST_LIMIT]
        ],
    }


@operation(
    "mechanical_proposal.board_choices",
    ListProposals,
    summary="List accepted board interpretations that can drive a proposal in a project.",
    supports_idempotency=False,
)
def board_choices(ctx: Context, p: ListProposals):
    user = current_actor(ctx.user)
    authorize(user, p.project_id, Perm.PROJECT_READ)
    rows = []
    query = PcbInterpretation.objects.select_related("attempt__intake__source_revision").filter(
        attempt__intake__source_revision__bundle__project_id=p.project_id
    )
    for interpretation in query.order_by("-created_at", "id")[:LIST_LIMIT]:
        _, report = board_report(user, p.project_id, interpretation.id)
        rows.append(
            {
                "interpretation_id": str(interpretation.id),
                "sha256": interpretation.sha256,
                "board_path": interpretation.attempt.intake.board_path,
                "source_revision_id": str(interpretation.attempt.intake.source_revision_id),
                "outline": "closed-line-polygons" if report.outline else "unavailable",
                "hole_candidates": len(report.mounting_holes),
                "components": len(report.components),
            }
        )
    return {"boards": rows}


@operation(
    "mechanical_proposal.board_inputs",
    BoardInputs,
    summary="Native identities (holes, components) of one accepted board that proposals may "
    "reference. Labels are display text only.",
    supports_idempotency=False,
)
def board_inputs(ctx: Context, p: BoardInputs):
    user = current_actor(ctx.user)
    interpretation, report = board_report(user, p.project_id, p.interpretation_id)
    return {
        "interpretation_id": str(interpretation.id),
        "sha256": interpretation.sha256,
        "units": report.units,
        "frame": report.coordinate_frame,
        "outline_polygons": len(report.outline),
        "cutouts": len(report.cutouts),
        "holes": [
            {
                "pad_id": str(h.pad_id),
                "position": list(h.position),
                "drill": list(h.drill),
                "mounting_status": h.mounting_status,
            }
            for h in sorted(report.mounting_holes, key=lambda h: str(h.pad_id))
        ],
        "components": [
            {
                "component_id": str(c.id),
                "reference": c.reference,
                "value": c.value,
                "footprint": c.footprint,
                "position": list(c.position),
                "side": c.side,
            }
            for c in sorted(report.components, key=lambda c: str(c.id))[:500]
        ],
    }
