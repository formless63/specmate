"""Explicit declaration scopes; unknown operating conditions are never defaults."""

from typing import Annotated, Literal

from pydantic import Field, model_validator

from specmate.assemblies.contracts import LocalId, StrictModel
from specmate.catalog_matching.contracts import EvidenceInput
from specmate.contracts import FiniteNumber

Polarity = Literal["unknown", "positive", "negative", "reference", "nonpolarized"]
Text = Annotated[str, Field(min_length=1, max_length=2000)]


class TemperatureEnvelope(StrictModel):
    minimum_c: FiniteNumber
    maximum_c: FiniteNumber

    @model_validator(mode="after")
    def ordered(self):
        if self.minimum_c < -273.15 or self.minimum_c > self.maximum_c:
            raise ValueError("Temperature envelope must be ordered and above absolute zero.")
        return self


class RatingScope(StrictModel):
    temperature: TemperatureEnvelope | None = None
    mode: Text | None = None

    @model_validator(mode="after")
    def explicit(self):
        if self.temperature is None and self.mode is None:
            raise ValueError("A conditional rating requires a temperature envelope or named mode.")
        return self


class ConditionalRating(StrictModel):
    local_id: LocalId
    dimension: Literal["voltage", "current"]
    minimum: FiniteNumber | None = None
    maximum: FiniteNumber
    scope: RatingScope
    basis: Text
    evidence: EvidenceInput = Field(default_factory=EvidenceInput)

    @model_validator(mode="after")
    def limits(self):
        if self.dimension == "voltage":
            if self.minimum is None or self.minimum > self.maximum:
                raise ValueError("Voltage ratings require an ordered inclusive envelope.")
        elif self.minimum is not None or self.maximum < 0:
            raise ValueError("Current ratings require a nonnegative maximum only.")
        return self
