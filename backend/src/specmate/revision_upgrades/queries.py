"""Authorize retained closure before exposing proposals, reviews or applicability."""

import copy
import json
from dataclasses import dataclass, field

from specmate.access.permissions import Perm, authorize
from specmate.assemblies.contracts import OccurrenceRef
from specmate.assemblies.queries import Closure, get_snapshot, read_assembly, refs
from specmate.catalog_matching.queries import (
    authorize_file,
    current_actor,
    evidence_result,
    revision_identity,
)
from specmate.design.models import Revision, Snapshot
from specmate.design.operations import authorize_snapshot
from specmate.interfaces.contracts import ConnectorBody, Pinout
from specmate.interfaces.queries import read_revision
from specmate.operations import NotFound, Unsupported, ValidationFailed
from specmate.queries import get_revision
from specmate.revision_upgrades.contracts import Impacts
from specmate.revision_upgrades.models import UpgradeProposal


def inspect_owning(user, snapshot_id):
    """Upgrade selectors authorize owning origins as well as the assembly child closure."""
    user = current_actor(user)
    snapshot = Snapshot.objects.select_related("definition").filter(id=snapshot_id).first()
    if snapshot is None:
        raise NotFound("Upgrade owning snapshot unavailable.")
    authorize_snapshot(user, snapshot)
    return read_assembly(user, snapshot_id)


def references(
    user,
    owning_snapshot_id,
    old_revision_id,
    candidate_revision_id,
    *,
    edit=False,
    validate=True,
    relation="later_revision",
):
    user = current_actor(user)
    # Complete authority before identity, owning-kind or path diagnostics.
    old = get_revision(user, old_revision_id)
    candidate = get_revision(user, candidate_revision_id)
    owning = Snapshot.objects.select_related("definition").filter(id=owning_snapshot_id).first()
    if owning is None:
        raise NotFound("Upgrade owning snapshot unavailable.")
    authorize_snapshot(user, owning)
    snapshot, closure = get_snapshot(user, owning_snapshot_id)
    if edit:
        authorize(user, snapshot.definition.project_id, Perm.DESIGN_EDIT)
    if validate:
        identity(old, candidate, relation)
    return snapshot, closure, old, candidate


def identity(old, candidate, relation):
    """Correspondence is declared by a person; labels and catalog matches never imply it."""
    if relation == "later_revision":
        if old.definition_id != candidate.definition_id or candidate.number <= old.number:
            raise ValidationFailed("Upgrade requires a later revision of the same definition.")
        return
    if old.definition_id == candidate.definition_id:
        raise ValidationFailed(
            "A declared replacement names a different definition; propose a later revision"
            " for the same identity."
        )
    if old.definition.kind != candidate.definition.kind:
        raise Unsupported(
            "Replacement identities must share a definition kind; kind conversion is not inferred."
        )


@dataclass
class Consumer:
    """The exact assembly content that adoption edits: the owning root or a nested pin."""

    context_path: tuple
    snapshot: Snapshot
    revision: object
    closure: Closure
    content: dict

    @property
    def definition(self):
        return self.snapshot.definition


def consumer(user, snapshot, closure, context_path, *, edit=False):
    context_path = tuple(context_path)
    if not context_path:
        revision = Revision.objects.filter(snapshot=snapshot).first()
        return Consumer((), snapshot, revision, closure, baseline(snapshot))
    node = closure.nodes.get(context_path)
    if node is None:
        raise ValidationFailed("Consuming context does not resolve in the owning snapshot.")
    if node.revision.definition.kind != "assembly":
        raise Unsupported("A nested consuming context must pin an assembly revision.")
    # The nested consumer's own retained origin and closure are checked afresh.
    nested, nested_closure = get_snapshot(user, node.revision.snapshot_id)
    if edit:
        authorize(user, nested.definition.project_id, Perm.DESIGN_EDIT)
    return Consumer(context_path, nested, node.revision, nested_closure, baseline(nested))


def baseline(snapshot):
    return json.loads(bytes(snapshot.canonical))["content"]


