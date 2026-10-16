"""Bounded declarative stock compilation from exact reusable constituent revisions.

No expression language, imported code or runtime tool executes. Formulas are explicit
physical constructions, and every derived field records its inputs and working.
"""

from __future__ import annotations

import json
import math
from copy import deepcopy
from typing import Literal
from uuid import UUID

from pydantic import Field, ValidationError, model_validator

from specmate.access.permissions import Perm, authorize
from specmate.design.models import Revision
from specmate.operations import NotFound, ValidationFailed
from specmate.wire_stock.schemas import Fact, StockSpecification, StrictModel

FIELDS = {
    "outer_diameter_mm",
    "inner_diameter_mm",
    "insulated_diameter_mm",
    "area_mm2",
    "material",
    "color",
    "insulation_material",
    "construction",
    "strand_count",
    "strand_diameter_mm",
    "wall_mm",
    "thickness_mm",
    "coverage_pct",
    "nominal_diameter_mm",
    "strand_tolerance_mm",
    "diameter_tolerance_mm",
    "lay_length_mm",
    "lay_tolerance_mm",
    "shield_diameter_mm",
    "lay_hand",
    "formation",
    "awg",
    "built_as",
}
TARGETS = {
    "outer_diameter_mm",
    "inner_diameter_mm",
    "insulated_diameter_mm",
    "area_mm2",
    "material",
    "color",
    "insulation_material",
    "construction",
}


class Constituent(StrictModel):
    kind: Literal["conductor", "insulation", "shield", "jacket", "core"]
    values: dict[str, Fact] = Field(default_factory=dict, max_length=30)
    source: str = Field(min_length=1, max_length=1000)
    components: list[ConstituentPin] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def bounded_fields(self):
        if self.components and self.kind != "core":
            raise ValueError("Only composite core constituents declare component pins.")
        if len({pin.local_id for pin in self.components}) != len(self.components):
            raise ValueError("Composite component IDs must be distinct.")
        if not set(self.values) <= FIELDS:
            raise ValueError("Unsupported constituent field.")
        for field, fact in self.values.items():
            if field.endswith("_mm") or field in {"area_mm2", "strand_count"}:
                if fact.value is not None and (
                    not isinstance(fact.value, (int, float))
                    or fact.value < 0
                    or (fact.value == 0 and "tolerance" not in field)
                ):
                    raise ValueError("Dimensions and strand counts must be positive or unknown.")
                if (
                    field == "strand_count"
                    and fact.value is not None
                    and int(fact.value) != fact.value
                ):
                    raise ValueError("Strand count must be an integer.")
                expected = (
                    "mm2" if field == "area_mm2" else None if field == "strand_count" else "mm"
                )
                if fact.value is not None and fact.unit != expected:
                    raise ValueError("Constituent field units must be explicit canonical units.")
            elif fact.value is not None and not isinstance(fact.value, str):
                raise ValueError("Material, color and construction facts must be strings.")
        return self


class ConstituentPin(StrictModel):
    local_id: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    revision_id: UUID
    snapshot_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


Constituent.model_rebuild()


class Input(StrictModel):
    constituent_local_id: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    field: str


