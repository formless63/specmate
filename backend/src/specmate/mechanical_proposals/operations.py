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

from specmate.access.permissions import Perm, authorize, authorize_item
from specmate.catalog_matching.queries import current_actor
from specmate.design.models import Draft
from specmate.design.operations import CreateDefinition, create_definition, scoped_draft
from specmate.mechanical_proposals.adoption import KEY as ADOPTION_KEY
from specmate.mechanical_proposals.adoption import KIND as ADOPTION_KIND
from specmate.mechanical_proposals.contracts import (
    GENERATOR,
    BoardInputs,
    CreateProposal,
    DecideProposal,
    DraftRef,
    ListProposals,
    Parameters,
    RetainedRef,
    RetainProposal,
    UpdateProposal,
)
from specmate.mechanical_proposals.generators import UnknownReference, generate
from specmate.mechanical_proposals.models import (
    ProposalDecision,
    ProposalDraft,
    ProposalRevision,
)
from specmate.operations import (
    Conflict,
    Context,
    NotFound,
    PermissionDenied,
    ValidationFailed,
    operation,
)
from specmate.operations.scope import workspace_scope
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


def board_report(user, workspace_id, interpretation_id):
    """Fresh authority over the exact accepted board interpretation, then its report."""
    workspace_id = authorize(user, workspace_id, Perm.WORKSPACE_READ).id
    interpretation = scoped_interpretation(user, workspace_id, interpretation_id)
    authorize_revision(user, interpretation.attempt.intake.source_revision, Perm.WORKSPACE_READ)
    try:
        report = Report.model_validate_json(bytes(interpretation.canonical))
    except PydanticValidationError:
        raise ValidationFailed("Accepted board report is invalid.") from None
    if hashlib.sha256(bytes(interpretation.canonical)).hexdigest() != interpretation.sha256:
        raise ValidationFailed("Accepted board report integrity check failed.")
    return interpretation, report


def authorized_draft(user, draft_id, permission=Perm.WORKSPACE_READ, lock=False):
    user = current_actor(user)
    query = ProposalDraft.objects.select_related("interpretation")
    draft = (query.select_for_update(of=("self",)) if lock else query).filter(id=draft_id).first()
    if draft is None:
        raise NotFound("Proposal draft not found.")
    # Contributors may edit drafts they created; every other permission is role-held.
    authorize_item(user, draft, permission)
    board_report(user, draft.workspace_id, draft.interpretation_id)
    return draft


def compute(user, workspace_id, interpretation_id, parameters: Parameters):
    interpretation, report = board_report(user, workspace_id, interpretation_id)
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
        "workspace_id": str(draft.workspace_id),
        "interpretation_id": str(draft.interpretation_id),
        "name": draft.name,
        "parameters": parameters.model_dump(mode="json"),
        "version": draft.version,
        "state": state_token(draft),
        "created_by_id": draft.created_by_id,
        "updated_by_id": draft.updated_by_id,
        "created_at": draft.created_at.isoformat(),
        "updated_at": draft.updated_at.isoformat(),
        "proposal": compute(user, draft.workspace_id, draft.interpretation_id, parameters),
        "revisions": [
            {
                "revision_id": str(r.id),
                "number": r.number,
                "sha256": r.sha256,
                "status": r.status,
                "current_decision": (
                    latest.decision
                    if (latest := r.decisions.order_by("-version").first())
                    else None
                ),
            }
            for r in draft.revisions.order_by("number")
        ],
    }


def revision_record(user, revision_id, workspace_id=None):
    user = current_actor(user)
    query = ProposalRevision.objects.select_related("interpretation")
    revision = query.filter(id=revision_id).first()
    if revision is None or (
        workspace_id is not None
        and str(revision.workspace_id) != str(authorize(user, workspace_id, Perm.WORKSPACE_READ).id)
    ):
        raise NotFound("Retained proposal not found.")
    authorize(user, revision.workspace_id, Perm.WORKSPACE_READ)
    board_report(user, revision.workspace_id, revision.interpretation_id)
    data = bytes(revision.canonical)
    if hashlib.sha256(data).hexdigest() != revision.sha256:
        raise ValidationFailed("Retained proposal integrity check failed.")
    return revision


def decision_state(decisions) -> str:
    return f"decision-v{len(decisions)}"


def decision_view(decision):
    return {
        "decision_id": str(decision.id),
        "revision_id": str(decision.revision_id),
        "version": decision.version,
        "decision": decision.decision,
        "reason": decision.reason,
        "link_mode": decision.link_mode or None,
        "definition_id": str(decision.linked_definition_id)
        if decision.linked_definition_id
        else None,
        "draft_id": str(decision.linked_draft_id) if decision.linked_draft_id else None,
        "decided_by_id": decision.decided_by_id,
        "created_at": decision.created_at.isoformat(),
    }


