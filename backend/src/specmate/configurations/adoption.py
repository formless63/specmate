"""Reviewed adoption of resolved occurrence choices into an owning assembly draft (CFG-001).

A captured resolution is immutable evidence; adopting it is a separate, explicit change
of an assembly draft. The review shows the exact diff, the actor confirms a review hash,
and the draft changes only under compare-and-set. Frozen revisions are never modified:
adoption either creates a new draft of the frozen target assembly or edits an explicitly
selected draft of that definition. Evidence links the draft change to the resolution.

Only decisions with established assembly semantics change a draft: a part or population
choice replaces the exact pin of a direct occurrence; a firmware choice sets the
contextual firmware pin of an occurrence path. Material/process/requirement values and
population option IDs are not assembly fields; they stay in the resolved configuration.
Compatibility between adopted pins is not evaluated here.
"""

import copy

from specmate.access.permissions import Perm, authorize_item
from specmate.assemblies.queries import Closure
from specmate.configurations.contracts import (
    AdoptionRef,
    AdoptResolution,
    AuthoringContext,
    ReviewAdoption,
)
from specmate.configurations.models import ConfigurationAdoption
from specmate.configurations.operations import resolved_result
from specmate.configurations.queries import NOT_EVALUATED, Reader, canonical, digest, pin
from specmate.design.models import Draft
from specmate.design.operations import (
    UpdateDraft,
    authorize_design_content,
    check_state,
    draft_state,
    scoped_draft,
    update_draft,
)
from specmate.design.pins import pin_workspace
from specmate.operations import Conflict, Context, NotFound, ValidationFailed, operation
from specmate.operations.models import IdempotencyRecord

CHANGES = {"replace_revision", "assign_firmware"}
HISTORY = 100


def _owner(ctx, resolution, draft_id, permission, *, lock=False):
    """The owning assembly content to change: a selected draft or the frozen target."""
    if resolution["target"] is None:
        raise ValidationFailed("This resolved configuration has no target assembly to adopt into.")
    reader = Reader(ctx.user)
    target = reader.revision(resolution["target"]["revision_id"])
    if draft_id is None:
        authorize_item(ctx.user, target.definition, permission)
        return target, None, reader.content(target), reader
    draft = scoped_draft(ctx, draft_id, permission, lock=lock)
    if draft.definition_id != target.definition_id:
        raise ValidationFailed("Select a draft of the resolution's target assembly.")
    return target, draft, draft.content, reader


def _closure(ctx, content, workspace_id):
    try:
        return Closure(ctx.user, content, kind="assembly", workspace_id=workspace_id), None
    except ValidationFailed as failure:
        return None, failure.message


def _choice(decision):
    choice = decision["choice"]
    if choice is None:
        return None
    return {
        "key": choice["key"],
        "label": choice["label"],
        "revision": choice["revision"],
        "population_option_id": choice.get("population_option_id"),
        "value": choice["value"],
    }


def _feature_bound(assembly, local_id):
    """Relationships that address features at or below one direct occurrence."""
    for relationship in assembly.get("relationships", []):
        for ref in refs_of(relationship):
            path = ref.get("path") or []
            if path and path[0] == local_id and ref.get("feature_id"):
                return True
    return False


def refs_of(relationship):
    return [
        value
        for value in relationship.values()
        if isinstance(value, dict) and value.get("kind") == "occurrence"
    ]


