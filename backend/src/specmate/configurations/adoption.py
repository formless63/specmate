"""Reviewed adoption of resolved occurrence choices into an owning assembly draft (CFG-001).

A captured resolution is immutable evidence; adopting it is a separate, explicit change
of an assembly draft. The review shows the exact diff, the actor confirms a review hash,
and the draft changes only under compare-and-set. Frozen revisions are never modified:
adoption either creates a new draft of the frozen target assembly or edits an explicitly
selected draft of that definition. Evidence links the draft change to the resolution.

Only decisions with established assembly semantics change a draft:

- a part or population choice replaces the exact pin of a direct occurrence;
- a part or population choice for a nested occurrence propagates through every
  containing sub-assembly: each gets a new draft started from its exact pinned revision
  with only the reviewed pin replaced, that draft is frozen as a new revision, and the
  parent re-pins it, up to the owning draft. The review shows every level as one
  multi-level diff and adoption applies all of them in one transaction;
- a population choice records its population option as a contextual assignment of the
  occurrence path in the owning draft;
- a firmware choice sets the contextual firmware pin of an occurrence path.

Material/process/requirement values are not assembly fields; they stay in the resolved
configuration. Compatibility between adopted pins is not evaluated here.
"""

import copy
import uuid
from dataclasses import dataclass, field, replace

from specmate.access.permissions import Perm, authorize_item
from specmate.assemblies.contracts import CaptureAssembly, OccurrenceRef
from specmate.assemblies.queries import Closure, proposed_revision, refs
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

REVISION_CHANGES = {"replace_revision", "propagate_revision"}
CHANGES = REVISION_CHANGES | {"assign_population_option", "assign_firmware"}
HISTORY = 100
# Deterministic placeholder IDs for reviewed, not yet frozen containing revisions.
PROPOSED = uuid.UUID("5f0c8a52-0b7e-4d6e-9a43-2f3c1d7e9b10")


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


def _closure(ctx, content, workspace_id, proposed=None):
    try:
        closure = Closure(
            ctx.user, content, kind="assembly", workspace_id=workspace_id, proposed=proposed
        )
        return closure, None
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


def _effective(closure, path):
    node = closure.nodes[path]
    return closure.assignments.get(path) or node.occurrence.assignments


def _feature_bound(closure, path):
    """Relationships of containing levels that address features the change could move.

    A relationship at or above the occurrence addresses a feature at or below it, or a
    feature of a containing occurrence that would be re-pinned. Correspondence of those
    features needs a reviewed revision upgrade, not a configuration adoption.
    """
    for prefix, relationship in closure.relationships:
        if len(prefix) >= len(path) or path[: len(prefix)] != prefix:
            continue
        for ref in refs(relationship):
            if not isinstance(ref, OccurrenceRef) or not ref.feature_id:
                continue
            full = (*prefix, *ref.path)
            if full[: len(path)] == path:
                return True
            if len(prefix) < len(full) < len(path) and path[: len(full)] == full:
                return True
    return False


def _revision_row(row, decision, closure):
    path = tuple(decision["path"])
    node = closure.nodes.get(path)
    if node is None:
        return {**row, "action": "blocked", "reason": "The path does not resolve in this assembly."}
    population = decision["domain"] == "population"
    if population and node.revision.definition.kind != "pcb_population":
        return {
            **row,
            "action": "blocked",
            "reason": "This path no longer addresses a board population occurrence.",
        }
    after = decision["choice"]["revision"]["revision_id"]
    option = decision["choice"]["population_option_id"] if population else None
    kept = _effective(closure, path).population_option_id if population else None
    if population:
        row = {**row, "population_option_before": kept}
    same = str(node.revision.id) == after
    if same and kept == option:
        reason = "Already pins this exact revision"
        reason += f" with population option {option}." if population else "."
        return {**row, "action": "unchanged", "reason": reason}
    changed = {"before": pin(node.revision), "display_ref": node.occurrence.display_ref}
    if same:
        return {
            **row,
            **changed,
            "action": "assign_population_option",
            "reason": (
                f"Records population option {option} as a contextual assignment of this"
                " occurrence; the pinned population revision is unchanged."
            ),
        }
    if _feature_bound(closure, path):
        return {
            **row,
            "action": "blocked",
            "reason": (
                "Relationships address features of this occurrence or a containing one;"
                " review feature correspondence through a revision upgrade proposal."
            ),
        }
    note = f" Records population option {option} for this occurrence." if population else ""
    if len(path) > 1:
        return {
            **row,
            **changed,
            "action": "propagate_revision",
            "reason": (
                "Replaces this pin in a new draft of each containing sub-assembly, frozen"
                " as a new revision and re-pinned by its parent." + note
            ),
        }
    return {
        **row,
        **changed,
        "action": "replace_revision",
        "reason": "Replaces the exact pin of this direct occurrence." + note,
    }