@dataclass
class Plan:
    """Selected re-pinning plus every consuming-context reference it touches."""

    relation: str
    selected: set
    content: dict
    probe: dict
    closure: Closure
    replacement: Closure
    removed: set = field(default_factory=set)
    relationships_allowed: set = field(default_factory=set)
    relationships_required: set = field(default_factory=set)
    feature_refs: dict = field(default_factory=dict)
    assignments_allowed: set = field(default_factory=set)
    assignments_required: set = field(default_factory=set)

    def changed(self, path):
        if path in self.selected:
            return True
        previous, current = self.closure.nodes.get(path), self.replacement.nodes.get(path)
        return previous is None or current is None or previous.revision.id != current.revision.id

    def affected(self, removed_relationships=()):
        return {
            ref
            for local_id, found in self.feature_refs.items()
            if local_id not in removed_relationships
            for ref in found
        }


def selected_content(user, target, old, candidate, paths, relation="later_revision"):
    content = copy.deepcopy(target.content)
    closure = target.closure
    selected = {tuple(path) for path in paths}
    if any(len(path) != 1 for path in selected):
        raise Unsupported(
            "Select direct occurrences of the consuming context; reach nested uses through an"
            " explicit context path and its own adoption draft."
        )
    for path in selected:
        node = closure.nodes.get(path)
        if node is None or node.revision.id != old.id:
            raise ValidationFailed("Selected occurrence must retain the exact old revision pin.")
    changed = copy.deepcopy(content)
    for occurrence in changed["assembly"]["occurrences"]:
        if (occurrence["local_id"],) in selected:
            occurrence["revision_id"] = str(candidate.id)

    def under(path):
        return tuple(path[:1]) in selected

    raw = content["assembly"].get("relationships", [])
    parsed = list(zip(raw, closure.root.relationships, strict=True))

    def touches(relationship):
        return any(isinstance(r, OccurrenceRef) and under(r.path) for r in refs(relationship))

    # Probe the candidate occurrence tree without context-authored references into the
    # selected uses; those references are decided explicitly below, never dropped.
    probe = copy.deepcopy(changed)
    probe["assembly"]["relationships"] = [r for r, rel in parsed if not touches(rel)]
    probe["assembly"]["assignments"] = [
        record for record in content["assembly"].get("assignments", []) if not under(record["path"])
    ]
    plan = Plan(relation, selected, changed, probe, closure, Closure(user, probe, kind="assembly"))
    replacing = relation == "declared_replacement"
    for _, relationship in parsed:
        if not touches(relationship):
            continue
        found = set()
        decision = replacing
        for ref in refs(relationship):
            if not isinstance(ref, OccurrenceRef) or not under(ref.path):
                continue
            path = tuple(ref.path)
            if path not in plan.replacement.nodes:
                plan.removed.add(path)
            if len(path) > 1 and plan.changed(path):
                decision = True
            if ref.feature_id and plan.changed(path):
                found.add((path, ref.feature_id))
        plan.relationships_allowed.add(relationship.local_id)
        if decision:
            plan.relationships_required.add(relationship.local_id)
        plan.feature_refs[relationship.local_id] = found
    for record in content["assembly"].get("assignments", []):
        path = tuple(record["path"])
        if not under(path):
            continue
        plan.assignments_allowed.add(path)
        if path not in plan.replacement.nodes:
            plan.removed.add(path)
        if (len(path) > 1 and plan.changed(path)) or (len(path) == 1 and replacing):
            plan.assignments_required.add(path)
    for occurrence in closure.root.occurrences:
        path = (occurrence.local_id,)
        if path in selected and occurrence.assignments.firmware_revision_id:
            plan.assignments_allowed.add(path)
            if replacing:
                plan.assignments_required.add(path)
    return plan


def contacts(user, revision):
    if revision.definition.kind not in {"connector_body", "pinout"}:
        raise Unsupported(
            "Feature correspondence currently supports declared connector-body and pinout"
            "contacts; this feature kind requires a qualified adapter."
        )
    _, closure = read_revision(user, revision.id)
    body = closure.body_for(closure.root) if isinstance(closure.root, Pinout) else closure.root
    if not isinstance(body, ConnectorBody):
        raise Unsupported("Feature correspondence requires declared contacts.")
    return {contact.contact_id for contact in body.contacts if contact.physical_role != "key"}


def decisions(items, key, allowed, required, kind):
    chosen = {}
    for item in items:
        identity_key = key(item)
        if identity_key not in allowed or identity_key in chosen:
            raise ValidationFailed(
                f"{kind} decisions must name unique {kind.lower()}s on selected changed uses."
            )
        chosen[identity_key] = item["decision"]
    if required - chosen.keys():
        raise ValidationFailed(
            f"Every {kind.lower()} on a changed or replaced use requires an explicit retain or"
            " remove decision."
        )
    return chosen