class Binding(StrictModel):
    element_path: str = Field(min_length=1, max_length=1000)
    target_field: str
    formula: Literal[
        "identity",
        "conductor_area",
        "stranded_diameter",
        "over_layer_diameter",
        "adjacent_boundary",
        "insulation_diameter",
        "shield_diameter",
        "insulation_material",
    ] = "identity"
    inputs: list[Input] = Field(min_length=1, max_length=2)
    round_digits: int | None = Field(default=None, ge=0, le=6)

    @model_validator(mode="after")
    def supported(self):
        if self.target_field not in TARGETS or any(row.field not in FIELDS for row in self.inputs):
            raise ValueError("Unsupported stock binding field.")
        required = (
            1
            if self.formula
            in {
                "identity",
                "adjacent_boundary",
                "insulation_diameter",
                "shield_diameter",
                "insulation_material",
            }
            else 2
        )
        if len(self.inputs) != required:
            raise ValueError("Formula argument count mismatch.")
        fields = [row.field for row in self.inputs]
        if self.formula in {"conductor_area", "stranded_diameter"}:
            if fields != ["strand_count", "strand_diameter_mm"]:
                raise ValueError(
                    "Strand formulas require count and strand diameter in millimeters."
                )
            if self.target_field != (
                "area_mm2" if self.formula == "conductor_area" else "outer_diameter_mm"
            ):
                raise ValueError("Strand formula output units do not match target.")
        if self.formula == "over_layer_diameter":
            if (
                fields[0] not in {"outer_diameter_mm", "insulated_diameter_mm"}
                or fields[1] not in {"wall_mm", "thickness_mm"}
                or not self.target_field.endswith("diameter_mm")
            ):
                raise ValueError(
                    "Layer formula requires inner diameter and wall thickness in millimeters."
                )
        if self.formula == "adjacent_boundary" and (
            self.target_field != "inner_diameter_mm"
            or fields[0] not in {"outer_diameter_mm", "insulated_diameter_mm"}
        ):
            raise ValueError(
                "Adjacent boundaries require the explicit inner element outer diameter."
            )
        if self.formula == "insulation_diameter" and (
            self.target_field != "insulated_diameter_mm" or fields != ["outer_diameter_mm"]
        ):
            raise ValueError("Insulation diameter requires an explicit insulation outer diameter.")
        if self.formula == "shield_diameter" and (
            self.target_field != "outer_diameter_mm" or fields != ["shield_diameter_mm"]
        ):
            raise ValueError(
                "Shield diameter requires the explicitly declared assembled shield diameter."
            )
        if self.formula == "insulation_material" and (
            self.target_field != "insulation_material" or fields != ["material"]
        ):
            raise ValueError("Insulation material requires an explicit material declaration.")
        if self.formula == "identity" and fields[0] != self.target_field:
            raise ValueError("Identity bindings preserve field meaning and units.")
        return self


class StockRecipe(StrictModel):
    schema_version: Literal["1"] = "1"
    template: StockSpecification
    constituents: list[ConstituentPin] = Field(min_length=1, max_length=128)
    bindings: list[Binding] = Field(default_factory=list, max_length=1024)
    source: str = Field(min_length=1, max_length=1000)
    recompute_layout: Literal["preserve", "touching_ring"] = "preserve"
    recompute_boundaries: bool = False

    @model_validator(mode="after")
    def unique(self):
        ids = [pin.local_id for pin in self.constituents]
        if len(set(ids)) != len(ids):
            raise ValueError("Constituent local IDs must be unique.")
        pairs = [(binding.element_path, binding.target_field) for binding in self.bindings]
        if len(set(pairs)) != len(pairs):
            raise ValueError("A compiled field has one binding.")
        if any(
            row.constituent_local_id not in ids
            for binding in self.bindings
            for row in binding.inputs
        ):
            raise ValueError("Binding input must name a pinned constituent.")
        return self


def parse_recipe(value):
    try:
        return StockRecipe.model_validate(value)
    except ValidationError as error:
        raise ValidationFailed(
            "Invalid stock recipe.", details={"errors": error.errors(include_context=False)}
        ) from None


def resolve_constituents(user, definition, recipe):
    from specmate.design.operations import authorize_snapshots

    authorize(user, definition.workspace_id, Perm.WORKSPACE_READ)
    found = {
        row.id: row
        for row in Revision.objects.select_related("definition", "snapshot").filter(
            id__in=[p.revision_id for p in recipe.constituents],
            definition__workspace_id=definition.workspace_id,
        )
    }
    if len(found) != len({p.revision_id for p in recipe.constituents}):
        raise NotFound("Stock constituent unavailable.")
    authorize_snapshots(user, [row.snapshot for row in found.values()])
    result = {}
    for pin in recipe.constituents:
        revision = found[pin.revision_id]
        if revision.snapshot.sha256 != pin.snapshot_sha256 or revision.definition.kind != "part":
            raise ValidationFailed("Constituent requires an exact part revision and snapshot hash.")
        data = json.loads(bytes(revision.snapshot.canonical))["content"].get("stock_constituent")
        try:
            result[pin.local_id] = Constituent.model_validate(data)
        except ValidationError:
            raise ValidationFailed(
                "Pinned part has no valid stock constituent declaration."
            ) from None
    return result