def _firmware_row(ctx, row, decision, closure, failure):
    from specmate.pcb.firmware import read_revision

    if closure is None:
        return {**row, "action": "blocked", "reason": failure}
    path = tuple(decision["path"])
    node = closure.nodes.get(path)
    if node is None:
        return {**row, "action": "blocked", "reason": "The path does not resolve in this assembly."}
    assigned = _effective(closure, path)
    current = str(assigned.firmware_revision_id) if assigned.firmware_revision_id else None
    after = decision["choice"]["revision"]["revision_id"]
    if current == after:
        return {**row, "action": "unchanged", "reason": "Already pins this exact firmware."}
    candidate = read_revision(ctx.user, after)
    declared = candidate["content"]["firmware"]["target"]
    if node.revision.definition.kind != "pcb_population" or declared[
        "population_revision_id"
    ] != str(node.revision.id):
        return {
            **row,
            "action": "blocked",
            "reason": "The firmware does not declare this exact population revision as its target.",
        }
    fitted = assigned.population_option_id
    if fitted is not None and declared.get("option_id") not in (None, fitted):
        return {
            **row,
            "action": "blocked",
            "reason": (
                f"The firmware declares population option {declared['option_id']}; this"
                f" occurrence records population option {fitted}."
            ),
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


def _set_pin(assembly, local_id, revision_id):
    for occurrence in assembly["occurrences"]:
        if occurrence["local_id"] == local_id:
            occurrence["revision_id"] = revision_id


def _assign(assembly, closure, path, **fields):
    """Set contextual assignment fields; a record replaces the occurrence's assignments,
    so it starts from the effective ones and keeps every field it does not set."""
    current = _effective(closure, tuple(path)).model_dump(mode="json")
    record = {key: value for key, value in current.items() if value is not None}
    record.update(fields)
    records = [r for r in assembly.get("assignments", []) if r["path"] != list(path)]
    records.append({"path": list(path), "assignments": record})
    assembly["assignments"] = records


def placeholder(path):
    return str(uuid.uuid5(PROPOSED, "/".join(path)))


@dataclass
class Level:
    """One containing sub-assembly occurrence whose pinned revision is re-drafted."""

    path: tuple
    node: object
    replace: dict = field(default_factory=dict)  # local id -> chosen revision pin
    repin: set = field(default_factory=set)  # child local ids that become new revisions
    option_keys: set = field(default_factory=set)
    content: dict | None = None  # after content, with placeholder IDs for child levels


@dataclass
class Plan:
    row: object
    target: object
    draft: object
    before: dict
    after: dict  # owning content, with placeholder IDs for re-pinned levels
    body: dict
    levels: list  # deepest first, the order in which they freeze


def _levels(closure, rows, chosen):
    """Containing levels for the selected nested revision changes."""
    levels = {}
    for item in rows:
        if not (chosen(item["option_key"]) and item["action"] == "propagate_revision"):
            continue
        path = tuple(item["path"])
        for depth in range(1, len(path)):
            prefix = path[:depth]
            level = levels.setdefault(prefix, Level(prefix, closure.nodes[prefix]))
            level.option_keys.add(item["option_key"])
            if depth == len(path) - 1:
                level.replace[path[-1]] = item["choice"]["revision"]
            else:
                level.repin.add(path[depth])
    for path in sorted(levels, key=lambda p: (-len(p), p)):
        level = levels[path]
        content = copy.deepcopy(level.node.content)
        for local_id, chosen_pin in sorted(level.replace.items()):
            _set_pin(content["assembly"], local_id, chosen_pin["revision_id"])
        for local_id in sorted(level.repin):
            _set_pin(content["assembly"], local_id, placeholder((*path, local_id)))
        level.content = content
    return levels


def _proposal(level):
    return {
        "proposed": True,
        "definition_id": str(level.node.revision.definition_id),
        "kind": level.node.revision.definition.kind,
        "name": level.node.revision.definition.name,
        "path": list(level.path),
    }


OCCURRENCE_CHANGES = REVISION_CHANGES | {"assign_population_option"}


def _overlap(item, other):
    """A pin replacement cannot combine with another change on the same path, a path
    containing it or one inside it; two population options never overlap."""
    path, at = tuple(item["path"]), tuple(other["path"])
    replaces = item["action"] in REVISION_CHANGES or other["action"] in REVISION_CHANGES
    return replaces and (path[: len(at)] == at or at[: len(path)] == path)


def _default_keys(rows):
    """Default selection: every occurrence change, first declared option winning."""
    taken = []
    for item in rows:
        if item["action"] in OCCURRENCE_CHANGES and not any(_overlap(item, t) for t in taken):
            taken.append(item)
    return {item["option_key"] for item in taken}


def _conflicting(rows, chosen):
    """Block a selected change that overlaps an earlier selected one; note the overlap on
    unselected rows. Depends only on the selection, so explicit and default reviews of
    the same selection hash identically."""
    taken = []
    for item in rows:
        if item["action"] not in OCCURRENCE_CHANGES:
            continue
        other = next((t for t in taken if _overlap(item, t)), None)
        if other is None:
            if chosen(item["option_key"]):
                taken.append(item)
            continue
        note = (
            f"Option {other['option_key']} changes this occurrence, one containing it or one"
            " inside it; adopt them separately."
        )
        if chosen(item["option_key"]):
            item.update(action="blocked", reason=note)
        else:
            item["reason"] += " " + note


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
    rows = {}
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
            "population_option_before": None,
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
            rows[decision["option_key"]] = _revision_row(base, decision, closure)
        else:
            firmware.append((base, decision))

    ordered = [rows[d["option_key"]] for d in resolution["decisions"] if d["option_key"] in rows]
    defaults = _default_keys(ordered)

    def chosen(key):
        if p.option_keys is not None:
            return key in p.option_keys
        if rows[key]["domain"] in {"part", "population"}:
            return key in defaults
        return rows[key]["action"] in CHANGES

    _conflicting(ordered, chosen)
    levels = _levels(closure, ordered, chosen)
    proposed = {
        uuid.UUID(placeholder(level.path)): proposed_revision(
            uuid.UUID(placeholder(level.path)), level.node.revision.definition, level.content
        )
        for level in levels.values()
    }
    assembly = copy.deepcopy(before["assembly"])
    for item in ordered:
        if not chosen(item["option_key"]) or item["action"] != "replace_revision":
            continue
        _set_pin(assembly, item["path"][0], item["choice"]["revision"]["revision_id"])
    for path in sorted(p for p in levels if len(p) == 1):
        _set_pin(assembly, path[0], placeholder(path))
    for item in ordered:
        if chosen(item["option_key"]) and item["domain"] == "population":
            option = item["choice"]["population_option_id"]
            if item["action"] in CHANGES and item["population_option_before"] != option:
                _assign(assembly, closure, item["path"], population_option_id=option)
    middle, failure = _closure(ctx, {**before, "assembly": assembly}, workspace_id, proposed)
    for base, decision in firmware:
        key = decision["option_key"]
        rows[key] = _firmware_row(ctx, base, decision, middle, failure)
        if chosen(key) and rows[key]["action"] == "assign_firmware":
            revision_id = decision["choice"]["revision"]["revision_id"]
            _assign(assembly, middle, decision["path"], firmware_revision_id=revision_id)
    ordered = [{**rows[d["option_key"]], "selected": False} for d in resolution["decisions"]]
    for item in ordered:
        item["selected"] = chosen(item["option_key"])
    selected = [item for item in ordered if item["selected"]]
    changes = _root_changes(selected, levels)
    propagation = [_level_body(levels[path], closure, levels) for path in sorted(levels)]
    after = {**before, "assembly": assembly}
    warnings = []
    final, final_failure = (
        _closure(ctx, after, workspace_id, proposed) if changes else (closure, None)
    )
    if final is not None and changes:
        replaced = [tuple(i["path"]) for i in selected if i["action"] in REVISION_CHANGES]
        assigned = {tuple(c["path"]) for c in changes if c["field"] == "firmware"}
        for path in sorted(final.nodes):
            if path in assigned or not any(path[: len(r)] == r for r in replaced):
                continue
            if _effective(final, path).firmware_revision_id:
                warnings.append(
                    {
                        "path": list(path),
                        "message": (
                            "A retained firmware pin was reviewed against the previous"
                            " revision of this occurrence; review it again."
                        ),
                    }
                )
    blocked = [i["option_key"] for i in selected if i["action"] not in CHANGES]
    count = len(changes) + sum(len(level["changes"]) for level in propagation)
    if blocked:
        eligible, message = False, "Deselect options that cannot be adopted: " + ", ".join(blocked)
    elif final is None:
        eligible, message = False, f"The adopted assembly would not resolve: {final_failure}"
    elif not changes:
        eligible, message = False, "The selected choices do not change this assembly."
    else:
        eligible, message = True, f"{count} reviewed change(s) to the owning draft"
        if propagation:
            message += (
                f" and {len(propagation)} new containing sub-assembly revision(s), each frozen"
                " from a new draft of its exact pinned revision."
            )
        else:
            message += "."
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
        "propagation": propagation,
        "requires": [Perm.DESIGN_EDIT.value] + ([Perm.DESIGN_FREEZE.value] if propagation else []),
        "warnings": warnings,
        "eligible": eligible,
        "message": message,
        **NOT_EVALUATED,
    }
    ordered_levels = [levels[path] for path in sorted(levels, key=lambda p: (-len(p), p))]
    return Plan(row, target, draft, before, after, body, ordered_levels)


