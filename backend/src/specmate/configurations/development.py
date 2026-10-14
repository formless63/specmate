"""Development proposals linked to otherwise unmet configuration rules (CFG-003).

A configuration whose declared rules evaluate invalid or unknown may carry linked
development proposals: an existing mechanical (enclosure) proposal, or a lightweight
`development_need` definition describing adapter-board, cable or enclosure work. Both are
workspace items; projects reference a need like any other definition. A link names the
failing rule key, the exact option-set revision and the outcome observed when it was made.

A proposal never changes an outcome. Resolution, capture and `configuration.build_input`
read only the design and its declared rules; links are reported beside them as
`invalid_with_proposal` / `unknown_with_proposal`. An invalid configuration stays refused
as build input until the design itself changes and its rules evaluate valid.
"""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from django.db import IntegrityError, transaction
from django.utils import timezone
from pydantic import Field, ValidationError, model_validator

from specmate.access.permissions import Perm, authorize, authorize_item
from specmate.assemblies.contracts import StrictModel
from specmate.configurations.contracts import Basis, Text
from specmate.configurations.models import DevelopmentLink
from specmate.design.models import Definition, Draft, Revision
from specmate.operations import (
    Conflict,
    Context,
    NotFound,
    PermissionDenied,
    ValidationFailed,
    operation,
)

KIND = "development_need"
KEY = "development_need"
NEEDS = ("adapter_board", "cable", "enclosure")
FAILING = ("invalid", "unknown")
LIST_LIMIT = 200
NOTE = (
    "Linked proposals are development intent. They never change a rule outcome, the "
    "resolution or build eligibility; only a changed design that evaluates valid does."
)

RuleKey = Annotated[str, Field(min_length=1, max_length=200, pattern=r"^[a-z][a-z0-9_-]*$")]
Need = Literal["adapter_board", "cable", "enclosure"]


# ---------------------------------------------------------------- need definitions


class DevelopmentNeed(StrictModel):
    """Typed content of a `development_need` definition. Never physical qualification."""

    schema_version: Literal["0.1"] = "0.1"
    need: Need
    summary: Text
    description: str = Field(default="", max_length=4000)
    physical_qualification: Literal[False] = False


def parse_need(kind, content):
    if kind == KIND and set(content) != {KEY}:
        raise ValidationFailed("A development need definition holds only its need record.")
    if KEY not in content:
        return None
    if kind != KIND:
        raise ValidationFailed("Development need content requires a development_need definition.")
    try:
        return DevelopmentNeed.model_validate(content[KEY])
    except ValidationError:
        raise ValidationFailed("Invalid development need.") from None


def validate_content(kind, content):
    need = parse_need(kind, content)
    return {KEY: need.model_dump(mode="json")} if need else content


# ---------------------------------------------------------------- payloads


class NeedTarget(StrictModel):
    kind: Literal["development_need"]
    definition_id: UUID


class MechanicalTarget(StrictModel):
    kind: Literal["mechanical_proposal"]
    proposal_draft_id: UUID


Target = Annotated[NeedTarget | MechanicalTarget, Field(discriminator="kind")]


class LinkDevelopment(StrictModel):
    """Link an existing proposal to one invalid or unknown rule of a configuration draft."""

    draft_id: UUID
    rule_key: RuleKey
    target: Target
    basis: Basis


class ProposeDevelopment(StrictModel):
    """Create a development need in the workspace library and link it to one failing rule."""

    draft_id: UUID
    rule_key: RuleKey
    need: Need
    name: str = Field(min_length=1, max_length=200, pattern=r"\S")
    summary: Text
    description: str = Field(default="", max_length=4000)
    basis: Basis


class UnlinkDevelopment(StrictModel):
    link_id: UUID
    reason: str = Field(min_length=1, max_length=1000, pattern=r"\S")


