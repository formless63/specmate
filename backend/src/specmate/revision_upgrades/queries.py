"""Authorize retained closure before exposing proposals, reviews or applicability."""

import copy
import json

from specmate.access.permissions import Perm, authorize
from specmate.assemblies.contracts import OccurrenceRef
from specmate.assemblies.queries import Closure, get_snapshot, refs
from specmate.catalog_matching.queries import (
    authorize_file,
    current_actor,
    evidence_result,
    revision_identity,
)
from specmate.interfaces.contracts import ConnectorBody, Pinout
from specmate.interfaces.queries import read_revision
from specmate.operations import NotFound, Unsupported, ValidationFailed
from specmate.queries import get_revision
from specmate.revision_upgrades.contracts import Impacts
from specmate.revision_upgrades.models import UpgradeProposal


def references(
    user, owning_snapshot_id, old_revision_id, candidate_revision_id, *, edit=False, validate=True
):
    user = current_actor(user)
    # Complete authority before identity, owning-kind or path diagnostics.
    old = get_revision(user, old_revision_id)
    candidate = get_revision(user, candidate_revision_id)
    snapshot, closure = get_snapshot(user, owning_snapshot_id)
    if edit:
        authorize(user, snapshot.definition.project_id, Perm.DESIGN_EDIT)
    if validate and (
        old.definition_id != candidate.definition_id or candidate.number <= old.number
    ):
        raise ValidationFailed("Upgrade requires a later revision of the same definition.")
    return snapshot, closure, old, candidate


def selected_content(user, snapshot, closure, old, candidate, paths):
    content = json.loads(bytes(snapshot.canonical))["content"]
    selected = {tuple(path) for path in paths}
    if any(len(path) != 1 for path in selected):
        raise Unsupported(
            "Adoption currently supports direct assembly occurrences; nested adoption"
            "requires a new owning subassembly draft."
        )
    for path in selected:
        node = closure.nodes.get(path)
        if node is None or node.revision.id != old.id:
            raise ValidationFailed("Selected occurrence must retain the exact old revision pin.")
    changed = copy.deepcopy(content)
    for occurrence in changed["assembly"]["occurrences"]:
        if (occurrence["local_id"],) in selected:
            occurrence["revision_id"] = str(candidate.id)
    replacement = Closure(user, changed, kind="assembly")
    # Root-owned descendant assignments and relationship paths cannot be dropped,
    # guessed or silently rebound to a changed descendant revision.
    addressed = {tuple(record["path"]) for record in content["assembly"].get("assignments", [])}
    root_refs = [
        ref
        for rel in closure.root.relationships
        for ref in refs(rel)
        if isinstance(ref, OccurrenceRef)
    ]
    addressed.update(tuple(ref.path) for ref in root_refs)
    for path in addressed:
        if path[:1] in selected and len(path) > 1:
            previous, next_node = closure.nodes.get(path), replacement.nodes.get(path)
            if (
                previous is None
                or next_node is None
                or previous.revision.id != next_node.revision.id
            ):
                raise Unsupported(
                    "A referenced or assigned descendant changed; explicit descendant"
                    "correspondence is required before adoption."
                )
    affected = [ref for ref in root_refs if tuple(ref.path) in selected and ref.feature_id]
    return changed, replacement, affected


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


def reviewed_content(user, snapshot, closure, old, candidate, paths, features):
    content, _, affected = selected_content(user, snapshot, closure, old, candidate, paths)
    mappings = {}
    selected = {tuple(path) for path in paths}
    old_contacts = contacts(user, old) if features or affected else set()
    candidate_contacts = contacts(user, candidate) if features or affected else set()
    for feature in features:
        path = tuple(feature["path"])
        key = (path, feature["old_feature_id"])
        if path not in selected or key in mappings:
            raise ValidationFailed("Correspondence must name unique selected occurrence features.")
        if (
            feature["old_feature_id"] not in old_contacts
            or feature["candidate_feature_id"] not in candidate_contacts
        ):
            raise ValidationFailed(
                "Correspondence must identify declared contacts on both exact revisions."
            )
        mappings[key] = feature["candidate_feature_id"]
    required = {(tuple(ref.path), ref.feature_id) for ref in affected}
    if required - mappings.keys():
        raise ValidationFailed(
            "Every affected authored feature requires explicit reviewed correspondence,"
            "including unchanged labels."
        )
    for relationship in content["assembly"].get("relationships", []):
        for value in relationship.values():
            if isinstance(value, dict) and value.get("kind") == "occurrence":
                key = (tuple(value["path"]), value.get("feature_id"))
                if key in mappings:
                    value["feature_id"] = mappings[key]
    Closure(user, content, kind="assembly")
    return content


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
    )
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
    return proposal, snapshot, closure, old, candidate, reviews


def state(reviews):
    return f"upgrade-v{reviews[-1].version if reviews else 0}"


def result(user, proposal_id):
    proposal, snapshot, closure, old, candidate, reviews = rows(user, proposal_id)
    _, replacement, affected = selected_content(
        user, snapshot, closure, old, candidate, proposal.paths
    )
    baseline = json.loads(bytes(snapshot.canonical))["content"]
    latest = reviews[-1] if reviews else None
    return {
        "proposal_id": str(proposal.id),
        "owning_snapshot_id": str(snapshot.id),
        "owning_definition_id": str(snapshot.definition_id),
        "owning_sha256": snapshot.sha256,
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
        "affected_features": [{"path": ref.path, "feature_id": ref.feature_id} for ref in affected],
        "occurrences": [
            {
                "path": list(path),
                "old_revision_id": str(closure.nodes[path].revision.id)
                if path in closure.nodes
                else None,
                "candidate_revision_id": str(replacement.nodes[path].revision.id)
                if path in replacement.nodes
                else None,
                "selected": path in {tuple(p) for p in proposal.paths},
                "old_placement": closure.nodes[path].occurrence.placement.model_dump(mode="json")
                if path in closure.nodes
                else None,
                "candidate_placement": replacement.nodes[path].occurrence.placement.model_dump(
                    mode="json"
                )
                if path in replacement.nodes
                else None,
                "old_assignments": (
                    closure.assignments.get(path) or closure.nodes[path].occurrence.assignments
                ).model_dump(mode="json")
                if path in closure.nodes
                else None,
                "candidate_assignments": (
                    replacement.assignments.get(path)
                    or replacement.nodes[path].occurrence.assignments
                ).model_dump(mode="json")
                if path in replacement.nodes
                else None,
            }
            for path in sorted(closure.nodes.keys() | replacement.nodes.keys())
        ],
        "relationships": baseline["assembly"].get("relationships", []),
        "old_relationships": [
            {"context_path": list(prefix), **rel.model_dump(mode="json")}
            for prefix, rel in closure.relationships
        ],
        "candidate_relationships": [
            {"context_path": list(prefix), **rel.model_dump(mode="json")}
            for prefix, rel in replacement.relationships
        ],
        "contextual_assignments": baseline["assembly"].get("assignments", []),
        "reviews": [
            {
                "review_id": str(review.id),
                "version": review.version,
                "decision": review.decision,
                "basis": review.basis,
                "features": review.features,
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
            "Direct assembly occurrences only.",
            "Reviewed correspondence is not physical or multidisciplinary qualification.",
            "An impact assessment does not change engineering validity.",
        ],
    }