def reviewed_content(user, plan, features, relationship_decisions=(), assignment_decisions=()):
    content = copy.deepcopy(plan.content)
    relationships = decisions(
        relationship_decisions,
        lambda item: item["local_id"],
        plan.relationships_allowed,
        plan.relationships_required,
        "Relationship",
    )
    assignments = decisions(
        assignment_decisions,
        lambda item: tuple(item["path"]),
        plan.assignments_allowed,
        plan.assignments_required,
        "Assignment",
    )
    removed_relationships = {key for key, value in relationships.items() if value == "remove"}
    for relationship in plan.closure.root.relationships:
        if relationships.get(relationship.local_id) == "retain" and any(
            isinstance(ref, OccurrenceRef) and tuple(ref.path) in plan.removed
            for ref in refs(relationship)
        ):
            raise ValidationFailed("A relationship to a removed descendant cannot be retained.")
    if any(value == "retain" and key in plan.removed for key, value in assignments.items()):
        raise ValidationFailed("An assignment to a removed descendant cannot be retained.")
    affected = plan.affected(removed_relationships)
    revisions = {}

    def declared(path, closure):
        node = closure.nodes.get(path)
        if node is None:
            raise ValidationFailed("Correspondence must name a use present on both sides.")
        if node.revision.id not in revisions:
            revisions[node.revision.id] = contacts(user, node.revision)
        return revisions[node.revision.id]

    mappings = {}
    for feature in features:
        path = tuple(feature["path"])
        key = (path, feature["old_feature_id"])
        if tuple(path[:1]) not in plan.selected or key in mappings:
            raise ValidationFailed("Correspondence must name unique selected occurrence features.")
        if feature["old_feature_id"] not in declared(path, plan.closure) or feature[
            "candidate_feature_id"
        ] not in declared(path, plan.replacement):
            raise ValidationFailed(
                "Correspondence must identify declared contacts on both exact revisions."
            )
        mappings[key] = feature["candidate_feature_id"]
    if affected - mappings.keys():
        raise ValidationFailed(
            "Every affected authored feature requires explicit reviewed correspondence,"
            " including unchanged labels."
        )
    content["assembly"]["relationships"] = [
        relationship
        for relationship in content["assembly"].get("relationships", [])
        if relationship["local_id"] not in removed_relationships
    ]
    for relationship in content["assembly"]["relationships"]:
        for value in relationship.values():
            if isinstance(value, dict) and value.get("kind") == "occurrence":
                key = (tuple(value["path"]), value.get("feature_id"))
                if key in mappings:
                    value["feature_id"] = mappings[key]
    removed_assignments = {key for key, value in assignments.items() if value == "remove"}
    content["assembly"]["assignments"] = [
        record
        for record in content["assembly"].get("assignments", [])
        if tuple(record["path"]) not in removed_assignments
    ]
    for occurrence in content["assembly"]["occurrences"]:
        if (occurrence["local_id"],) in removed_assignments:
            occurrence["assignments"] = {"firmware_revision_id": None}
    Closure(user, content, kind="assembly")
    return content


def review_content(user, plan, review):
    return reviewed_content(
        user,
        plan,
        review.features,
        review.relationship_decisions,
        review.assignment_decisions,
    )


def propagation(snapshot, closure, target, selected):
    """Report outer uses an adopted nested draft cannot change until a parent proposal."""
    if not target.context_path:
        return {"status": "not_applicable"}
    context = target.context_path
    reached = {(*context, *path) for path in selected}

    def within(path):
        return tuple(path[: len(context) + 1]) in reached

    return {
        "status": "required",
        "context_path": list(context),
        "consumer": revision_identity(target.revision).model_dump(mode="json"),
        "sibling_context_paths": [
            list(path)
            for path, node in sorted(closure.nodes.items())
            if node.revision.id == target.revision.id and path != context
        ],
        "outer_relationships": [
            {"context_path": list(prefix), "local_id": relationship.local_id}
            for prefix, relationship in closure.relationships
            if len(prefix) < len(context)
            and context[: len(prefix)] == prefix
            and any(
                isinstance(ref, OccurrenceRef) and within((*prefix, *ref.path))
                for ref in refs(relationship)
            )
        ],
        "outer_assignments": [
            list(path)
            for prefix in (context[:n] for n in range(len(context)))
            for record in (baseline(snapshot) if not prefix else closure.nodes[prefix].content)[
                "assembly"
            ].get("assignments", [])
            for path in [(*prefix, *record["path"])]
            if within(path)
        ],
        "owning_snapshot_id": str(snapshot.id),
    }


