"""Frozen planning policy is distinct from assembly construction and stock usage."""

from typing import Literal
from uuid import UUID

from pydantic import Field, model_serializer, model_validator

from specmate.assemblies.contracts import LocalId, Path, StrictModel
from specmate.inventory.contracts import Amount, Unit

Purpose = Literal[
    "assembly_contents", "procurement", "pcb_fabrication", "pcb_population", "consumables"
]


class Count(StrictModel):
    status: Literal["known", "unknown"] = "unknown"
    amount: int | None = Field(default=None, strict=True, ge=1, le=1000000)
    unit: Literal["ea"] = "ea"

    @model_validator(mode="after")
    def consistent(self):
        if (self.status == "known") != (self.amount is not None):
            raise ValueError("Known counts require an amount; unknown counts cannot have one.")
        return self


class Policy(StrictModel):
    path: Path
    revision_id: UUID
    decision: Literal["make", "buy", "unknown"] = "unknown"
    basis: str = Field(min_length=1, max_length=1000)


class DemandQuantity(StrictModel):
    status: Literal["known", "unknown"] = "unknown"
    amount: Amount | None = None
    unit: Unit = "ea"

    @model_validator(mode="after")
    def consistent(self):
        if (self.status == "known") != (self.amount is not None):
            raise ValueError("Known demand requires an amount; unknown demand cannot have one.")
        return self


class WasteAllowance(StrictModel):
    quantity: DemandQuantity = Field(default_factory=DemandQuantity)
    basis: str = Field(min_length=1, max_length=1000)


class OccurrenceDemand(StrictModel):
    path: Path
    revision_id: UUID
    quantity: DemandQuantity = Field(default_factory=DemandQuantity)
    basis: str = Field(min_length=1, max_length=1000)
    waste: WasteAllowance | None = None


class Need(StrictModel):
    local_id: LocalId
    context_path: Path
    revision_id: UUID
    purpose: Literal["pcb_fabrication", "pcb_population", "consumables"]
    quantity: DemandQuantity = Field(default_factory=DemandQuantity)
    basis: str = Field(min_length=1, max_length=1000)
    waste: WasteAllowance | None = None


class InlineMaterialBinding(StrictModel):
    endpoint_id: LocalId | None = None
    layer_id: LocalId
    part_local_id: LocalId
    material_path: Path


class MaterialBinding(StrictModel):
    """One made wiring occurrence uses one retained input assembly, not extra copies."""

    wiring_path: Path
    wiring_revision_id: UUID
    inputs_path: Path
    inputs_revision_id: UUID
    basis: str = Field(min_length=1, max_length=2000)
    inline_parts: list[InlineMaterialBinding] = Field(default_factory=list, max_length=1024)

    @model_validator(mode="after")
    def distinct_paths(self):
        if not self.wiring_path or not self.inputs_path or not self.basis.strip():
            raise ValueError("Material bindings need nonempty occurrence paths and a basis.")
        if (
            self.wiring_path[: len(self.inputs_path)] == self.inputs_path
            or self.inputs_path[: len(self.wiring_path)] == self.wiring_path
        ):
            raise ValueError("Wiring and material input occurrences must have disjoint paths.")
        locators = [(p.endpoint_id, p.layer_id, p.part_local_id) for p in self.inline_parts]
        paths = [tuple(p.material_path) for p in self.inline_parts]
        if len(set(locators)) != len(locators) or len(set(paths)) != len(paths):
            raise ValueError("Map each inline use and physical material occurrence once.")
        return self


class BomPlan(StrictModel):
    schema_version: Literal["0.1"] = "0.1"
    assembly_revision_id: UUID
    quantity: Count = Field(default_factory=Count)
    scope_paths: list[Path] = Field(default_factory=list, max_length=5000)
    policies: list[Policy] = Field(default_factory=list, max_length=5000)
    needs: list[Need] = Field(default_factory=list, max_length=2000)
    occurrence_demands: list[OccurrenceDemand] = Field(default_factory=list, max_length=5000)

    material_bindings: list[MaterialBinding] = Field(default_factory=list, max_length=256)

    @model_serializer(mode="wrap")
    def omit_unrecorded_material_bindings(self, handler):
        data = handler(self)
        if not self.material_bindings:
            data.pop("material_bindings", None)
        return data

    @model_validator(mode="after")
    def unique(self):
        wiring = [tuple(b.wiring_path) for b in self.material_bindings]
        inputs = [tuple(b.inputs_path) for b in self.material_bindings]
        if len(set(wiring)) != len(wiring):
            raise ValueError("Bind each wiring occurrence once.")
        if any(
            a[: len(b)] == b or b[: len(a)] == a
            for index, a in enumerate(inputs)
            for b in inputs[:index]
        ):
            raise ValueError("Material input assemblies cannot overlap between wiring uses.")
        paths = [tuple(p.path) for p in self.policies]
        if len(set(paths)) != len(paths):
            raise ValueError("Each occurrence has at most one policy.")
        if len({n.local_id for n in self.needs}) != len(self.needs):
            raise ValueError("Need IDs must be unique.")
        scopes = [tuple(p) for p in self.scope_paths]
        for index, path in enumerate(scopes):
            if not path or any(
                path[: len(other)] == other or other[: len(path)] == path
                for other in scopes[:index]
            ):
                raise ValueError("Scopes must be nonempty, disjoint occurrence paths.")
        return self


class CreateBom(StrictModel):
    # The workspace collection that receives the item; omitted means the actor's only one.
    workspace_id: UUID | None = None
    name: str = Field(min_length=1, max_length=200)
    bom: BomPlan


class UpdateBom(StrictModel):
    draft_id: UUID
    bom: BomPlan


class CaptureBom(StrictModel):
    draft_id: UUID


class ReadBom(StrictModel):
    revision_id: UUID
    purpose: Purpose = "procurement"