def _root_changes(selected, levels):
    """The owning draft's own diff: direct pins, re-pins and contextual assignments."""
    changes = []
    for item in selected:
        if item["action"] == "replace_revision":
            changes.append(_change(item, "revision_id", item["before"], item["choice"]["revision"]))
    for path in sorted(p for p in levels if len(p) == 1):
        level = levels[path]
        changes.append(
            {
                "option_keys": sorted(level.option_keys),
                "path": list(path),
                "display_ref": level.node.occurrence.display_ref,
                "field": "revision_id",
                "before": pin(level.node.revision),
                "after": _proposal(level),
            }
        )
    for item in selected:
        moved = (
            item["choice"]
            and item["population_option_before"] != (item["choice"]["population_option_id"])
        )
        if item["domain"] == "population" and item["action"] in CHANGES and moved:
            changes.append(
                _change(
                    item,
                    "population_option_id",
                    item["population_option_before"],
                    item["choice"]["population_option_id"],
                )
            )
        if item["action"] == "assign_firmware":
            changes.append(_change(item, "firmware", item["before"], item["choice"]["revision"]))
    return changes


def _change(item, field_name, before, after):
    return {
        "option_keys": [item["option_key"]],
        "path": item["path"],
        "display_ref": item["display_ref"],
        "field": field_name,
        "before": before,
        "after": after,
    }