def rows(user, proposal_id, *, edit=False, lock=False):
    user = current_actor(user)
    query = UpgradeProposal.objects.all()
    if lock:
        query = query.select_for_update(of=("self",))
    proposal = query.filter(id=proposal_id).first()
    if proposal is None:
        raise NotFound("Upgrade proposal unavailable.")
    snapshot, closure, old, candidate = references(
        user,
        proposal.owning_snapshot_id,
        proposal.old_revision_id,
        proposal.candidate_revision_id,
        edit=edit,
        relation=proposal.relation,
    )
    target = consumer(user, snapshot, closure, proposal.context_path, edit=edit)
    if target.context_path and target.snapshot.id != proposal.consumer_snapshot_id:
        raise ValidationFailed("Proposal consumer no longer resolves to its exact pin.")
    reviews = list(
        proposal.reviews.select_related(
            "source_file__revision__bundle", "source_file__blob"
        ).order_by("version")
    )
    for review in reviews:
        authorize_file(user, review.source_file)
    for application in proposal.applications.select_related("draft__definition"):
        from specmate.design.operations import authorize_design_content

        authorize(user, application.draft.definition.project_id, Perm.PROJECT_READ)
        authorize_design_content(user, application.draft.definition, application.draft.content)
    return proposal, snapshot, closure, target, old, candidate, reviews


def state(reviews):
    return f"upgrade-v{reviews[-1].version if reviews else 0}"


def plan_for(user, proposal, target, old, candidate):
    return selected_content(user, target, old, candidate, proposal.paths, proposal.relation)