def decisions_view(revision):
    decisions = list(revision.decisions.order_by("version"))
    return {
        "decision_state": decision_state(decisions),
        "current_decision": decision_view(decisions[-1]) if decisions else None,
        "decisions": [decision_view(d) for d in decisions],
    }


def revision_view(revision, with_proposal=True):
    view = {
        "revision_id": str(revision.id),
        "draft_id": str(revision.draft_id),
        "workspace_id": str(revision.workspace_id),
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
        view.update(decisions_view(revision))
    return view


# ---------------------------------------------------------------- operations


def create_scope(ctx, p: CreateProposal):
    user = current_actor(ctx.user)
    scope = workspace_scope(ctx, p.workspace_id, Perm.ITEM_CREATE)
    board_report(user, scope.removeprefix("workspace:"), p.interpretation_id)
    return scope


def draft_scope(ctx, p):
    draft = authorized_draft(ctx.user, p.draft_id, Perm.DESIGN_EDIT)
    return f"workspace:{draft.workspace_id}"


def create_replay(ctx, p, stored):
    create_scope(ctx, p)
    authorized_draft(ctx.user, stored["draft_id"], Perm.WORKSPACE_READ)


def draft_replay(ctx, p, stored):
    authorized_draft(ctx.user, p.draft_id, Perm.DESIGN_EDIT)
    if "revision_id" in stored:
        revision_record(ctx.user, stored["revision_id"], stored["workspace_id"])


@operation(
    "mechanical_proposal.create",
    CreateProposal,
    summary="Create a reviewable parametric proposal draft for one accepted board, "
    "with unknown inputs kept explicit.",
    idempotency_scope=create_scope,
    authorize_replay=create_replay,
    access=Perm.ITEM_CREATE,
)
def create(ctx: Context, p: CreateProposal):
    user = current_actor(ctx.user)
    workspace = authorize(user, p.workspace_id, Perm.ITEM_CREATE)
    compute(user, workspace.id, p.interpretation_id, p.parameters)  # validates references
    draft = ProposalDraft.objects.create(
        workspace=workspace,
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
    access=Perm.DESIGN_EDIT,
)
def update(ctx: Context, p: UpdateProposal):
    user = current_actor(ctx.user)
    draft = authorized_draft(user, p.draft_id, Perm.DESIGN_EDIT, lock=True)
    if ctx.require_expected_state() != state_token(draft):
        raise Conflict(
            "Proposal draft changed since it was read; nothing was saved.",
            details={"current_state": state_token(draft), "version": draft.version},
        )
    compute(user, draft.workspace_id, draft.interpretation_id, p.parameters)
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
    access=Perm.DESIGN_EDIT,
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
    proposal = compute(user, draft.workspace_id, draft.interpretation_id, parameters)
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
                workspace_id=draft.workspace_id,
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
    access=Perm.WORKSPACE_READ,
)
def read(ctx: Context, p: DraftRef):
    user = current_actor(ctx.user)
    return draft_view(user, authorized_draft(user, p.draft_id))


