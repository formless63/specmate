"""Typed PCB population decisions over one accepted, immutable interpretation."""

from __future__ import annotations

import json
from contextvars import ContextVar
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from specmate.access.permissions import Perm, authorize
from specmate.catalog.models import Representation
from specmate.design.models import Revision
from specmate.design.operations import authorize_snapshot
from specmate.operations import NotFound, ValidationFailed
from specmate.pcb.models import PcbInterpretation
from specmate.pcb.report import Report
from specmate.sources.models import SourceBundleFile


class StrictRecord(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Evidence(StrictRecord):
    """Either an attributable statement or one exact, rights-bearing source file."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)

    kind: Literal["citation", "source_file"]
    citation: str | None = Field(default=None, min_length=1, max_length=2000)
    source_revision_id: UUID | None = None
    path: str | None = Field(default=None, min_length=1, max_length=512)
    sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    rights: str | None = Field(default=None, min_length=1, max_length=200)

    @model_validator(mode="after")
    def complete(self):
        file_values = (self.source_revision_id, self.path, self.sha256, self.rights)
        if self.kind == "citation" and (
            not self.citation or any(v is not None for v in file_values)
        ):
            raise ValueError("Citation evidence needs a citation and no source-file fields.")
        if self.kind == "source_file" and (
            self.citation is not None or any(v is None for v in file_values)
        ):
            raise ValueError("Source-file evidence needs exact revision, path, hash and rights.")
        return self


class ComponentDecision(StrictRecord):
    component_id: UUID
    status: Literal["populate", "omit"] | None = None
    basis: str | None = Field(default=None, min_length=1, max_length=2000)

    @model_validator(mode="after")
    def basis_for_decision(self):
        if (self.status is None) != (self.basis is None):
            raise ValueError("An explicit population decision needs a basis; unknown has none.")
        return self


class PopulationOption(StrictRecord):
    local_id: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    name: str = Field(min_length=1, max_length=200)
    decisions: list[ComponentDecision] = Field(max_length=100000)

    @model_validator(mode="after")
    def unique_components(self):
        if len({d.component_id for d in self.decisions}) != len(self.decisions):
            raise ValueError("A component can have only one decision per option.")
        return self


class Association(StrictRecord):
    local_id: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    kind: Literal["port", "model", "library"]
    component_id: UUID
    pad_id: UUID | None = None
    target_revision_id: UUID | None = None
    target_contact_id: str | None = Field(default=None, min_length=1, max_length=100)
    representation_id: UUID | None = None
    review: Literal["candidate", "accepted", "rejected"] = "candidate"
    basis: str | None = Field(default=None, min_length=1, max_length=2000)
    evidence: Evidence | None = None

    @model_validator(mode="after")
    def target_shape(self):
        if self.kind == "port":
            if (
                not all((self.pad_id, self.target_revision_id, self.target_contact_id))
                or self.representation_id
            ):
                raise ValueError("A port candidate pins a pad, pinout revision and contact.")
        elif self.kind == "model":
            if not self.representation_id or any(
                (self.pad_id, self.target_revision_id, self.target_contact_id)
            ):
                raise ValueError("A model candidate pins one catalog representation.")
        elif not self.target_revision_id or any(
            (self.pad_id, self.representation_id, self.target_contact_id)
        ):
            raise ValueError("A library candidate pins one design revision.")
        if self.review != "candidate" and (not self.basis or self.evidence is None):
            raise ValueError("A reviewed decision needs a basis and evidence.")
        return self


class Population(StrictRecord):
    schema_version: Literal["1"] = "1"
    interpretation_id: UUID
    interpretation_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    source_revision_id: UUID
    source_manifest_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    options: list[PopulationOption] = Field(default_factory=list, max_length=100)
    associations: list[Association] = Field(default_factory=list, max_length=10000)

    @model_validator(mode="after")
    def unique_ids(self):
        for rows in (self.options, self.associations):
            if len({row.local_id for row in rows}) != len(rows):
                raise ValueError("Local IDs must be unique within their collection.")
        return self


def parse_content(content: dict, kind: str | None = None) -> Population | None:
    if kind == "pcb_population" and set(content) != {"pcb_population"}:
        raise ValidationFailed("A PCB population definition requires only typed PCB content.")
    if "pcb_population" not in content:
        return None
    if kind is not None and kind != "pcb_population":
        raise ValidationFailed("PCB population content requires a pcb_population definition.")
    try:
        return Population.model_validate(content["pcb_population"])
    except ValidationError as exc:
        errors = [{"loc": list(e["loc"]), "type": e["type"], "msg": e["msg"]} for e in exc.errors()]
        raise ValidationFailed(
            "Invalid PCB population content.", details={"errors": errors}
        ) from None


def validate_content(kind: str, content: dict) -> dict:
    population = parse_content(content, kind)
    return {"pcb_population": population.model_dump(mode="json")} if population else content


def scoped_interpretation(user, project_id, interpretation_id) -> PcbInterpretation:
    interpretation = (
        PcbInterpretation.objects.select_related("attempt__intake__source_revision__bundle")
        .filter(id=interpretation_id)
        .first()
    )
    if interpretation is None:
        raise NotFound("PCB interpretation not found.")
    source = interpretation.attempt.intake.source_revision
    authorize(user, source.bundle.project_id, Perm.PROJECT_READ)
    if source.bundle.project_id != project_id:
        raise NotFound("PCB interpretation not found.")
    return interpretation


def _authorize_evidence(user, project_id, evidence: Evidence):
    if evidence.kind != "source_file":
        return None
    file = (
        SourceBundleFile.objects.select_related("blob", "revision__bundle")
        .filter(revision_id=evidence.source_revision_id, path=evidence.path)
        .first()
    )
    if file is None:
        raise NotFound("Evidence source not found.")
    authorize(user, file.revision.bundle.project_id, Perm.PROJECT_READ)
    if file.revision.bundle.project_id != project_id:
        raise NotFound("Evidence source not found.")
    return file


_AUTHORIZING = ContextVar("pcb_authorizing_definitions", default=frozenset())


def closure(user, definition, content) -> list[UUID]:
    """Authorize every candidate, including rejected ones, and validate exact anchors."""
    population = parse_content(content, definition.kind)
    if population is None:
        return []
    active = _AUTHORIZING.get()
    if definition.id in active or len(active) >= 32:
        raise ValidationFailed("PCB population association cycle or depth limit exceeded.")
    token = _AUTHORIZING.set(active | {definition.id})
    try:
        return _closure(user, definition, population)
    finally:
        _AUTHORIZING.reset(token)


def _closure(user, definition, population: Population) -> list[UUID]:
    interpretation = scoped_interpretation(
        user, definition.project_id, population.interpretation_id
    )
    source = interpretation.attempt.intake.source_revision
    # Authorize all references and their frozen source closures before diagnostics
    # about the interpretation, a component, a target kind or evidence bytes.
    references = []
    for association in population.associations:
        file = (
            _authorize_evidence(user, definition.project_id, association.evidence)
            if association.evidence
            else None
        )
        representation = None
        if association.representation_id:
            representation = (
                Representation.objects.select_related(
                    "revision__definition",
                    "revision__snapshot",
                    "source_file__revision__bundle",
                    "source_file__blob",
                )
                .filter(id=association.representation_id)
                .first()
            )
            if representation is None:
                raise NotFound("Model representation not found.")
            authorize(user, representation.revision.definition.project_id, Perm.PROJECT_READ)
            authorize(
                user, representation.source_file.revision.bundle.project_id, Perm.PROJECT_READ
            )
            target = representation.revision
        else:
            target = (
                Revision.objects.select_related("definition", "snapshot")
                .filter(id=association.target_revision_id)
                .first()
            )
            if target is None:
                raise NotFound("Association target not found.")
            authorize(user, target.definition.project_id, Perm.PROJECT_READ)
        if target.definition_id != definition.id:
            authorize_snapshot(user, target.snapshot)
        body = None
        if association.kind == "port" and target.definition.kind == "pinout":
            pinout = json.loads(bytes(target.snapshot.canonical))["content"].get("interface", {})
            body_id = pinout.get("body_revision_id")
            if body_id:
                body = (
                    Revision.objects.select_related("definition", "snapshot")
                    .filter(id=body_id)
                    .first()
                )
                if body is None:
                    raise NotFound("Pinout body revision not found.")
                authorize(user, body.definition.project_id, Perm.PROJECT_READ)
                if body.definition_id != definition.id:
                    authorize_snapshot(user, body.snapshot)
        references.append((association, target, representation, file, body))

    if (
        interpretation.sha256 != population.interpretation_sha256
        or source.id != population.source_revision_id
        or source.manifest_sha256 != population.source_manifest_sha256
    ):
        raise ValidationFailed(
            "PCB population provenance differs from the accepted interpretation."
        )
    report = Report.model_validate_json(bytes(interpretation.canonical))
    components = {item.id for item in report.components}
    pads = {item.id: item.component_id for item in report.pads}
    for option in population.options:
        if {d.component_id for d in option.decisions} != components:
            raise ValidationFailed(
                "Each population option must explicitly cover every native component."
            )
    dependencies: set[UUID] = set()
    for association, target, representation, file, body in references:
        if association.component_id not in components or (
            association.pad_id is not None
            and pads.get(association.pad_id) != association.component_id
        ):
            raise ValidationFailed("Association anchor is not in this native interpretation.")
        if file and (
            file.blob.sha256 != association.evidence.sha256
            or file.rights != association.evidence.rights
        ):
            raise ValidationFailed("Evidence source hash or rights differ from the preserved file.")
        if representation:
            if (
                representation.kind != "model"
                or representation.revision.definition.project_id != definition.project_id
                or representation.source_file.revision.bundle.project_id != definition.project_id
            ):
                raise ValidationFailed(
                    "Model association requires a same-project model representation."
                )
        if target.definition.project_id != definition.project_id:
            raise ValidationFailed("Association target must belong to the PCB project.")
        dependencies.add(target.id)
        if target.definition_id == definition.id:
            raise ValidationFailed("PCB population cannot associate to its own revision.")
        if association.kind == "port":
            if target.definition.kind != "pinout":
                raise ValidationFailed("A port association requires a pinout revision.")
            if body is None or body.definition.kind != "connector_body":
                raise ValidationFailed("Pinout has no exact connector body revision.")
            body_content = json.loads(bytes(body.snapshot.canonical))["content"]
            contacts = {
                row["contact_id"] for row in body_content.get("interface", {}).get("contacts", [])
            }
            if association.target_contact_id not in contacts:
                raise ValidationFailed("Port contact is absent from the exact connector body.")
    return sorted(dependencies, key=str)


def authorize_content(user, definition, content) -> None:
    closure(user, definition, content)


def dependency_revisions(user, definition, content) -> list[UUID]:
    return closure(user, definition, content)


def project_population(population: Population, report: Report, option_id: str) -> dict:
    option = next((row for row in population.options if row.local_id == option_id), None)
    if option is None:
        raise NotFound("Population option not found.")
    by_id = {row.component_id: row for row in option.decisions}
    return {
        "option_id": option.local_id,
        "components": [
            {
                "component_id": str(component.id),
                "reference": component.reference,
                "native_dnp": component.dnp,
                "decision": by_id[component.id].status,
                "included": (
                    None
                    if by_id[component.id].status is None
                    else by_id[component.id].status == "populate"
                ),
            }
            for component in report.components
        ],
        "included_component_ids": [
            str(d.component_id) for d in option.decisions if d.status == "populate"
        ],
        "omitted_component_ids": [
            str(d.component_id) for d in option.decisions if d.status == "omit"
        ],
        "unresolved_component_ids": [
            str(d.component_id) for d in option.decisions if d.status is None
        ],
        "qualification": "not-assessed",
    }