def _revision_row(row, decision, closure, assembly):
    path = tuple(decision["path"])
    node = closure.nodes.get(path)
    if node is None:
        return {**row, "action": "blocked", "reason": "The path does not resolve in this assembly."}
    if decision["domain"] == "population" and node.revision.definition.kind != "pcb_population":
        return {
            **row,
            "action": "blocked",
            "reason": "This path no longer addresses a board population occurrence.",
        }
    after = decision["choice"]["revision"]["revision_id"]
    note = ""
    if decision["domain"] == "population":
        note = (
            f" Population option {decision['choice']['population_option_id']} is not an"
            " assembly field; it stays in the resolved configuration."
        )
    if str(node.revision.id) == after:
        return {**row, "action": "unchanged", "reason": "Already pins this exact revision." + note}
    if len(path) > 1:
        return {
            **row,
            "action": "blocked",
            "reason": (
                "A nested occurrence belongs to its containing assembly revision; adopt the"
                " choice there and propagate the new revision."
            ),
        }
    if _feature_bound(assembly, path[0]):
        return {
            **row,
            "action": "blocked",
            "reason": (
                "Relationships address features of this occurrence; review feature"
                " correspondence through a revision upgrade proposal."
            ),
        }
    return {
        **row,
        "action": "replace_revision",
        "reason": "Replaces the exact pin of this direct occurrence." + note,
        "before": pin(node.revision),
        "display_ref": node.occurrence.display_ref,
    }


def _firmware_row(ctx, row, decision, closure, failure):
    from specmate.pcb.firmware import read_revision

    if closure is None:
        return {**row, "action": "blocked", "reason": failure}
    path = tuple(decision["path"])
    node = closure.nodes.get(path)
    if node is None:
        return {**row, "action": "blocked", "reason": "The path does not resolve in this assembly."}
    assigned = closure.assignments.get(path) or node.occurrence.assignments
    current = str(assigned.firmware_revision_id) if assigned.firmware_revision_id else None
    after = decision["choice"]["revision"]["revision_id"]
    if current == after:
        return {**row, "action": "unchanged", "reason": "Already pins this exact firmware."}
    candidate = read_revision(ctx.user, after)
    declared = candidate["content"]["firmware"]["target"]["population_revision_id"]
    if node.revision.definition.kind != "pcb_population" or declared != str(node.revision.id):
        return {
            **row,
            "action": "blocked",
            "reason": "The firmware does not declare this exact population revision as its target.",
        }
    if candidate["evaluation"]["readiness"] == "blocked":
        return {**row, "action": "blocked", "reason": "The firmware declaration is blocked."}
    reader = Reader(ctx.user)
    return {
        **row,
        "action": "assign_firmware",
        "reason": "Sets the contextual firmware pin of this occurrence.",
        "before": pin(reader.revision(current)) if current else None,
        "display_ref": node.occurrence.display_ref,
    }


def _replace(assembly, local_id, revision_id):
    for occurrence in assembly["occurrences"]:
        if occurrence["local_id"] == local_id:
            occurrence["revision_id"] = revision_id


def _assign(assembly, path, revision_id):
    records = [r for r in assembly.get("assignments", []) if r["path"] != list(path)]
    records.append({"path": list(path), "assignments": {"firmware_revision_id": revision_id}})
    assembly["assignments"] = records


def plan(ctx, p, *, permission=Perm.WORKSPACE_READ, lock=False):
    """Deterministic reviewed plan; the hash binds owner state, selection and diff."""
    row, result = resolved_result(ctx, p.resolved_configuration_id, permission=permission)
    resolution = result["resolution"]
    target, draft, before, _ = _owner(ctx, resolution, p.draft_id, permission, lock=lock)
    workspace_id = target.definition.workspace_id
    with pin_workspace(workspace_id):
        return _plan(ctx, p, row, result, target, draft, before, workspace_id)


