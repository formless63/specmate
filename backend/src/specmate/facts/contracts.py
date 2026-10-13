from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StringConstraints,
    model_validator,
)

from specmate.contracts import check_package_path
from specmate.facts.units import UNITS, convert


def bounded_decimal(value):
    # Inspect exact input before Pydantic's precision normalization can underflow.
    # Binary floats may already have rounded or underflowed during JSON decoding.
    if isinstance(value, bool) or not isinstance(value, str | int | Decimal):
        raise ValueError("Magnitude requires a decimal string or exact integer.")
    if isinstance(value, str) and len(value) > 200:
        raise ValueError("Invalid numeric magnitude.")
    try:
        number = value if isinstance(value, Decimal) else Decimal(str(value))
    except InvalidOperation:
        raise ValueError("Invalid numeric magnitude.") from None
    if not number.is_finite():
        raise ValueError("Magnitude must be finite.")
    digits = number.as_tuple()
    if len(digits.digits) > 100 or not -100 <= digits.exponent <= 100:
        raise ValueError("Magnitude exponent exceeds the supported range.")
    if number != 0 and number.adjusted() < -12:
        raise ValueError("Nonzero magnitude is below the supported precision.")
    return number


Number = Annotated[
    Decimal,
    Field(max_digits=24, decimal_places=12, allow_inf_nan=False),
    BeforeValidator(bounded_decimal, json_schema_input_type=str | StrictInt),
]
FeatureId = Annotated[str, StringConstraints(strip_whitespace=False, min_length=1, max_length=200)]
LocalId = Annotated[
    str, StringConstraints(strip_whitespace=False, pattern=r"^[a-z][a-z0-9_-]{0,79}$")
]
SourcePath = Annotated[
    str,
    StringConstraints(strip_whitespace=False, min_length=1, max_length=512),
    AfterValidator(check_package_path),
]
Key = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,79}$")]
Status = Literal["known", "unknown", "conflicting", "not_applicable", "not_evaluated"]
Method = Literal[
    "source_observation", "reviewed_association", "calculation", "measurement", "preference"
]
Purpose = Literal["general", "manufacturing", "clearance", "illustration", "rating", "preference"]
Role = Literal["actual", "nominal", "lower_bound", "upper_bound", "tolerance"]
Unit = Literal[*UNITS]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, allow_inf_nan=False)


class ProjectTarget(StrictModel):
    kind: Literal["project"]
    project_id: UUID


class DefinitionTarget(StrictModel):
    kind: Literal["definition"]
    definition_id: UUID
    feature_id: FeatureId | None = None


class RevisionTarget(StrictModel):
    kind: Literal["revision"]
    revision_id: UUID
    feature_id: FeatureId | None = None


class OccurrenceTarget(StrictModel):
    kind: Literal["occurrence"]
    snapshot_id: UUID
    path: list[LocalId] = Field(min_length=1, max_length=32)
    feature_id: FeatureId | None = None


class PhysicalUnitTarget(StrictModel):
    kind: Literal["physical_unit"]
    unit_id: UUID


Target = Annotated[
    ProjectTarget | DefinitionTarget | RevisionTarget | OccurrenceTarget | PhysicalUnitTarget,
    Field(discriminator="kind"),
]


class NumericValue(StrictModel):
    kind: Literal["quantity", "range", "tolerance"]
    dimension: Key
    unit: Unit
    magnitude: Number | None = None
    lower: Number | None = None
    upper: Number | None = None
    minus: Number | None = None
    plus: Number | None = None

    @model_validator(mode="after")
    def coherent(self):
        specification = UNITS.get(self.unit)
        if specification is None:
            raise ValueError("Unsupported unit.")
        if self.dimension != specification[0]:
            raise ValueError("Unit and dimension disagree.")
        expected = {
            "quantity": {"magnitude"},
            "range": {"lower", "upper"},
            "tolerance": {"minus", "plus"},
        }[self.kind]
        actual = {
            field
            for field in ("magnitude", "lower", "upper", "minus", "plus")
            if getattr(self, field) is not None
        }
        if actual != expected:
            raise ValueError("Numeric fields must match the declared value kind.")
        if self.kind == "range" and self.lower > self.upper:
            raise ValueError("Lower range bound exceeds upper bound.")
        if self.kind == "tolerance" and (self.minus < 0 or self.plus < 0):
            raise ValueError("Tolerance deltas cannot be negative.")
        if self.dimension == "count" and any(getattr(self, field) % 1 for field in actual):
            raise ValueError("Count quantities must be whole items.")
        return self

    def canonical(self):
        data = {"kind": self.kind, "dimension": self.dimension}
        for field in ("magnitude", "lower", "upper", "minus", "plus"):
            value = getattr(self, field)
            if value is not None:
                data["unit"], data[field] = convert(
                    value, self.unit, delta=self.kind == "tolerance"
                )
        return data


