"""Exact correspondence between wiring uses and retained material occurrences."""

from specmate.bom.inline_parts import inline_parts
from specmate.operations import ValidationFailed


def validate(closure):
    """Owning closure authority is already checked before any matching diagnostics."""
    plan, nodes = closure.plan, closure.assembly.nodes
    policies = {tuple(p.path): p for p in plan.policies}
    demands = {tuple(d.path): d for d in plan.occurrence_demands}
    for binding in plan.material_bindings:
        wiring_path, inputs_path = tuple(binding.wiring_path), tuple(binding.inputs_path)
        wiring, inputs = nodes.get(wiring_path), nodes.get(inputs_path)
        if (
            wiring is None
            or inputs is None
            or wiring.revision.id != binding.wiring_revision_id
            or inputs.revision.id != binding.inputs_revision_id
        ):
            raise ValidationFailed(
                "Material binding must match exact retained occurrence revisions."
            )
        if (
            wiring.revision.definition.kind not in {"cable", "harness", "end_assembly"}
            or inputs.revision.definition.kind != "assembly"
        ):
            raise ValidationFailed(
                "Material binding requires a wiring use and a distinct input assembly."
            )
        if wiring_path not in policies or policies[wiring_path].decision != "make":
            raise ValidationFailed("A bound wiring occurrence requires an explicit make policy.")
        expected = {
            (p["endpoint_id"], p["layer_id"], p["part_local_id"]): revision.id
            for p, revision in inline_parts(wiring.revision, closure.revisions)
        }
        provided = {}
        for part in binding.inline_parts:
            locator = part.endpoint_id, part.layer_id, part.part_local_id
            material_path = tuple(part.material_path)
            material = nodes.get(material_path)
            if (
                material_path[: len(inputs_path)] != inputs_path
                or len(material_path) <= len(inputs_path)
                or material is None
            ):
                raise ValidationFailed(
                    "Inline material must be retained inside the exact input assembly."
                )
            if locator not in expected or material.revision.id != expected[locator]:
                raise ValidationFailed(
                    "Inline material binding must match the same exact catalog Part revision."
                )
            demand = demands.get(material_path)
            if demand and (demand.quantity.unit != "ea" or demand.quantity.amount not in (None, 1)):
                raise ValidationFailed(
                    "One physical inline use maps to one material occurrence; "
                    "declare extra procurement as waste."
                )
            provided[locator] = material_path
        if set(provided) != set(expected):
            raise ValidationFailed("Material binding must map every exact inline Part use once.")