class ListDevelopment(StrictModel):
    """Links of a workspace, optionally only those of one configuration or one proposal."""

    workspace_id: UUID
    configuration_definition_id: UUID | None = None
    need_definition_id: UUID | None = None
    proposal_draft_id: UUID | None = None
    include_removed: bool = False

    @model_validator(mode="after")
    def one_filter(self):
        filters = [
            self.configuration_definition_id,
            self.need_definition_id,
            self.proposal_draft_id,
        ]
        if sum(value is not None for value in filters) > 1:
            raise ValueError("Filter by at most one configuration or proposal.")
        return self


# ---------------------------------------------------------------- views


def need_view(user, definition):
    authorize_item(user, definition, Perm.WORKSPACE_READ)
    draft = Draft.objects.filter(definition=definition).order_by("-updated_at", "id").first()
    content = (draft.content.get(KEY) if draft else None) or {}
    latest = Revision.objects.filter(definition=definition).order_by("-number").first()
    return {
        "kind": "development_need",
        "readable": True,
        "definition_id": str(definition.id),
        "name": definition.name,
        "need": content.get("need"),
        "summary": content.get("summary"),
        "draft_id": str(draft.id) if draft else None,
        "latest_revision": latest.number if latest else None,
        "physical_qualification": False,
    }


def mechanical_view(user, proposal_draft_id):
    from specmate.mechanical_proposals.operations import authorized_draft

    try:
        draft = authorized_draft(user, proposal_draft_id)
    except (NotFound, PermissionDenied, ValidationFailed):
        # Fresh board-source authority is required; an unreadable proposal shows no name.
        return {
            "kind": "mechanical_proposal",
            "readable": False,
            "proposal_draft_id": str(proposal_draft_id),
        }
    latest = draft.revisions.order_by("-number").first()
    decision = latest.decisions.order_by("-version").first() if latest else None
    return {
        "kind": "mechanical_proposal",
        "readable": True,
        "proposal_draft_id": str(draft.id),
        "name": draft.name,
        "need": "enclosure",
        "latest_retained": (
            {"revision_id": str(latest.id), "number": latest.number, "status": latest.status}
            if latest
            else None
        ),
        "current_decision": decision.decision if decision else None,
        "physical_qualification": False,
    }


def target_view(user, link):
    if link.need_id is not None:
        return need_view(user, link.need)
    return mechanical_view(user, link.mechanical_proposal_id)


def may_unlink(user, link):
    """Presentation hint mirroring `unlink_development`; the operation still decides."""
    try:
        authorize_item(user, link, Perm.DESIGN_EDIT)
    except (NotFound, PermissionDenied):
        return False
    return link.removed_at is None


def link_view(user, link, current=None):
    view = {
        "link_id": str(link.id),
        "workspace_id": str(link.workspace_id),
        "configuration_definition_id": str(link.configuration_id),
        "rule_key": link.rule_key,
        "option_set_revision_id": str(link.option_set_revision_id),
        "observed_outcome": link.observed_outcome,
        "target": target_view(user, link),
        "basis": link.basis,
        "created_by": link.created_by.get_username(),
        "created_at": link.created_at.isoformat(),
        "removed": link.removed_at is not None,
        "removed_at": link.removed_at.isoformat() if link.removed_at else None,
        "removal_reason": link.removal_reason,
        "can_unlink": may_unlink(user, link),
    }
    if current is not None:
        view["current_outcome"] = current
    return view


def development_view(user, configuration_id, constraints):
    """Current linked proposals beside one evaluated resolution; never part of it.

    `outcome` is `invalid_with_proposal` / `unknown_with_proposal` only when a proposal is
    linked to a rule that currently has that outcome; otherwise it is the constraint
    outcome unchanged. A link to a rule the evaluated option set no longer declares
    reports `absent`.
    """
    evaluated = constraints if isinstance(constraints, dict) else None
    overall = evaluated["outcome"] if evaluated else "not_evaluated"
    outcomes = {r["key"]: r["outcome"] for r in evaluated["results"]} if evaluated else {}
    links = (
        DevelopmentLink.objects.select_related("need", "created_by")
        .filter(configuration_id=configuration_id, removed_at__isnull=True)
        .order_by("created_at", "id")
    )
    entries = [link_view(user, link, outcomes.get(link.rule_key, "absent")) for link in links]
    proposed = {entry["current_outcome"] for entry in entries}
    outcome = f"{overall}_with_proposal" if overall in FAILING and overall in proposed else overall
    return {
        "constraint_outcome": overall,
        "outcome": outcome,
        "links": entries,
        "note": NOTE,
    }