class TextValue(StrictModel):
    kind: Literal["text"]
    text: str = Field(min_length=1, max_length=2000)


class BooleanValue(StrictModel):
    kind: Literal["boolean"]
    value: StrictBool


Value = Annotated[NumericValue | TextValue | BooleanValue, Field(discriminator="kind")]


class Condition(StrictModel):
    property: Key
    status: Literal["known", "unknown"]
    value: Value | None = None

    @model_validator(mode="after")
    def coherent(self):
        if (self.status == "known") != (self.value is not None):
            raise ValueError("Only known conditions have a value.")
        return self


class Citation(StrictModel):
    kind: Literal["citation"]
    citation: str = Field(min_length=1, max_length=2000)


class SourceFileEvidence(StrictModel):
    kind: Literal["source_file"]
    bundle_revision_id: UUID
    path: SourcePath
    locator: str = Field(default="", max_length=200)


class AssertionEvidence(StrictModel):
    kind: Literal["assertion"]
    assertion_id: UUID


Evidence = Annotated[Citation | SourceFileEvidence | AssertionEvidence, Field(discriminator="kind")]


class Provenance(StrictModel):
    method: Method
    evidence: list[Evidence] = Field(min_length=1, max_length=50)
    observed_at: datetime | None = None
    instrument: str | None = Field(default=None, min_length=1, max_length=200)
    procedure: str | None = Field(default=None, min_length=1, max_length=2000)
    formula: str | None = Field(default=None, min_length=1, max_length=2000)
    algorithm_version: str | None = Field(default=None, min_length=1, max_length=200)

    @model_validator(mode="after")
    def coherent(self):
        if self.method == "measurement":
            if not self.observed_at or not self.instrument or not self.procedure:
                raise ValueError("Measurement requires time, instrument and procedure.")
        elif self.instrument is not None:
            raise ValueError("Instrument metadata belongs to measurements.")
        if self.observed_at and self.observed_at.tzinfo is None:
            raise ValueError("Observation time requires a timezone.")
        if self.method == "calculation":
            if (
                not self.formula
                or not self.algorithm_version
                or not any(isinstance(source, AssertionEvidence) for source in self.evidence)
            ):
                raise ValueError("Calculation requires a formula, version and assertion inputs.")
        elif self.formula is not None or self.algorithm_version is not None:
            raise ValueError("Formula metadata belongs to calculations.")
        return self


class FactContent(StrictModel):
    schema_version: Literal["0.1"] = "0.1"
    property: Key
    status: Status
    purpose: Purpose
    role: Role
    value: Value | None = None
    conditions: list[Condition] = Field(default_factory=list, max_length=30)
    basis: str = Field(min_length=1, max_length=4000)
    provenance: Provenance

    @model_validator(mode="after")
    def coherent(self):
        if (self.status == "known") != (self.value is not None):
            raise ValueError("Only known facts have values; unknown is never a default value.")
        if self.provenance.method == "preference" and self.purpose != "preference":
            raise ValueError("A preference cannot be an engineering rating or manufacturing fact.")
        if self.purpose == "preference" and self.provenance.method != "preference":
            raise ValueError("Preference purpose requires the preference assertion method.")
        if isinstance(self.value, NumericValue):
            if (self.role == "tolerance") != (self.value.kind == "tolerance"):
                raise ValueError("Tolerance values and nominal/bound values are distinct roles.")
            if self.role in {"lower_bound", "upper_bound"} and self.value.kind != "quantity":
                raise ValueError("A bound requires a single magnitude.")
        elif self.value is not None and self.role != "actual":
            raise ValueError("Text and boolean facts use the actual role.")
        properties = [condition.property for condition in self.conditions]
        if len(properties) != len(set(properties)):
            raise ValueError("Condition properties must be unique.")
        if (
            self.status == "conflicting"
            and len(
                [
                    source
                    for source in self.provenance.evidence
                    if isinstance(source, AssertionEvidence)
                ]
            )
            < 2
        ):
            raise ValueError("Declared conflicts must preserve at least two assertion references.")
        return self


class RegisterSubject(StrictModel):
    target: Target


class AppendFact(StrictModel):
    subject_id: UUID
    fact: FactContent


class FactQuery(StrictModel):
    property: Key | None = None
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=50, ge=1, le=100)


class ReadFacts(FactQuery):
    subject_id: UUID