def _level_body(level, closure, levels):
    """One containing level of the multi-level diff: its new draft and changed pins."""
    changes = []
    for local_id in sorted(set(level.replace) | level.repin):
        path = (*level.path, local_id)
        node = closure.nodes[path]
        after = level.replace[local_id] if local_id in level.replace else _proposal(levels[path])
        changes.append(
            {
                "local_id": local_id,
                "path": list(path),
                "display_ref": node.occurrence.display_ref,
                "field": "revision_id",
                "before": pin(node.revision),
                "after": after,
            }
        )
    return {
        "path": list(level.path),
        "display_ref": level.node.occurrence.display_ref,
        "pinned": pin(level.node.revision),
        "option_keys": sorted(level.option_keys),
        "draft": {
            "mode": "new_draft",
            "base_revision_id": str(level.node.revision.id),
            "content_sha256": digest(level.node.content),
        },
        "result": "freeze_new_revision",
        "changes": changes,
    }


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
            "propagated": item.propagated,
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
        "propagated": item.propagated,
        "review": item.review,
        "basis": item.basis,
        "created_at": item.created_at.isoformat(),
        **NOT_EVALUATED,
    }


def adopt_replay(ctx, p, stored):
    plan(ctx, p, permission=Perm.DESIGN_EDIT)
    adoption_result(ctx, stored["adoption_id"], permission=Perm.DESIGN_EDIT)
    # Replaying a propagated adoption needs the authority that froze its levels.
    for level in stored.get("propagated", []):
        draft = scoped_draft(ctx, level["draft_id"], Perm.DESIGN_FREEZE)
        authorize_item(ctx.user, draft.definition, Perm.DESIGN_FREEZE)


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
    reviewed = plan(ctx, p)
    body = reviewed.body
    records, truncated = history(ctx, reviewed.row)
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
    reviewed = plan(ctx, p, permission=Perm.DESIGN_EDIT, lock=True)
    row, target, draft, before, body = (
        reviewed.row,
        reviewed.target,
        reviewed.draft,
        reviewed.before,
        reviewed.body,
    )
    review_sha256 = digest(body)
    if review_sha256 != p.review_sha256:
        raise Conflict("The adoption review changed; review the diff again.")
    if not body["eligible"]:
        raise ValidationFailed(body["message"])
    for level in reviewed.levels:
        # Freezing each containing level needs its own authority; check all before writes.
        authorize_item(ctx.user, level.node.revision.definition, Perm.DESIGN_FREEZE)
    real = {}
    propagated = []
    for level in reviewed.levels:  # deepest first, so every child is frozen before its parent
        frozen = _freeze_level(ctx, level, real)
        real[placeholder(level.path)] = frozen["revision_id"]
        propagated.append(frozen)
    propagated.sort(key=lambda item: item["path"])
    after = {**before, "assembly": _substitute(reviewed.after["assembly"], real)}
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
        propagated=propagated,
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
        "propagated": propagated,
        "existing_frozen_pins": "retained",
        **NOT_EVALUATED,
    }


def _substitute(assembly, real):
    """Replace reviewed placeholder pins with the revisions frozen in this transaction."""
    assembly = copy.deepcopy(assembly)
    for occurrence in assembly["occurrences"]:
        occurrence["revision_id"] = real.get(occurrence["revision_id"], occurrence["revision_id"])
    return assembly


def _freeze_level(ctx, level, real):
    """A new draft of the exact pinned containing revision, changed and frozen."""
    from specmate.assemblies.operations import freeze_assembly

    definition = level.node.revision.definition
    content = {**level.content, "assembly": _substitute(level.content["assembly"], real)}
    authorize_design_content(ctx.user, definition, content)
    draft = Draft.objects.create(
        definition=definition,
        content=content,
        base_revision=level.node.revision,
        updated_by=ctx.user,
    )
    frozen = freeze_assembly(
        replace(ctx, expected_state=draft.state_token, idempotency_key=None),
        CaptureAssembly(draft_id=draft.id),
    )
    return {
        "path": list(level.path),
        "definition_id": str(definition.id),
        "draft_id": str(draft.id),
        "base_revision_id": str(level.node.revision.id),
        "revision_id": frozen["revision_id"],
        "number": frozen["number"],
        "snapshot_sha256": frozen["sha256"],
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