def _plan(ctx, p, row, result, target, draft, before, workspace_id):
    resolution = result["resolution"]
    declared = {d["option_key"] for d in resolution["decisions"]}
    if p.option_keys is not None and not set(p.option_keys) <= declared:
        raise ValidationFailed("Select only options decided by this resolution.")
    closure, failure = _closure(ctx, before, workspace_id)
    if closure is None:
        raise ValidationFailed(f"The owning assembly does not resolve: {failure}")
    assembly = copy.deepcopy(before["assembly"])
    rows = {}
    revision_keys = []
    firmware = []
    for decision in resolution["decisions"]:
        base = {
            "option_key": decision["option_key"],
            "label": decision["label"],
            "domain": decision["domain"],
            "path": decision["path"],
            "decision_status": decision["status"],
            "source": decision["source"],
            "choice": _choice(decision),
            "before": None,
            "display_ref": None,
        }
        if decision["status"] != "resolved":
            rows[decision["option_key"]] = {
                **base,
                "action": "not_applicable",
                "reason": "No resolved choice to adopt.",
            }
        elif decision["domain"] in {"material", "process", "requirement"} or not decision["path"]:
            rows[decision["option_key"]] = {
                **base,
                "action": "not_applicable",
                "reason": (
                    "A configuration-level choice; assemblies do not record it. It stays in"
                    " the resolved configuration."
                ),
            }
        elif decision["domain"] in {"part", "population"}:
            rows[decision["option_key"]] = _revision_row(base, decision, closure, assembly)
            revision_keys.append(decision["option_key"])
        else:
            firmware.append((base, decision))

    def chosen(key):
        if p.option_keys is None:
            return rows[key]["action"] in CHANGES
        return key in p.option_keys

    for key in revision_keys:
        if chosen(key) and rows[key]["action"] == "replace_revision":
            item = rows[key]
            _replace(assembly, item["path"][0], item["choice"]["revision"]["revision_id"])
    middle, failure = _closure(ctx, {**before, "assembly": assembly}, workspace_id)
    for base, decision in firmware:
        key = decision["option_key"]
        rows[key] = _firmware_row(ctx, base, decision, middle, failure)
        if chosen(key) and rows[key]["action"] == "assign_firmware":
            _assign(assembly, decision["path"], decision["choice"]["revision"]["revision_id"])
    ordered = [{**rows[d["option_key"]], "selected": False} for d in resolution["decisions"]]
    for item in ordered:
        item["selected"] = chosen(item["option_key"])
    selected = [item for item in ordered if item["selected"]]
    changes = [
        {
            "option_key": item["option_key"],
            "path": item["path"],
            "display_ref": item["display_ref"],
            "field": "revision_id" if item["action"] == "replace_revision" else "firmware",
            "before": item["before"],
            "after": item["choice"]["revision"],
        }
        for item in selected
        if item["action"] in CHANGES
    ]
    after = {**before, "assembly": assembly}
    warnings = []
    final, final_failure = _closure(ctx, after, workspace_id) if changes else (closure, None)
    if final is not None and changes:
        replaced = {tuple(c["path"]) for c in changes if c["field"] == "revision_id"}
        assigned = {tuple(c["path"]) for c in changes if c["field"] == "firmware"}
        for path in sorted(final.nodes):
            node = final.nodes[path]
            kept = final.assignments.get(path) or node.occurrence.assignments
            if path[:1] in {r[:1] for r in replaced} and path not in assigned:
                if kept.firmware_revision_id:
                    warnings.append(
                        {
                            "path": list(path),
                            "message": (
                                "A retained firmware pin was reviewed against the previous"
                                " revision of this occurrence; review it again."
                            ),
                        }
                    )
    blocked = [i["option_key"] for i in selected if i["action"] in {"blocked", "not_applicable"}]
    if blocked:
        eligible, message = False, "Deselect options that cannot be adopted: " + ", ".join(blocked)
    elif final is None:
        eligible, message = False, f"The adopted assembly would not resolve: {final_failure}"
    elif not changes:
        eligible, message = False, "The selected choices do not change this assembly."
    else:
        eligible, message = True, f"{len(changes)} reviewed change(s) to the owning draft."
    body = {
        "resolved_configuration_id": result["resolved_configuration_id"],
        "resolution_sha256": result["resolution_sha256"],
        "resolution_status": result["status"],
        "configuration_snapshot_sha256": result["snapshot_sha256"],
        "target": pin(target),
        "owner": {
            "mode": "existing_draft" if draft else "new_draft",
            "definition_id": str(target.definition_id),
            "draft_id": str(draft.id) if draft else None,
            "state": draft.state_token if draft else None,
            "base_revision_id": _base_revision(draft, target),
            "content_sha256": digest(before),
        },
        "option_keys": sorted(item["option_key"] for item in selected),
        "rows": ordered,
        "changes": changes,
        "warnings": warnings,
        "eligible": eligible,
        "message": message,
        **NOT_EVALUATED,
    }
    return row, target, draft, before, after, body


