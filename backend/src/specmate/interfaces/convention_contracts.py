"""Conductor conventions: a shop's habits for what each conductor of a stock carries.

A convention is a preference. It ranks proposals and flags later deviations; it can never
make a check pass, and a conductor it does not mention stays unknown. A stock convention
pins one exact stock revision and maps its conductors, screens and drains; a color code is
general and maps wire colors. Both name signals only through one exact signal set revision.
"""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, model_validator

from specmate.assemblies.contracts import StrictModel, rename_keys
from specmate.interfaces.signal_contracts import SignalKey, SignalType

Text = Annotated[str, Field(min_length=1, max_length=200)]
ElementPath = Annotated[str, Field(min_length=1, max_length=1000, pattern=r"^[a-z][a-z0-9_.-]*$")]
Hex = Annotated[str, Field(pattern=r"^#[0-9a-fA-F]{6}$")]
ConductiveKind = Literal["conductor", "shield", "drain"]


class ConventionUse(StrictModel):
    """What a conductor is conventionally used for."""

    kind: Literal["signal", "signal_type", "return_of", "spare", "do_not_use"]
    signal_key: SignalKey | None = None
    signal_type: SignalType | None = None

    @model_validator(mode="after")
    def consistent(self):
        if self.kind in ("signal", "return_of"):
            if self.signal_key is None or self.signal_type is not None:
                raise ValueError("This use names a signal of the set and no signal type.")
        elif self.kind == "signal_type":
            if self.signal_type in (None, "unknown") or self.signal_key is not None:
                raise ValueError("A type-only use names a known signal type and no signal.")
        elif self.signal_key is not None or self.signal_type is not None:
            raise ValueError("A spare or unused conductor names no signal.")
        return self


_RULE_KEYS_V01 = {"colour": "color", "colour_hex": "color_hex"}


class ConventionRule(StrictModel):
    # Stock scope: the dot-separated path of one stock element ("stock.core-1.center").
    element_path: ElementPath | None = None
    # Color-code scope: a color name, optionally with the exact display color it means.
    color: Text | None = None
    color_hex: Hex | None = None
    element_kind: ConductiveKind | None = None
    use: ConventionUse
    preference: Literal["preferred", "allowed", "avoid"] = "preferred"
    basis: Text | None = None

    @model_validator(mode="before")
    @classmethod
    def upgrade(cls, value):
        # Pre-1.0: schema 0.1 rules spelled these keys "colour" and "colour_hex".
        return rename_keys(value, _RULE_KEYS_V01)

    @model_validator(mode="after")
    def one_matcher(self):
        if (self.element_path is None) == (self.color is None):
            raise ValueError("A rule matches either one stock element or one color.")
        if self.element_path is not None and (self.color_hex or self.element_kind):
            raise ValueError("A stock element rule carries no color or element kind.")
        if self.color is None and self.color_hex:
            raise ValueError("An exact display color needs a color name.")
        return self


class ConductorConvention(StrictModel):
    kind: Literal["conductor_convention"] = "conductor_convention"
    schema_version: Literal["0.2"] = "0.2"
    scope: Literal["stock", "color_code"] = "stock"
    stock_revision_id: UUID | None = None
    signal_set_revision_id: UUID
    description: Text | None = None
    rules: list[ConventionRule] = Field(default_factory=list, max_length=1000)
    review: Literal["unreviewed", "reviewed"] = "unreviewed"
    review_basis: Text | None = None

    @model_validator(mode="before")
    @classmethod
    def upgrade(cls, value):
        # Pre-1.0: schema 0.1 (stored or submitted) is read through the 0.2 shape.
        return upgrade_convention(value)

    @model_validator(mode="after")
    def consistent(self):
        if (self.scope == "stock") != (self.stock_revision_id is not None):
            raise ValueError("A stock convention pins one exact stock revision; a color code none.")
        if self.review == "reviewed" and not self.review_basis:
            raise ValueError("Reviewed conventions require a review basis.")
        seen = set()
        for rule in self.rules:
            if (rule.element_path is None) != (self.scope == "color_code"):
                raise ValueError("Every rule must match what its convention scope matches.")
            key = (
                rule.element_path
                if self.scope == "stock"
                else (rule.color.strip().casefold(), rule.element_kind)
            )
            if key in seen:
                raise ValueError("One element maps once; this match is already used.")
            seen.add(key)
        return self


def upgrade_convention(value):
    """Map schema 0.1 conductor convention content to 0.2; other content is unchanged.

    Only spellings change: the "colour_code" scope becomes "color_code" and each rule's
    "colour"/"colour_hex" become "color"/"color_hex". Frozen bytes are never rewritten.
    """
    if not isinstance(value, dict) or value.get("schema_version", "0.1") != "0.1":
        return value
    out = {**value, "schema_version": "0.2"}
    if out.get("scope") == "colour_code":
        out["scope"] = "color_code"
    if isinstance(out.get("rules"), list):
        out["rules"] = [rename_keys(rule, _RULE_KEYS_V01) for rule in out["rules"]]
    return out
