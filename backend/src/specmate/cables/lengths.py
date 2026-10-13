"""Independent declarations and explicitly reviewed, non-authoritative length models."""

from typing import Literal

from pydantic import Field, model_validator

from specmate.assemblies.contracts import StrictModel
from specmate.interfaces.contracts import Text, unique
from specmate.inventory.contracts import Amount, Quantity, quantity_add, quantity_subtract
from specmate.operations import ValidationFailed


class LengthDeclaration(StrictModel):
    amount_mm: Amount | None = None
    basis: Literal["unknown", "human_declaration"] = "unknown"
    explanation: Text | None = None

    @model_validator(mode="after")
    def consistent(self):
        if self.amount_mm is not None:
            if self.amount_mm <= 0:
                raise ValueError("Declared lengths must be positive.")
            Quantity(amount=self.amount_mm, unit="mm")
            if self.basis != "human_declaration" or not self.explanation:
                raise ValueError("Known length requires an explicit human declaration basis.")
        return self


class Allowance(StrictModel):
    kind: Literal["slack", "preparation", "trim"]
    scope: Literal["whole_length", "endpoint"] = "whole_length"
    endpoint_id: str | None = Field(default=None, min_length=1, max_length=120)
    amount_mm: Amount | None = None
    explanation: Text

    @model_validator(mode="after")
    def nonnegative(self):
        if (self.scope == "endpoint") != (self.endpoint_id is not None):
            raise ValueError("Endpoint allowances require one explicit endpoint identity.")
        if self.amount_mm is not None:
            if self.amount_mm < 0:
                raise ValueError("Allowance must be nonnegative; trim explicitly subtracts.")
            Quantity(amount=self.amount_mm, unit="mm")
        return self


class LengthModel(StrictModel):
    source: Literal["route", "finished", "stock_cut"]
    allowances: list[Allowance] = Field(default_factory=list, max_length=32)
    review: Literal["unreviewed", "reviewed"] = "unreviewed"
    review_basis: Text | None = None

    @model_validator(mode="after")
    def reviewed(self):
        if self.review == "reviewed" and not self.review_basis:
            raise ValueError("Reviewed length models require a basis.")
        return self


class PreparedLength(StrictModel):
    declaration: LengthDeclaration = Field(default_factory=LengthDeclaration)
    model: LengthModel | None = None


class ConductorLength(PreparedLength):
    element_path: str = Field(min_length=1, max_length=1000)


class LengthPlan(StrictModel):
    route: LengthDeclaration = Field(default_factory=LengthDeclaration)
    finished: PreparedLength = Field(default_factory=PreparedLength)
    stock_cut: PreparedLength = Field(default_factory=PreparedLength)
    conductor_cuts: list[ConductorLength] = Field(default_factory=list, max_length=1024)

    @model_validator(mode="after")
    def ordered(self):
        unique([row.element_path for row in self.conductor_cuts])
        if self.finished.model and self.finished.model.source != "route":
            raise ValueError("Finished length model must reference route.")
        if self.stock_cut.model and self.stock_cut.model.source == "stock_cut":
            raise ValueError("Stock cut model must reference route or finished length.")
        return self


def project_lengths(plan, element_paths):
    """Never use declarations as fallback for unknown/unreviewed model results."""
    plan = plan or LengthPlan()
    known_paths = set(element_paths)
    if any(row.element_path not in known_paths for row in plan.conductor_cuts):
        raise ValidationFailed("Conductor cut must identify a conductive stock element.")
    values = {"route": plan.route.amount_mm}
    rows = [
        {
            "target": "route",
            "declaration": plan.route.model_dump(mode="json"),
            "model": None,
            "suggested_mm": None,
            "status": "declaration_only",
        }
    ]
    targets = [("finished", plan.finished), ("stock_cut", plan.stock_cut)]
    cuts = {row.element_path: row for row in plan.conductor_cuts}
    targets.extend(
        (f"conductor:{path}", cuts.get(path, PreparedLength())) for path in element_paths
    )
    for target, value in targets:
        model = value.model
        suggested = None
        status = "declaration_only"
        if model is not None:
            status = "unreviewed_model" if model.review != "reviewed" else "unknown_inputs"
            if (
                model.review == "reviewed"
                and values[model.source] is not None
                and all(item.amount_mm is not None for item in model.allowances)
            ):
                suggested = values[model.source]
                for item in model.allowances:
                    calculate = quantity_subtract if item.kind == "trim" else quantity_add
                    suggested = calculate(suggested, item.amount_mm)
                try:
                    if suggested <= 0:
                        raise ValueError("Nonpositive model result.")
                    Quantity(amount=suggested, unit="mm")
                except ValueError:
                    raise ValidationFailed(
                        "Length model result exceeds positive exact bounds."
                    ) from None
                status = "suggestion"
            values[target] = suggested
        else:
            values[target] = value.declaration.amount_mm
        rows.append(
            {
                "target": target,
                "declaration": value.declaration.model_dump(mode="json"),
                "model": model.model_dump(mode="json") if model else None,
                "suggested_mm": str(suggested) if suggested is not None else None,
                "status": status,
                "declaration_matches_suggestion": (
                    value.declaration.amount_mm == suggested
                    if suggested is not None and value.declaration.amount_mm is not None
                    else None
                ),
            }
        )
    return {
        "rows": rows,
        "geometry_route": "unsupported",
        "prepend": "unsupported",
        "physical_qualification": "not_evaluated",
        "application": "manual_review_required",
    }
