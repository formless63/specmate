"""Fresh authorized contextual choices for canonical placement and mounting authoring."""

from dataclasses import replace
from uuid import UUID

from specmate.access.permissions import Perm
from specmate.assemblies.contracts import StrictModel
from specmate.assemblies.queries import Closure
from specmate.catalog_matching.queries import current_actor
from specmate.design.operations import authorize_snapshot, scoped_draft
from specmate.operations import Context, ValidationFailed, operation


class PlacementInputs(StrictModel):
    draft_id: UUID


@operation(
    "assembly.placement_inputs",
    PlacementInputs,
    summary="Inspect authorized exact nested occurrence choices for placement and mounting.",
    supports_idempotency=False,
)
def inspect_inputs(ctx: Context, p: PlacementInputs):
    user = current_actor(ctx.user)
    draft = scoped_draft(replace(ctx, user=user), p.draft_id, Perm.WORKSPACE_READ)
    if draft.base_revision_id:
        authorize_snapshot(user, draft.base_revision.snapshot)
    closure = Closure(user, draft.content, kind=draft.definition.kind)
    if draft.definition.kind != "assembly" or closure.root is None:
        raise ValidationFailed("Select an assembly draft.")
    return {
        "draft_id": str(draft.id),
        "state": draft.state_token,
        "definition_id": str(draft.definition_id),
        "unit": "mm",
        "frame": "right_handed_z_up",
        "occurrences": [
            {
                "path": list(path),
                "parent_path": list(path[:-1]),
                "definition_id": str(node.revision.definition_id),
                "revision_id": str(node.revision.id),
                "snapshot_sha256": node.revision.snapshot.sha256,
                "name": node.revision.definition.name,
                "kind": node.revision.definition.kind,
                "display_ref": node.occurrence.display_ref,
                "placement": node.occurrence.placement.model_dump(mode="json"),
                "placement_frame": "containing_assembly",
                "feature_existence": "not_evaluated",
            }
            for path, node in closure.nodes.items()
        ],
        "relationships": [
            {"context_path": list(prefix), **relationship.model_dump(mode="json")}
            for prefix, relationship in closure.relationships
        ],
        "geometry_validation": "not_performed",
        "fit": "not_evaluated",
        "clearance": "not_evaluated",
        "physical_qualification": False,
    }