def _base_revision(draft, target):
    if draft is None:
        return str(target.id)
    return str(draft.base_revision_id) if draft.base_revision_id else None


def history(ctx, row):
    rows = list(
        ConfigurationAdoption.objects.filter(resolved_configuration=row).order_by("-created_at")[
            : HISTORY + 1
        ]
    )
    return [
        {
            "adoption_id": str(item.id),
            "draft_id": str(item.draft_id),
            "draft_version": item.draft_version,
            "created_draft": item.created_draft,
            "option_keys": item.option_keys,
            "basis": item.basis,
            "created_at": item.created_at.isoformat(),
        }
        for item in rows[:HISTORY]
    ], len(rows) > HISTORY


def adoption_result(ctx, adoption_id, *, permission=Perm.WORKSPACE_READ):
    item = (
        ConfigurationAdoption.objects.select_related("draft__definition")
        .filter(id=adoption_id)
        .first()
    )
    if item is None:
        raise NotFound("Configuration adoption unavailable.")
    resolved_result(ctx, item.resolved_configuration_id, permission=permission)
    draft = scoped_draft(ctx, item.draft_id, permission)
    # Displaced pins remain part of the retained evidence's authority.
    for content in (item.before_content, item.after_content):
        authorize_design_content(ctx.user, draft.definition, content)
    return {
        "adoption_id": str(item.id),
        "resolved_configuration_id": str(item.resolved_configuration_id),
        "draft_id": str(item.draft_id),
        "draft_version": item.draft_version,
        "created_draft": item.created_draft,
        "base_revision_id": str(item.base_revision_id) if item.base_revision_id else None,
        "option_keys": item.option_keys,
        "review": item.review,
        "basis": item.basis,
        "created_at": item.created_at.isoformat(),
        **NOT_EVALUATED,
    }


def adopt_replay(ctx, p, stored):
    plan(ctx, p, permission=Perm.DESIGN_EDIT)
    adoption_result(ctx, stored["adoption_id"], permission=Perm.DESIGN_EDIT)


def adopt_scope(ctx, p):
    row, _ = resolved_result(ctx, p.resolved_configuration_id, permission=Perm.DESIGN_EDIT)
    if p.draft_id:
        scoped_draft(ctx, p.draft_id, Perm.DESIGN_EDIT)
    scope = f"workspace:{row.workspace_id}"
    # Authorize retained outcomes before changed-payload diagnostics.
    for prior in IdempotencyRecord.objects.select_for_update().filter(
        actor=ctx.user, operation="configuration.adopt", key=ctx.idempotency_key, scope=scope
    ):
        adopt_replay(ctx, p, prior.result)
    return scope