def result(user, proposal_id):
    proposal, snapshot, closure, target, old, candidate, reviews = rows(user, proposal_id)
    plan = plan_for(user, proposal, target, old, candidate)
    current = target.closure
    latest = reviews[-1] if reviews else None
    if latest and latest.decision == "accepted":
        replacement = Closure(user, review_content(user, plan, latest), kind="assembly")
    else:
        try:
            # Undecided references stay visible unless they address a removed descendant.
            replacement = Closure(user, plan.content, kind="assembly")
        except ValidationFailed:
            replacement = plan.replacement
    return {
        "proposal_id": str(proposal.id),
        "owning_snapshot_id": str(snapshot.id),
        "owning_definition_id": str(snapshot.definition_id),
        "owning_sha256": snapshot.sha256,
        "relation": proposal.relation,
        "replacement_basis": proposal.replacement_basis or None,
        "context_path": proposal.context_path,
        "consumer": {
            "snapshot_id": str(target.snapshot.id),
            "definition_id": str(target.definition.id),
            "name": target.definition.name,
            "sha256": target.snapshot.sha256,
            "revision_id": str(target.revision.id) if target.revision else None,
            "number": target.revision.number if target.revision else None,
        },
        "old": revision_identity(old).model_dump(mode="json"),
        "candidate": revision_identity(candidate).model_dump(mode="json"),
        "paths": proposal.paths,
        "basis": proposal.basis,
        "state": state(reviews),
        "decision": latest.decision if latest else "unreviewed",
        "impacts": latest.impacts if latest else Impacts().model_dump(mode="json"),
        "compatibility": "not_evaluated",
        "validity": "not_evaluated",
        "qualification": "not_evaluated",
        "affected_features": [
            {"path": list(path), "feature_id": feature} for path, feature in sorted(plan.affected())
        ],
        "relationship_decisions_required": sorted(plan.relationships_required),
        "relationship_decisions_allowed": sorted(plan.relationships_allowed),
        "assignment_decisions_required": [list(p) for p in sorted(plan.assignments_required)],
        "assignment_decisions_allowed": [list(p) for p in sorted(plan.assignments_allowed)],
        "removed_paths": [list(p) for p in sorted(plan.removed)],
        "parent_propagation": propagation(snapshot, closure, target, plan.selected),
        "occurrences": [
            {
                "path": list(path),
                "old_revision_id": str(current.nodes[path].revision.id)
                if path in current.nodes
                else None,
                "candidate_revision_id": str(replacement.nodes[path].revision.id)
                if path in replacement.nodes
                else None,
                "selected": path in plan.selected,
                "old_placement": current.nodes[path].occurrence.placement.model_dump(mode="json")
                if path in current.nodes
                else None,
                "candidate_placement": replacement.nodes[path].occurrence.placement.model_dump(
                    mode="json"
                )
                if path in replacement.nodes
                else None,
                "old_assignments": (
                    current.assignments.get(path) or current.nodes[path].occurrence.assignments
                ).model_dump(mode="json")
                if path in current.nodes
                else None,
                "candidate_assignments": (
                    replacement.assignments.get(path)
                    or replacement.nodes[path].occurrence.assignments
                ).model_dump(mode="json")
                if path in replacement.nodes
                else None,
            }
            for path in sorted(current.nodes.keys() | replacement.nodes.keys())
        ],
        "relationships": target.content["assembly"].get("relationships", []),
        "old_relationships": [
            {"context_path": list(prefix), **rel.model_dump(mode="json")}
            for prefix, rel in current.relationships
        ],
        "candidate_relationships": [
            {"context_path": list(prefix), **rel.model_dump(mode="json")}
            for prefix, rel in replacement.relationships
        ],
        "contextual_assignments": target.content["assembly"].get("assignments", []),
        "reviews": [
            {
                "review_id": str(review.id),
                "version": review.version,
                "decision": review.decision,
                "basis": review.basis,
                "features": review.features,
                "relationship_decisions": review.relationship_decisions,
                "assignment_decisions": review.assignment_decisions,
                "impacts": review.impacts,
                "evidence": evidence_result(review).model_dump(mode="json"),
                "reviewed_by_id": review.reviewed_by_id,
                "reviewed_at": review.created_at.isoformat(),
            }
            for review in reviews
        ],
        "applications": [
            {
                "application_id": str(a.id),
                "draft_id": str(a.draft_id),
                "draft_version": a.draft_version,
                "review_id": str(a.review_id),
            }
            for a in proposal.applications.all()
        ],
        "limitations": [
            "Selected direct occurrences of one exact consuming context; nested uses adopt into"
            " their own consuming draft and outer contexts need a later parent proposal.",
            "A declared replacement records a person's identity correspondence; labels and"
            " catalog matches are never treated as compatibility evidence.",
            "Reviewed correspondence is not physical or multidisciplinary qualification.",
            "An impact assessment does not change engineering validity.",
        ],
    }


MAX_CONSUMER_SNAPSHOTS = 200


def consumers(user, project_id, revision_id):
    """Authorized frozen consumers of an exact revision; hidden closures are not counted."""
    user = current_actor(user)
    authorize(user, project_id, Perm.PROJECT_READ)
    target = get_revision(user, revision_id)
    candidates = (
        Snapshot.objects.filter(
            definition__project_id=project_id,
            definition__kind="assembly",
            dependencies__revision_id=target.id,
        )
        .select_related("definition")
        .order_by("-created_at", "id")
    )
    found, truncated = [], False
    for index, snapshot in enumerate(candidates):
        if index >= MAX_CONSUMER_SNAPSHOTS:
            truncated = True
            break
        try:
            owning, closure = get_snapshot(user, snapshot.id)
        except NotFound:
            # A consumer whose complete closure is not currently authorized stays hidden.
            continue
        revision = Revision.objects.filter(snapshot=owning).first()
        uses = [
            {
                "path": list(path),
                "context_path": list(path[:-1]),
                "display_ref": node.occurrence.display_ref,
            }
            for path, node in sorted(closure.nodes.items())
            if node.revision.id == target.id
        ]
        if uses:
            found.append(
                {
                    "owning_snapshot_id": str(owning.id),
                    "owning_definition_id": str(owning.definition_id),
                    "name": owning.definition.name,
                    "revision_id": str(revision.id) if revision else None,
                    "number": revision.number if revision else None,
                    "sha256": owning.sha256,
                    "uses": uses,
                }
            )
    return {
        "revision": revision_identity(target).model_dump(mode="json"),
        "consumers": found,
        "truncated": truncated,
        "compatibility": "not_evaluated",
    }