# ---------------------------------------------------------------- shared checks


def failing_rule(ctx, draft, rule_key):
    """The current outcome of one declared rule; only invalid or unknown may be linked."""
    from specmate.configurations.operations import preview

    resolution = preview(ctx, draft)["resolution"]
    constraints = resolution.get("constraints")
    rule = next((r for r in constraints["results"] if r["key"] == rule_key), None)
    if rule is None:
        raise ValidationFailed("The configuration's option set does not evaluate this rule.")
    if rule["outcome"] not in FAILING:
        raise ValidationFailed(
            "Only an invalid or unknown rule can carry a development proposal.",
            details={"outcome": rule["outcome"]},
        )
    return resolution["option_set"]["revision_id"], rule["outcome"]


def configuration_scope(ctx, draft_id, permission):
    from specmate.configurations.operations import configuration_draft

    draft = configuration_draft(ctx, draft_id)
    authorize(ctx.user, draft.definition.workspace_id, permission)
    return draft


def link_scope(ctx, p):
    draft = configuration_scope(ctx, p.draft_id, Perm.ITEM_CREATE)
    return f"workspace:{draft.definition.workspace_id}"


def stored_link(ctx, link_id):
    link = DevelopmentLink.objects.select_related("need", "created_by").filter(id=link_id).first()
    if link is None:
        raise NotFound("Development link not found.")
    authorize(ctx.user, link.workspace_id, Perm.WORKSPACE_READ)
    return link


def link_replay(ctx, p, stored):
    configuration_scope(ctx, p.draft_id, Perm.ITEM_CREATE)
    link = stored_link(ctx, stored["link_id"])
    target_view(ctx.user, link)


def need_target(ctx, workspace_id, definition_id):
    definition = Definition.objects.filter(id=definition_id).first()
    if definition is None or definition.workspace_id != workspace_id:
        raise NotFound("Development need not found.")
    authorize_item(ctx.user, definition, Perm.WORKSPACE_READ)
    if definition.kind != KIND:
        raise ValidationFailed("Link a development_need definition or a mechanical proposal.")
    return definition


def mechanical_target(ctx, workspace_id, proposal_draft_id):
    from specmate.mechanical_proposals.operations import authorized_draft

    draft = authorized_draft(ctx.user, proposal_draft_id)
    if draft.workspace_id != workspace_id:
        raise NotFound("Proposal draft not found.")
    return draft


def create_link(ctx, draft, rule_key, basis, *, need=None, proposal=None):
    option_set_revision_id, observed = failing_rule(ctx, draft, rule_key)
    try:
        with transaction.atomic():
            link = DevelopmentLink.objects.create(
                workspace_id=draft.definition.workspace_id,
                configuration=draft.definition,
                option_set_revision_id=option_set_revision_id,
                rule_key=rule_key,
                observed_outcome=observed,
                target="development_need" if need is not None else "mechanical_proposal",
                need=need,
                mechanical_proposal=proposal,
                basis=basis.strip(),
                created_by=ctx.user,
                request_id=ctx.request_id,
            )
    except IntegrityError:
        raise Conflict("This proposal is already linked to this rule.") from None
    link = DevelopmentLink.objects.select_related("need", "created_by").get(id=link.id)
    return link_view(ctx.user, link, observed)


# ---------------------------------------------------------------- operations


@operation(
    "configuration.link_development",
    LinkDevelopment,
    summary="Link an existing development need or mechanical proposal to one invalid or "
    "unknown rule of a configuration. The outcome and build eligibility are unchanged.",
    idempotency_scope=link_scope,
    authorize_replay=link_replay,
    access=Perm.ITEM_CREATE,
)
def link_development(ctx: Context, p: LinkDevelopment):
    draft = configuration_scope(ctx, p.draft_id, Perm.ITEM_CREATE)
    workspace_id = draft.definition.workspace_id
    if p.target.kind == "development_need":
        need = need_target(ctx, workspace_id, p.target.definition_id)
        return create_link(ctx, draft, p.rule_key, p.basis, need=need)
    proposal = mechanical_target(ctx, workspace_id, p.target.proposal_draft_id)
    return create_link(ctx, draft, p.rule_key, p.basis, proposal=proposal)