@operation(
    "configuration.review_adoption",
    ReviewAdoption,
    summary="Review the exact assembly-draft diff of adopting resolved occurrence choices.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def review_adoption(ctx: Context, p: ReviewAdoption):
    row, _, _, _, _, body = plan(ctx, p)
    records, truncated = history(ctx, row)
    return {
        **body,
        "review_sha256": digest(body),
        "adoptions": records,
        "history_truncated": truncated,
    }


@operation(
    "configuration.adopt",
    AdoptResolution,
    summary=(
        "Adopt explicitly reviewed resolved choices into a new or selected assembly draft;"
        " frozen revisions are never changed."
    ),
    idempotency_scope=adopt_scope,
    authorize_replay=adopt_replay,
    access=Perm.DESIGN_EDIT,
)
def adopt(ctx: Context, p: AdoptResolution):
    if p.draft_id is not None:
        # Compare-and-set on the selected draft before any review comparison.
        locked = scoped_draft(ctx, p.draft_id, Perm.DESIGN_EDIT, lock=True)
        check_state(ctx, locked)
    elif ctx.expected_state:
        raise ValidationFailed("A new draft has no expected state; omit it.")
    row, target, draft, before, after, body = plan(ctx, p, permission=Perm.DESIGN_EDIT, lock=True)
    review_sha256 = digest(body)
    if review_sha256 != p.review_sha256:
        raise Conflict("The adoption review changed; review the diff again.")
    if not body["eligible"]:
        raise ValidationFailed(body["message"])
    if draft is not None:
        result = update_draft(
            ctx, UpdateDraft(draft_id=draft.id, changes={"assembly": after["assembly"]})
        )
        draft.refresh_from_db()
    else:
        authorize_design_content(ctx.user, target.definition, after)
        draft = Draft.objects.create(
            definition=target.definition, content=after, base_revision=target, updated_by=ctx.user
        )
        result = draft_state(draft)
    review = {**body, "review_sha256": review_sha256}
    evidence = ConfigurationAdoption.objects.create(
        workspace_id=row.workspace_id,
        resolved_configuration=row,
        draft=draft,
        draft_version=draft.version,
        created_draft=p.draft_id is None,
        base_revision_id=draft.base_revision_id,
        option_keys=body["option_keys"],
        review=review,
        review_canonical=canonical(body),
        review_sha256=review_sha256,
        before_content=before,
        before_canonical=canonical(before),
        after_content=draft.content,
        basis=p.basis,
        adopted_by=ctx.user,
    )
    return {
        **result,
        "definition_id": str(target.definition_id),
        "adoption_id": str(evidence.id),
        "resolved_configuration_id": str(row.id),
        "created_draft": evidence.created_draft,
        "changes": body["changes"],
        "existing_frozen_pins": "retained",
        **NOT_EVALUATED,
    }


@operation(
    "configuration.read_adoption",
    AdoptionRef,
    summary="Read immutable resolved-configuration adoption evidence under current authority.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def read_adoption(ctx: Context, p: AdoptionRef):
    return adoption_result(ctx, p.adoption_id)


def _described(reader, revision):
    item = {**pin(revision)}
    kind = revision.definition.kind
    if kind == "pcb_population":
        content = reader.content(revision)["pcb_population"]
        item["population_options"] = [
            {"local_id": o["local_id"], "name": o["name"]} for o in content.get("options", [])
        ]
    if kind == "firmware":
        declared = reader.content(revision)["firmware"]["target"]
        item["declared_target"] = {
            "population_revision_id": declared.get("population_revision_id"),
            "option_id": declared.get("option_id"),
        }
    return item


@operation(
    "configuration.authoring_context",
    AuthoringContext,
    summary="Describe exact target occurrences and candidate revisions for option-set authoring.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def authoring_context(ctx: Context, p: AuthoringContext):
    from specmate.assemblies.queries import get_snapshot

    reader = Reader(ctx.user)
    target = None
    if p.target_revision_id is not None:
        revision = reader.revision(p.target_revision_id)
        if revision.definition.kind != "assembly":
            raise ValidationFailed("An option-set target must be a frozen assembly revision.")
        _, closure = get_snapshot(ctx.user, revision.snapshot_id)
        occurrences = []
        for path, node in closure.nodes.items():
            assigned = closure.assignments.get(path) or node.occurrence.assignments
            occurrences.append(
                {
                    "path": list(path),
                    "display_ref": node.occurrence.display_ref,
                    "revision": _described(reader, reader.revision(node.revision.id)),
                    "firmware_revision_id": (
                        str(assigned.firmware_revision_id)
                        if assigned.firmware_revision_id
                        else None
                    ),
                }
            )
        target = {**pin(revision), "occurrences": occurrences}
    revisions = [_described(reader, reader.revision(rid)) for rid in dict.fromkeys(p.revision_ids)]
    return {"target": target, "revisions": revisions}