@operation(
    "mechanical_proposal.read_retained",
    RetainedRef,
    summary="Read an immutable retained proposal under fresh authority and integrity checks.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def read_retained(ctx: Context, p: RetainedRef):
    return revision_view(revision_record(ctx.user, p.revision_id, p.workspace_id))


@operation(
    "mechanical_proposal.list",
    ListProposals,
    summary="List proposal drafts in a workspace, reauthorized before names escape.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def list_proposals(ctx: Context, p: ListProposals):
    user = current_actor(ctx.user)
    workspace = authorize(user, p.workspace_id, Perm.WORKSPACE_READ)
    drafts = list(
        ProposalDraft.objects.filter(workspace=workspace).order_by("-created_at", "id")[
            : LIST_LIMIT + 1
        ]
    )
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
    summary="List accepted board interpretations that can drive a proposal in a workspace.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def board_choices(ctx: Context, p: ListProposals):
    user = current_actor(ctx.user)
    workspace = authorize(user, p.workspace_id, Perm.WORKSPACE_READ)
    rows = []
    query = PcbInterpretation.objects.select_related("attempt__intake__source_revision").filter(
        attempt__intake__source_revision__bundle__workspace=workspace
    )
    for interpretation in query.order_by("-created_at", "id")[:LIST_LIMIT]:
        _, report = board_report(user, workspace.id, interpretation.id)
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
    access=Perm.WORKSPACE_READ,
)
def board_inputs(ctx: Context, p: BoardInputs):
    user = current_actor(ctx.user)
    interpretation, report = board_report(user, p.workspace_id, p.interpretation_id)
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


# ---------------------------------------------------------------- review decisions


def decide_scope(ctx, p: DecideProposal):
    user = current_actor(ctx.user)
    revision = revision_record(user, p.revision_id)
    return workspace_scope(ctx, revision.workspace_id, Perm.DESIGN_EDIT)


def decide_replay(ctx, p, stored):
    user = current_actor(ctx.user)
    authorize(user, stored["workspace_id"], Perm.DESIGN_EDIT)
    revision_record(user, p.revision_id, stored["workspace_id"])


def linked_draft(ctx, workspace_id, draft_id):
    """An existing design draft of this workspace; only referenced, never edited."""
    draft = scoped_draft(ctx, draft_id, Perm.DESIGN_EDIT)
    if str(draft.definition.workspace_id) != str(workspace_id):
        raise NotFound("Draft not found.")
    return draft


@operation(
    "mechanical_proposal.decide",
    DecideProposal,
    summary="Append an accept, reject or defer decision with a reason on a retained proposal. "
    "Acceptance creates a design draft or links an existing one; the retained record and any "
    "frozen item stay unchanged.",
    requires_expected_state=True,
    idempotency_scope=decide_scope,
    authorize_replay=decide_replay,
)
def decide(ctx: Context, p: DecideProposal):
    user = current_actor(ctx.user)
    revision = revision_record(user, p.revision_id)
    authorize(user, revision.workspace_id, Perm.DESIGN_EDIT)
    # Serialize concurrent decisions on this retained record.
    ProposalRevision.objects.select_for_update().filter(id=revision.id).first()
    decisions = list(revision.decisions.order_by("version"))
    if ctx.require_expected_state() != decision_state(decisions):
        raise Conflict(
            "Review decisions changed since they were read; nothing was recorded.",
            details={"current_state": decision_state(decisions)},
        )
    if decisions and decisions[-1].decision == "accepted":
        raise Conflict("An accepted proposal is final; its draft already exists.")
    definition = draft = None
    mode = ""
    if p.decision == "accepted":
        if p.link_draft_id is not None:
            draft = linked_draft(ctx, revision.workspace_id, p.link_draft_id)
            definition = draft.definition
            mode = "linked"
        else:
            authorize(user, revision.workspace_id, Perm.ITEM_CREATE)
            created = create_definition(
                ctx,
                CreateDefinition(
                    workspace_id=revision.workspace_id,
                    kind=ADOPTION_KIND,
                    name=p.draft_name,
                    content={
                        ADOPTION_KEY: {
                            "retained_proposal_id": str(revision.id),
                            "retained_sha256": revision.sha256,
                            "proposal_draft_id": str(revision.draft_id),
                            "interpretation_id": str(revision.interpretation_id),
                            "interpretation_sha256": revision.interpretation_sha256,
                            "generator": revision.generator,
                            "status": revision.status,
                            "physical_qualification": False,
                        }
                    },
                ),
            )
            draft = Draft.objects.select_related("definition").get(id=created["draft_id"])
            definition = draft.definition
            mode = "created"
    decision = ProposalDecision.objects.create(
        revision=revision,
        workspace_id=revision.workspace_id,
        version=len(decisions) + 1,
        decision=p.decision,
        reason=p.reason.strip(),
        linked_definition=definition,
        linked_draft=draft,
        link_mode=mode,
        decided_by=user,
        request_id=ctx.request_id,
    )
    return {
        "workspace_id": str(revision.workspace_id),
        "revision_id": str(revision.id),
        **decisions_view(revision),
        "recorded": decision_view(decision),
    }


@operation(
    "mechanical_proposal.draft_targets",
    ListProposals,
    summary="List existing design drafts of a workspace that an acceptance may link to.",
    supports_idempotency=False,
)
def draft_targets(ctx: Context, p: ListProposals):
    user = current_actor(ctx.user)
    workspace = authorize(user, p.workspace_id, Perm.DESIGN_EDIT)
    rows = []
    query = Draft.objects.select_related("definition").filter(definition__workspace=workspace)
    for draft in query.order_by("definition__name", "id")[: LIST_LIMIT * 2]:
        try:
            scoped_draft(
                Context(user=user, via=ctx.via, request_id=ctx.request_id),
                draft.id,
                Perm.DESIGN_EDIT,
            )
        except (NotFound, PermissionDenied):
            continue
        rows.append(
            {
                "draft_id": str(draft.id),
                "definition_id": str(draft.definition_id),
                "name": draft.definition.name,
                "kind": draft.definition.kind,
            }
        )
        if len(rows) == LIST_LIMIT:
            break
    return {"drafts": rows}
