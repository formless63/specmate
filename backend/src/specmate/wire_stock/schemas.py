"""Versioned stock construction. Unknown dimensions remain explicit nulls.

Group layouts are engineering arrangement declarations, not electrical bonds.
Leaf IDs are local to their parent; a dot-separated path is stable across exports.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from specmate.operations import ValidationFailed

Positive = Annotated[float, Field(gt=0, allow_inf_nan=False)]
Nonnegative = Annotated[float, Field(ge=0, allow_inf_nan=False)]
Coordinate = Annotated[float, Field(allow_inf_nan=False)]
ElementId = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Fact(StrictModel):
    value: float | str | None = None
    unit: str | None = None
    source: str | None = Field(default=None, max_length=1000)
    status: Literal["unknown", "documented", "measured", "inferred"] = "unknown"

    @model_validator(mode="after")
    def known_value(self):
        if (self.status == "unknown") != (self.value is None):
            raise ValueError("Unknown facts have no value; known facts require a value.")
        if self.status != "unknown" and not self.source:
            raise ValueError("Known facts require a source.")
        return self


class ElementBase(StrictModel):
    id: ElementId
    label: str = Field(min_length=1, max_length=200)
    material: str | None = Field(default=None, max_length=200)
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    source: str | None = Field(default=None, max_length=1000)
    # Explicit offsets locate interstitial elements without a hidden workshop rule.
    x_mm: Coordinate = 0
    y_mm: Coordinate = 0


class RoundElement(ElementBase):
    kind: Literal["conductor", "dielectric", "insulation", "shield", "drain", "filler", "jacket"]
    outer_diameter_mm: Positive | None = None
    inner_diameter_mm: Nonnegative | None = None
    construction: Literal["solid", "stranded", "braid", "spiral", "foil", "tape"] | None = None
    area_mm2: Positive | None = None

    @model_validator(mode="after")
    def boundaries(self):
        if (
            self.outer_diameter_mm is not None
            and self.inner_diameter_mm is not None
            and self.inner_diameter_mm >= self.outer_diameter_mm
        ):
            raise ValueError("Inner diameter must be smaller than outer diameter.")
        return self


class WebElement(ElementBase):
    kind: Literal["web"]
    width_mm: Positive | None = None
    height_mm: Positive | None = None


class GroupElement(ElementBase):
    kind: Literal["group"]
    role: Literal["stock", "coax", "pair", "ribbon", "figure-eight", "bundle"]
    arrangement: Literal["concentric", "ring", "linear", "figure-eight"] = "concentric"
    pitch_mm: Positive | None = None
    direction: Literal["cw", "ccw"] = "ccw"
    children: list[Element] = Field(default_factory=list, max_length=128)

    @model_validator(mode="after")
    def sibling_ids(self):
        if len({child.id for child in self.children}) != len(self.children):
            raise ValueError("Sibling element IDs must be unique.")
        if self.arrangement == "figure-eight":
            groups = [child for child in self.children if isinstance(child, GroupElement)]
            if len(groups) != 2:
                raise ValueError("Figure-eight arrangements require exactly two leg groups.")
        return self


Element = Annotated[RoundElement | WebElement | GroupElement, Field(discriminator="kind")]
GroupElement.model_rebuild()


class StockSpecification(StrictModel):
    schema_version: Literal["1"] = "1"
    construction: Literal["coax", "pair", "ribbon", "figure-eight", "bundle"]
    viewed_from: Literal["a", "b", "unknown"] = "unknown"
    structure: GroupElement
    facts: dict[str, Fact] = Field(default_factory=dict, max_length=50)

    @model_validator(mode="after")
    def bounded_tree(self):
        def visit(node: Element, depth: int) -> int:
            if depth > 12:
                raise ValueError("Stock element nesting exceeds 12 levels.")
            return (
                1 + sum(visit(c, depth + 1) for c in node.children)
                if isinstance(node, GroupElement)
                else 1
            )

        if visit(self.structure, 0) > 1024:
            raise ValueError("Stock exceeds 1024 elements.")
        if self.structure.role != "stock":
            raise ValueError("The root group must have stock role.")
        return self


def validate_stock_content(content: dict) -> dict:
    """Owning validation hook for shared create/edit/freeze operations.

    An unfinished generic stock draft may have no discipline payload yet.
    A present payload must be typed, including when generic commands mutate it.
    """
    if "stock" not in content:
        return content
    try:
        stock = StockSpecification.model_validate(content["stock"])
    except ValidationError as exc:
        errors = [{"loc": list(e["loc"]), "type": e["type"], "msg": e["msg"]} for e in exc.errors()]
        raise ValidationFailed("Invalid stock construction.", details={"errors": errors}) from None
    return {**content, "stock": stock.model_dump(mode="json")}