@operation(
    "configuration.propose_development",
    ProposeDevelopment,
    summary="Create an adapter-board, cable or enclosure development need in the workspace "
    "library and link it to one invalid or unknown rule. Nothing becomes valid.",
    idempotency_scope=link_scope,
    authorize_replay=link_replay,
    access=Perm.ITEM_CREATE,
)
def propose_development(ctx: Context, p: ProposeDevelopment):
    from specmate.design.operations import CreateDefinition, create_definition

    draft = configuration_scope(ctx, p.draft_id, Perm.ITEM_CREATE)
    # Refuse a passing or undeclared rule before anything is created.
    failing_rule(ctx, draft, p.rule_key)
    created = create_definition(
        ctx,
        CreateDefinition(
            workspace_id=draft.definition.workspace_id,
            kind=KIND,
            name=p.name.strip(),
            content={
                KEY: {
                    "need": p.need,
                    "summary": p.summary,
                    "description": p.description,
                    "physical_qualification": False,
                }
            },
        ),
    )
    need = Definition.objects.get(id=created["definition_id"])
    return {
        **create_link(ctx, draft, p.rule_key, p.basis, need=need),
        "need_draft": {"draft_id": created["draft_id"], "state": created["state"]},
    }


def unlink_scope(ctx, p):
    link = stored_link(ctx, p.link_id)
    authorize_item(ctx.user, link, Perm.DESIGN_EDIT)
    return f"workspace:{link.workspace_id}"


def unlink_replay(ctx, p, stored):
    unlink_scope(ctx, p)


@operation(
    "configuration.unlink_development",
    UnlinkDevelopment,
    summary="Record the removal of a development link with a reason; the proposal itself "
    "and every outcome are unchanged.",
    idempotency_scope=unlink_scope,
    authorize_replay=unlink_replay,
    access=Perm.ITEM_CREATE,
)
def unlink_development(ctx: Context, p: UnlinkDevelopment):
    link = stored_link(ctx, p.link_id)
    # The creator (with item.create) or a design editor may remove a link.
    authorize_item(ctx.user, link, Perm.DESIGN_EDIT)
    rows = DevelopmentLink.objects.select_for_update(of=("self",))
    link = rows.select_related("need", "created_by").get(id=p.link_id)
    if link.removed_at is not None:
        raise Conflict("This development link was already removed.")
    link.removed_at, link.removed_by, link.removal_reason = timezone.now(), ctx.user, p.reason
    link.save(update_fields=["removed_at", "removed_by", "removal_reason"])
    return link_view(ctx.user, link)


@operation(
    "configuration.list_development",
    ListDevelopment,
    summary="List development links of a workspace, one configuration or one proposal.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def list_development(ctx: Context, p: ListDevelopment):
    workspace = authorize(ctx.user, p.workspace_id, Perm.WORKSPACE_READ)
    rows = DevelopmentLink.objects.select_related("need", "created_by", "configuration").filter(
        workspace=workspace
    )
    if p.configuration_definition_id is not None:
        rows = rows.filter(configuration_id=p.configuration_definition_id)
    if p.need_definition_id is not None:
        rows = rows.filter(need_id=p.need_definition_id)
    if p.proposal_draft_id is not None:
        rows = rows.filter(mechanical_proposal_id=p.proposal_draft_id)
    if not p.include_removed:
        rows = rows.filter(removed_at__isnull=True)
    rows = list(rows.order_by("-created_at", "-id")[: LIST_LIMIT + 1])
    return {
        "workspace_id": str(workspace.id),
        "links": [
            {**link_view(ctx.user, link), "configuration_name": link.configuration.name}
            for link in rows[:LIST_LIMIT]
        ],
        "truncated": len(rows) > LIST_LIMIT,
    }