def compile_stock(recipe, constituents):
    """Pure compiler. Exact pins are resolved separately through shared authority."""
    result = deepcopy(recipe.template.model_dump(mode="json"))
    elements = {}

    def visit(node, path):
        elements[path] = node
        for child in node.get("children", []):
            visit(child, path + "." + child["id"])

    visit(result["structure"], result["structure"]["id"])
    for binding in recipe.bindings:
        node = elements.get(binding.element_path)
        if node is None or node["kind"] in {"group", "web"}:
            raise ValidationFailed("Binding requires an exact round element path.")
        values, sources, statuses, inferred = [], [], [], False
        for item in binding.inputs:
            fact = constituents[item.constituent_local_id].values.get(item.field)
            if fact is None:
                raise ValidationFailed(
                    "Constituent is missing a bound field; declare unknown explicitly."
                )
            values.append(fact.value)
            statuses.append(fact.status)
            sources.append(
                f"{item.constituent_local_id}.{item.field}={fact.value} {fact.unit or ''}"
            )
            inferred |= fact.status == "inferred"
        if any(value is None for value in values):
            value = None
        elif binding.formula in {
            "identity",
            "adjacent_boundary",
            "insulation_diameter",
            "shield_diameter",
            "insulation_material",
        }:
            value = values[0]
        elif binding.formula == "conductor_area":
            value = values[0] * math.pi * values[1] * values[1] / 4
        elif binding.formula == "stranded_diameter":
            count, strand = values
            value = (
                strand
                if count == 1
                else 3 * strand
                if count == 7
                else 1.15 * math.sqrt(count) * strand
            )
            inferred |= count != 1
        else:
            value = values[0] + 2 * values[1]
        if isinstance(value, (int, float)) and not math.isfinite(value):
            raise ValidationFailed("Derived stock dimension is nonfinite.")
        if binding.round_digits is not None and value is not None:
            if not isinstance(value, (int, float)):
                raise ValidationFailed("Only numeric derived values can be rounded.")
            scale = 10**binding.round_digits
            value = math.floor(value * scale + 0.5) / scale
        node[binding.target_field] = value
        unit = (
            "mm2"
            if binding.target_field == "area_mm2"
            else "mm"
            if binding.target_field.endswith("_mm")
            else None
        )
        working = (
            f"{binding.formula}({', '.join(sources)}), "
            f"round_digits={binding.round_digits}; exact pins in stock_recipe"
        )
        node.setdefault("facts", {})["compiled_" + binding.target_field] = {
            "value": value,
            "unit": unit,
            "source": working if value is not None else None,
            "status": "unknown"
            if value is None
            else "inferred"
            if inferred
            else "measured"
            if binding.formula
            in {
                "identity",
                "adjacent_boundary",
                "insulation_diameter",
                "shield_diameter",
                "insulation_material",
            }
            and statuses == ["measured"]
            else "documented",
        }
        node["facts"][binding.target_field] = deepcopy(
            node["facts"]["compiled_" + binding.target_field]
        )
    if recipe.recompute_boundaries:
        originals = {}

        def original_nodes(node, path):
            originals[path] = node
            for child in node.get("children", []):
                original_nodes(child, path + "." + child["id"])

        original_nodes(
            recipe.template.model_dump(mode="json")["structure"], result["structure"]["id"]
        )

        def boundaries(node, path):
            children = node.get("children", [])
            before_outer = after_outer = 0.0
            aggregate = sum(
                child["kind"] in {"group", "conductor", "drain"} for child in children
            ) > 1 or any(child["kind"] == "group" for child in children)
            if aggregate:
                before_outer = after_outer = None
            for child in children:
                child_path = path + "." + child["id"]
                original = originals[child_path]
                if child["kind"] == "group":
                    boundaries(child, child_path)
                    continue
                inner = original.get("inner_diameter_mm")
                if (
                    child["kind"] in {"dielectric", "insulation", "shield", "jacket"}
                    and inner is not None
                    and inner == before_outer
                ):
                    child["inner_diameter_mm"] = after_outer
                    child.setdefault("facts", {})["compiled_inner_diameter_mm"] = {
                        "value": after_outer,
                        "unit": "mm",
                        "source": "Declared adjacent concentric boundary, recompute_boundaries"
                        if after_outer is not None
                        else None,
                        "status": "inferred" if after_outer is not None else "unknown",
                    }
                    child["facts"]["inner_diameter_mm"] = deepcopy(
                        child["facts"]["compiled_inner_diameter_mm"]
                    )
                before_outer = original.get("insulated_diameter_mm") or original.get(
                    "outer_diameter_mm"
                )
                after_outer = child.get("insulated_diameter_mm") or child.get("outer_diameter_mm")
                if aggregate and child["kind"] in {"conductor", "drain"}:
                    before_outer = after_outer = None

        boundaries(result["structure"], result["structure"]["id"])
    if recipe.recompute_layout == "touching_ring" and result.get("lay"):
        lay = result["lay"]

        def diameter(node):
            if node["kind"] != "group":
                return node.get("insulated_diameter_mm") or node.get("outer_diameter_mm")
            layers = [child for child in node["children"] if child["kind"] != "drain"]
            return diameter(layers[-1]) if layers else None

        ring = [elements[path] for path in lay["ring"]]
        inner = [elements[path] for path in lay["inner"]]
        center = elements.get(lay["center"])
        sizes = [diameter(node) for node in ring + inner + ([center] if center else [])]
        if lay["arrangement"] != "figure-8":
            radius = None
            if all(size is not None for size in sizes):
                rc = max(diameter(node) for node in ring) / 2
                core = max(
                    diameter(center) / 2 if center else 0, sum(diameter(node) for node in inner) / 2
                )
                radius = max(rc / math.sin(math.pi / len(ring)), rc + core)
            for index, node in enumerate(ring):
                angle = -math.pi / 2 + (
                    -1 if lay["direction"] == "ccw" else 1
                ) * 2 * math.pi * index / len(ring)
                node["x_mm"] = radius * math.cos(angle) if radius is not None else None
                node["y_mm"] = radius * math.sin(angle) if radius is not None else None
                node.setdefault("facts", {})["compiled_layout_radius"] = {
                    "value": radius,
                    "unit": "mm",
                    "source": "R=max(r/sin(pi/n),r+inner_span), touching_ring layout"
                    if radius is not None
                    else None,
                    "status": "inferred" if radius is not None else "unknown",
                }
                node["facts"]["layout_radius_mm"] = deepcopy(
                    node["facts"]["compiled_layout_radius"]
                )
            x = -sum(diameter(node) for node in inner) / 2 if radius is not None else None
            for node in inner:
                node["x_mm"] = x + diameter(node) / 2 if x is not None else None
                node["y_mm"] = 0 if x is not None else None
                if x is not None:
                    x += diameter(node)
            if center:
                center["x_mm"] = center["y_mm"] = 0 if radius is not None else None
    try:
        return StockSpecification.model_validate(result).model_dump(mode="json")
    except ValidationError as error:
        raise ValidationFailed(
            "Compiled stock violates construction boundaries.",
            details={"errors": error.errors(include_context=False)},
        ) from None


def dependency_revisions(user, definition, content):
    if "stock_recipe" not in content:
        return []
    recipe = parse_recipe(content["stock_recipe"])
    constituents = resolve_constituents(user, definition, recipe)
    if compile_stock(recipe, constituents) != StockSpecification.model_validate(
        content.get("stock")
    ).model_dump(mode="json"):
        raise ValidationFailed(
            "Compiled stock differs from its recipe; use wire_stock.compile_recipe."
        )
    return sorted({pin.revision_id for pin in recipe.constituents}, key=str)


def constituent_dependencies(user, definition, content):
    if "stock_constituent" not in content:
        return []
    try:
        value = Constituent.model_validate(content["stock_constituent"])
    except ValidationError:
        raise ValidationFailed("Invalid stock constituent.") from None
    if not value.components:
        return []

    # Same resolver for composites, with no executable or implicit component behavior.
    class Pins:
        constituents = value.components

    resolve_constituents(user, definition, Pins())
    return sorted({pin.revision_id for pin in value.components}, key=str)
