"""Controlled firmware dependencies tied to an exact board population and pin assumptions.

A firmware definition (design kind ``firmware``) pins exact preserved source files,
explicit configuration, a declared toolchain and one target: a frozen PCB population
revision, option and native MCU component. Pin assumptions name exact native pads.
Labels never establish correspondence or compatibility. Declarations are not verified
compiler support, a compiled build, a flashing handoff or device operation.
"""

from __future__ import annotations

import json
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic import ValidationError as PydanticValidationError

from specmate.access.permissions import Perm, authorize
from specmate.contracts import SHA256, check_package_path
from specmate.design.models import Definition, Draft, Revision
from specmate.design.operations import (
    CaptureDraft,
    CreateDefinition,
    UpdateDraft,
    create_definition,
    freeze_draft,
    scoped_draft,
    update_draft,
)
from specmate.operations import Context, NotFound, ValidationFailed, operation
from specmate.pcb import population as pcb_population
from specmate.pcb.report import Report
from specmate.sources.authority import authorize_revision
from specmate.sources.models import SourceBundleRevision

KIND = "firmware"
IDENT = r"^[A-Za-z_][A-Za-z0-9_.-]{0,63}$"
LOCAL = r"^[a-z][a-z0-9_-]{0,63}$"
# Roles that a peripheral instance can provide only once.
EXCLUSIVE = {
    "uart_tx",
    "uart_rx",
    "i2c_sda",
    "i2c_scl",
    "spi_sck",
    "spi_mosi",
    "spi_miso",
    "can_tx",
    "can_rx",
    "usb_dp",
    "usb_dm",
}
STATUS = {
    "toolchain_support": "declared_not_verified",
    "compilation": "not_performed",
    "flashing": "not_performed",
    "device_operation": "not_observed",
    "physical_qualification": False,
}


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class SourceFile(Strict):
    path: str = Field(max_length=512)
    sha256: str = Field(pattern=SHA256)
    rights: str = Field(min_length=1, max_length=200)
    role: Literal["application", "library", "configuration", "board_support", "lockfile", "other"]

    @model_validator(mode="after")
    def portable(self):
        check_package_path(self.path)
        return self


class SourcePin(Strict):
    local_id: str = Field(pattern=LOCAL)
    source_revision_id: UUID
    source_manifest_sha256: str = Field(pattern=SHA256)
    files: list[SourceFile] = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def unique_paths(self):
        if len({f.path for f in self.files}) != len(self.files):
            raise ValueError("A source pin lists each path once.")
        return self


class ConfigEntry(Strict):
    key: str = Field(pattern=IDENT)
    status: Literal["known", "unknown", "secret_reference"]
    value: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def explicit_value(self):
        if (self.status == "known") != (self.value is not None):
            raise ValueError("Only a known entry has a value; unknown and secrets store none.")
        return self


class Toolchain(Strict):
    family: Literal["platformio", "esp_idf", "arduino_cli", "zephyr", "cmake_gcc", "other"]
    name: str = Field(min_length=1, max_length=200)
    version: str | None = Field(default=None, min_length=1, max_length=100)
    framework: str | None = Field(default=None, min_length=1, max_length=200)
    board_id: str | None = Field(default=None, min_length=1, max_length=200)


class Target(Strict):
    population_revision_id: UUID
    option_id: str = Field(pattern=LOCAL)
    component_id: UUID
    declared_part: str | None = Field(default=None, min_length=1, max_length=200)


class PinAssumption(Strict):
    signal: str = Field(pattern=IDENT)
    pad_id: UUID | None = None
    function: Literal[
        "gpio_in",
        "gpio_out",
        "gpio_bidir",
        "analog_in",
        "pwm_out",
        "uart_tx",
        "uart_rx",
        "i2c_sda",
        "i2c_scl",
        "spi_sck",
        "spi_mosi",
        "spi_miso",
        "spi_cs",
        "can_tx",
        "can_rx",
        "usb_dp",
        "usb_dm",
        "other",
    ]
    peripheral: str | None = Field(default=None, pattern=IDENT)
    expected_net: str | None = Field(default=None, min_length=1, max_length=1024)
    peer_pad_id: UUID | None = None
    basis: str | None = Field(default=None, min_length=1, max_length=2000)


class Firmware(Strict):
    schema_version: Literal["1"] = "1"
    sources: list[SourcePin] = Field(min_length=1, max_length=32)
    configuration: list[ConfigEntry] = Field(default_factory=list, max_length=500)
    toolchain: Toolchain
    target: Target
    pins: list[PinAssumption] = Field(default_factory=list, max_length=500)

    @model_validator(mode="after")
    def unique_ids(self):
        for rows, key in (
            (self.sources, "local_id"),
            (self.configuration, "key"),
            (self.pins, "signal"),
        ):
            if len({getattr(r, key) for r in rows}) != len(rows):
                raise ValueError(f"Each {key} must be unique.")
        if not any(f.role == "application" for s in self.sources for f in s.files):
            raise ValueError("Pin at least one application source file.")
        return self


# ---------------------------------------------------------------- parsing and closure


def parse_content(content: dict, kind: str | None = None) -> Firmware | None:
    # An empty draft is an untyped placeholder: never valid firmware, but not foreign data.
    if kind == KIND and set(content) - {"firmware"}:
        raise ValidationFailed("A firmware definition holds only typed firmware content.")
    if "firmware" not in content:
        return None
    if kind is not None and kind != KIND:
        raise ValidationFailed("Firmware content requires a firmware definition.")
    try:
        return Firmware.model_validate(content["firmware"])
    except PydanticValidationError as exc:
        errors = [{"loc": list(e["loc"]), "type": e["type"], "msg": e["msg"]} for e in exc.errors()]
        raise ValidationFailed("Invalid firmware content.", details={"errors": errors}) from None


def validate_content(kind: str, content: dict) -> dict:
    """Design hook: canonical typed content."""
    firmware = parse_content(content, kind)
    return {"firmware": firmware.model_dump(mode="json")} if firmware else content


def _sources(user, project_id, firmware: Firmware) -> list[dict]:
    pinned = []
    for pin in firmware.sources:
        revision = (
            SourceBundleRevision.objects.select_related("bundle")
            .filter(id=pin.source_revision_id)
            .first()
        )
        if revision is None:
            raise NotFound("Source revision not found.")
        authorize_revision(user, revision)
        if revision.bundle.project_id != project_id:
            raise NotFound("Source revision not found.")
        if revision.manifest_sha256 != pin.source_manifest_sha256:
            raise ValidationFailed("A source pin does not match its exact revision manifest.")
        files = {f.path: f for f in revision.files.select_related("blob")}
        for entry in pin.files:
            file = files.get(entry.path)
            if file is None or file.blob.sha256 != entry.sha256 or file.rights != entry.rights:
                raise ValidationFailed(
                    "A pinned source file does not match its exact revision.",
                    details={"source": pin.local_id, "path": entry.path},
                )
        pinned.append(
            {
                "local_id": pin.local_id,
                "source_revision_id": str(revision.id),
                "bundle_name": revision.bundle.name,
                "revision_number": revision.number,
                "manifest_sha256": revision.manifest_sha256,
                "files": [f.model_dump(mode="json") for f in pin.files],
            }
        )
    return pinned


def _target(user, project_id, target: Target):
    revision = (
        Revision.objects.select_related("definition", "snapshot")
        .filter(id=target.population_revision_id)
        .first()
    )
    if revision is None:
        raise NotFound("Target population revision not found.")
    authorize(user, revision.definition.project_id, Perm.PROJECT_READ)
    if revision.definition.project_id != project_id:
        raise NotFound("Target population revision not found.")
    if revision.definition.kind != "pcb_population":
        raise ValidationFailed("The firmware target must be a frozen PCB population revision.")
    content = json.loads(bytes(revision.snapshot.canonical))["content"]
    # Full population closure: interpretation, source, targets and evidence.
    pcb_population.authorize_content(user, revision.definition, content)
    population = pcb_population.Population.model_validate(content["pcb_population"])
    interpretation = pcb_population.scoped_interpretation(
        user, project_id, population.interpretation_id
    )
    if interpretation.sha256 != population.interpretation_sha256:
        raise ValidationFailed("The population no longer matches its accepted interpretation.")
    report = Report.model_validate_json(bytes(interpretation.canonical))
    return revision, population, interpretation, report


def closure(user, definition: Definition, content: dict) -> list[UUID]:
    """Authorize every source and target reference; return exact design dependencies."""
    firmware = parse_content(content, definition.kind)
    if firmware is None:
        return []
    _sources(user, definition.project_id, firmware)
    revision, *_ = _target(user, definition.project_id, firmware.target)
    return [revision.id]


def authorize_content(user, definition, content) -> None:
    """Design hook: authorize retained references before any content escapes."""
    closure(user, definition, content)


def dependency_revisions(user, definition, content) -> list[UUID]:
    """Design hook: the exact frozen population revision this firmware targets."""
    return closure(user, definition, content)


# ---------------------------------------------------------------- evaluation


def finding(code, status, message, **subject):
    return {"code": code, "status": status, "message": message, "subject": subject}


def _decision(option, component_id):
    for decision in option.decisions:
        if decision.component_id == component_id:
            return decision.status
    return "absent"


def evaluate(user, definition: Definition, firmware: Firmware) -> dict:
    sources = _sources(user, definition.project_id, firmware)
    revision, population, interpretation, report = _target(
        user, definition.project_id, firmware.target
    )
    components = {c.id: c for c in report.components}
    pads = {p.id: p for p in report.pads}
    findings = []
    option = next((o for o in population.options if o.local_id == firmware.target.option_id), None)
    target = firmware.target
    mcu = components.get(target.component_id)
    if option is None:
        findings.append(
            finding("target_option", "invalid", "The population option does not exist.")
        )
    if mcu is None:
        findings.append(
            finding(
                "target_component",
                "invalid",
                "The target component is not in the pinned board interpretation.",
            )
        )
    elif option is not None:
        status = _decision(option, mcu.id)
        findings.append(
            {
                "populate": finding(
                    "target_population", "valid", "The target component is populated."
                ),
                "omit": finding(
                    "target_population",
                    "invalid",
                    "The target component is omitted in the selected population option.",
                ),
                None: finding(
                    "target_population",
                    "unknown",
                    "The target component's population decision is unresolved.",
                ),
                "absent": finding(
                    "target_population",
                    "unknown",
                    "The selected option has no decision for the target component.",
                ),
            }[status]
        )
    findings.append(
        finding(
            "target_part",
            "not_evaluated",
            "A declared part or toolchain board label does not establish the populated part.",
        )
    )
    used_pads: dict[UUID, str] = {}
    roles: dict[tuple[str, str], str] = {}
    for pin in firmware.pins:
        subject = {"signal": pin.signal}
        if pin.pad_id is None:
            findings.append(finding("pin_pad", "unknown", "The MCU pad is unknown.", **subject))
            pad = None
        else:
            pad = pads.get(pin.pad_id)
            if pad is None or mcu is None or pad.component_id != mcu.id:
                findings.append(
                    finding(
                        "pin_pad",
                        "invalid",
                        "The pad is not a native pad of the target component.",
                        **subject,
                    )
                )
                pad = None
            elif pad.type == "npth":
                findings.append(
                    finding(
                        "pin_pad", "invalid", "A nonplated hole has no electrical pin.", **subject
                    )
                )
                pad = None
            elif pin.pad_id in used_pads:
                findings.append(
                    finding(
                        "pin_pad",
                        "invalid",
                        f"The pad is already assigned to signal {used_pads[pin.pad_id]}.",
                        **subject,
                    )
                )
            else:
                used_pads[pin.pad_id] = pin.signal
                findings.append(
                    finding(
                        "pin_pad",
                        "valid",
                        f"Exact native pad {pad.terminal} of the target component.",
                        **subject,
                    )
                )
        if pin.function in EXCLUSIVE:
            if pin.peripheral is None:
                findings.append(
                    finding(
                        "peripheral",
                        "unknown",
                        "The peripheral instance for this role is unknown.",
                        **subject,
                    )
                )
            elif (pin.peripheral, pin.function) in roles:
                findings.append(
                    finding(
                        "peripheral",
                        "invalid",
                        f"{pin.peripheral} {pin.function} is already used by "
                        f"{roles[(pin.peripheral, pin.function)]}.",
                        **subject,
                    )
                )
            else:
                roles[(pin.peripheral, pin.function)] = pin.signal
        findings.append(
            finding(
                "pin_capability",
                "not_evaluated",
                "Whether this pad supports the declared function is not evaluated.",
                **subject,
            )
        )
        net = pad.net if pad is not None else None
        if pin.expected_net is not None and pad is not None:
            if not net:
                findings.append(
                    finding("pin_net", "unknown", "The reported pad net is blank.", **subject)
                )
            elif net != pin.expected_net:
                findings.append(
                    finding(
                        "pin_net",
                        "invalid",
                        f"The pad is reported on net {net}, not {pin.expected_net}.",
                        **subject,
                    )
                )
            else:
                findings.append(
                    finding(
                        "pin_net",
                        "valid",
                        "Reported pad net matches; pad membership is not connectivity proof.",
                        **subject,
                    )
                )
        if pin.peer_pad_id is not None:
            peer = pads.get(pin.peer_pad_id)
            if peer is None or peer.type == "npth":
                findings.append(
                    finding(
                        "pin_peer",
                        "invalid",
                        "The peer is not an electrical native pad.",
                        **subject,
                    )
                )
                continue
            peer_status = _decision(option, peer.component_id) if option else "absent"
            if peer_status == "omit":
                findings.append(
                    finding(
                        "pin_peer",
                        "invalid",
                        "The peer component is omitted in the selected option.",
                        **subject,
                    )
                )
            elif pad is None or not net or not peer.net:
                findings.append(
                    finding(
                        "pin_peer",
                        "unknown",
                        "Reported net membership for the pad or peer is unknown.",
                        **subject,
                    )
                )
            elif net != peer.net:
                findings.append(
                    finding(
                        "pin_peer",
                        "invalid",
                        f"Peer {peer.terminal} is reported on a different net.",
                        **subject,
                    )
                )
            else:
                findings.append(
                    finding(
                        "pin_peer",
                        "valid" if peer_status == "populate" else "unknown",
                        f"Peer {peer.terminal} shares the reported net"
                        + ("" if peer_status == "populate" else "; its population is unresolved")
                        + ". Pad membership is not connectivity proof.",
                        **subject,
                    )
                )
    if firmware.toolchain.version is None:
        findings.append(
            finding("toolchain_version", "unknown", "The toolchain version is unknown.")
        )
    for entry in firmware.configuration:
        if entry.status == "unknown":
            findings.append(
                finding(
                    "configuration", "unknown", "Configuration value is unknown.", key=entry.key
                )
            )
    counts = {s: 0 for s in ("valid", "invalid", "unknown", "not_evaluated")}
    for item in findings:
        counts[item["status"]] += 1
    readiness = (
        "blocked"
        if counts["invalid"]
        else "declared_with_unknowns"
        if counts["unknown"]
        else "declared"
    )
    return {
        "sources": sources,
        "target": {
            "population_revision_id": str(revision.id),
            "population_definition_id": str(revision.definition_id),
            "population_name": revision.definition.name,
            "population_number": revision.number,
            "population_snapshot_sha256": revision.snapshot.sha256,
            "option_id": target.option_id,
            "option_name": option.name if option else None,
            "interpretation_id": str(interpretation.id),
            "interpretation_sha256": interpretation.sha256,
            "board_source_revision_id": str(population.source_revision_id),
            "component": {
                "id": str(mcu.id),
                "reference": mcu.reference,
                "value": mcu.value,
                "footprint": mcu.footprint,
                "native_dnp": mcu.dnp,
            }
            if mcu
            else None,
            "declared_part": target.declared_part,
            "pads": [
                {"id": str(p.id), "terminal": p.terminal, "net": p.net, "type": p.type}
                for p in report.pads
                if mcu is not None and p.component_id == mcu.id
            ],
        },
        "findings": findings,
        "counts": counts,
        "readiness": readiness,
        **STATUS,
    }


# ---------------------------------------------------------------- operations


class Payload(Strict):
    pass


class CreateFirmware(Payload):
    project_id: UUID
    name: str = Field(min_length=1, max_length=200)
    firmware: Firmware


class UpdateFirmware(Payload):
    draft_id: UUID
    firmware: Firmware


class DraftRef(Payload):
    draft_id: UUID


class ReadFirmware(Payload):
    draft_id: UUID | None = None
    revision_id: UUID | None = None

    @model_validator(mode="after")
    def one(self):
        if (self.draft_id is None) == (self.revision_id is None):
            raise ValueError("Read one firmware draft or one frozen revision.")
        return self


class AssignmentReview(Payload):
    assembly_snapshot_id: UUID


def firmware_draft(ctx, draft_id, permission=Perm.PROJECT_READ, lock=False) -> Draft:
    draft = scoped_draft(ctx, draft_id, permission, lock=lock)
    if draft.definition.kind != KIND:
        raise NotFound("Firmware draft not found.")
    closure(ctx.user, draft.definition, draft.content)
    return draft


def _content(firmware: Firmware) -> dict:
    return {"firmware": firmware.model_dump(mode="json")}


def _scope_closure(ctx, p, permission) -> str:
    if isinstance(p, CreateFirmware):
        authorize(ctx.user, p.project_id, permission)
        probe = Definition(project_id=p.project_id, kind=KIND)
        closure(ctx.user, probe, _content(p.firmware))
        return f"project:{p.project_id}"
    draft = firmware_draft(ctx, p.draft_id, permission)
    if isinstance(p, UpdateFirmware):
        closure(ctx.user, draft.definition, _content(p.firmware))
    return f"project:{draft.definition.project_id}"


def _replay(ctx, p, stored, permission=Perm.DESIGN_EDIT):
    _scope_closure(ctx, p, permission)
    draft_id = stored.get("draft_id") or stored.get("draft", {}).get("draft_id")
    draft = Draft.objects.select_related("definition").filter(id=draft_id).first()
    if draft is None or draft.definition.kind != KIND:
        raise NotFound("Firmware draft not found.")
    authorize(ctx.user, draft.definition.project_id, Perm.PROJECT_READ)
    if "content" in stored:
        closure(ctx.user, draft.definition, stored["content"])
    if "revision_id" in stored:
        from specmate.queries import get_revision

        revision = get_revision(ctx.user, stored["revision_id"])
        closure(
            ctx.user, revision.definition, json.loads(bytes(revision.snapshot.canonical))["content"]
        )


def _scope(name, permission=Perm.DESIGN_EDIT):
    def resolve(ctx, p):
        from specmate.operations.models import IdempotencyRecord
        from specmate.operations.scope import LEGACY_SCOPE

        scope = _scope_closure(ctx, p, permission)
        # Current authority over a retained outcome precedes any keyed mismatch.
        prior = IdempotencyRecord.objects.select_for_update().filter(
            actor=ctx.user, operation=name, key=ctx.idempotency_key
        )
        retained = prior.filter(scope=scope).first() or prior.filter(scope=LEGACY_SCOPE).first()
        if retained is not None:
            _replay(ctx, p, retained.result, permission)
        return scope

    return resolve


@operation(
    "firmware.create",
    CreateFirmware,
    summary="Create a firmware draft pinning exact sources, configuration, a declared "
    "toolchain, a frozen board population target and pin assumptions.",
    idempotency_scope=_scope("firmware.create"),
    authorize_replay=_replay,
)
def create_firmware(ctx: Context, p: CreateFirmware) -> dict:
    authorize(ctx.user, p.project_id, Perm.DESIGN_EDIT)
    closure(ctx.user, Definition(project_id=p.project_id, kind=KIND), _content(p.firmware))
    return create_definition(
        ctx,
        CreateDefinition(
            project_id=p.project_id, kind=KIND, name=p.name, content=_content(p.firmware)
        ),
    )


@operation(
    "firmware.update",
    UpdateFirmware,
    summary="Replace firmware declarations using the shared draft state token.",
    requires_expected_state=True,
    idempotency_scope=_scope("firmware.update"),
    authorize_replay=_replay,
)
def update_firmware(ctx: Context, p: UpdateFirmware) -> dict:
    draft = firmware_draft(ctx, p.draft_id, Perm.DESIGN_EDIT, lock=True)
    closure(ctx.user, draft.definition, _content(p.firmware))
    return update_draft(ctx, UpdateDraft(draft_id=p.draft_id, changes=_content(p.firmware)))


@operation(
    "firmware.freeze",
    DraftRef,
    summary="Freeze firmware declarations only when no target or pin finding is invalid.",
    requires_expected_state=True,
    idempotency_scope=_scope("firmware.freeze", Perm.DESIGN_FREEZE),
    authorize_replay=lambda ctx, p, stored: _replay(ctx, p, stored, Perm.DESIGN_FREEZE),
)
def freeze_firmware(ctx: Context, p: DraftRef) -> dict:
    draft = firmware_draft(ctx, p.draft_id, Perm.DESIGN_FREEZE, lock=True)
    firmware = parse_content(draft.content, KIND)
    if firmware is None:
        raise ValidationFailed("Typed firmware declarations are required before freezing.")
    evaluation = evaluate(ctx.user, draft.definition, firmware)
    invalid = [f for f in evaluation["findings"] if f["status"] == "invalid"]
    if invalid:
        raise ValidationFailed(
            "Firmware has invalid target or pin assumptions and cannot be frozen.",
            details={"findings": invalid},
        )
    result = freeze_draft(
        ctx,
        CaptureDraft(
            draft_id=p.draft_id, dependencies=closure(ctx.user, draft.definition, draft.content)
        ),
    )
    return {**result, "readiness": evaluation["readiness"], **STATUS}


def read_result(user, definition, content, *, draft=None, revision=None) -> dict:
    firmware = parse_content(content, definition.kind)
    if firmware is None:
        raise ValidationFailed("This firmware record has no typed firmware content.")
    return {
        "definition_id": str(definition.id),
        "name": definition.name,
        "draft_id": str(draft.id) if draft else None,
        "state": draft.state_token if draft else None,
        "revision_id": str(revision.id) if revision else None,
        "revision_number": revision.number if revision else None,
        "snapshot_sha256": revision.snapshot.sha256 if revision else None,
        "content": {"firmware": firmware.model_dump(mode="json")},
        "evaluation": evaluate(user, definition, firmware),
    }


def read_revision(user, revision_id) -> dict:
    revision = (
        Revision.objects.select_related("definition", "snapshot").filter(id=revision_id).first()
    )
    if revision is None or revision.definition.kind != KIND:
        raise NotFound("Firmware revision not found.")
    authorize(user, revision.definition.project_id, Perm.PROJECT_READ)
    content = json.loads(bytes(revision.snapshot.canonical))["content"]
    closure(user, revision.definition, content)
    return read_result(user, revision.definition, content, revision=revision)


@operation(
    "firmware.read",
    ReadFirmware,
    summary="Read firmware declarations with current access checks and target/pin findings.",
    supports_idempotency=False,
)
def read_firmware(ctx: Context, p: ReadFirmware) -> dict:
    if p.revision_id is not None:
        return read_revision(ctx.user, p.revision_id)
    draft = firmware_draft(ctx, p.draft_id)
    return read_result(ctx.user, draft.definition, draft.content, draft=draft)


def assignment_review(user, snapshot_id) -> dict:
    from specmate.assemblies.queries import get_snapshot

    snapshot, assembly = get_snapshot(user, snapshot_id)
    rows = []
    for path, node in assembly.nodes.items():
        assignments = assembly.assignments.get(path) or node.occurrence.assignments
        firmware_id = assignments.firmware_revision_id
        if firmware_id is None:
            continue
        firmware_revision = assembly.revisions[firmware_id]
        content = json.loads(bytes(firmware_revision.snapshot.canonical))["content"]
        row = {
            "path": list(path),
            "display_ref": node.occurrence.display_ref,
            "occurrence_revision_id": str(node.revision.id),
            "occurrence_kind": node.revision.definition.kind,
            "firmware_revision_id": str(firmware_id),
            "firmware_name": firmware_revision.definition.name,
        }
        try:
            firmware = parse_content(content, KIND)
        except ValidationFailed:
            firmware = None
        if firmware is None:
            row.update(status="invalid", message="The assigned revision has no valid firmware.")
        else:
            closure(user, firmware_revision.definition, content)
            row["target_population_revision_id"] = str(firmware.target.population_revision_id)
            if node.revision.definition.kind != "pcb_population":
                row.update(
                    status="unknown",
                    message="The occurrence is not a PCB population revision, so the firmware "
                    "target cannot be compared.",
                )
            elif node.revision.id == firmware.target.population_revision_id:
                row.update(status="valid", message="The firmware targets this exact population.")
            else:
                row.update(
                    status="invalid",
                    message="Wrong target: the firmware targets a different population revision.",
                )
        rows.append(row)
    return {"assembly_snapshot_id": str(snapshot.id), "assignments": rows, **STATUS}


@operation(
    "firmware.assignment_review",
    AssignmentReview,
    summary="Compare contextual firmware assignments in an assembly with each firmware target.",
    supports_idempotency=False,
)
def review_assignments(ctx: Context, p: AssignmentReview) -> dict:
    return assignment_review(ctx.user, p.assembly_snapshot_id)


def list_firmware(user, project_id) -> list[dict]:
    authorize(user, project_id, Perm.PROJECT_READ)
    rows = []
    for definition in Definition.objects.filter(project_id=project_id, kind=KIND).order_by(
        "created_at"
    )[:500]:
        draft = Draft.objects.filter(definition=definition).first()
        revisions = list(definition.revisions.order_by("number").values_list("id", "number"))
        rows.append(
            {
                "definition_id": str(definition.id),
                "name": definition.name,
                "draft_id": str(draft.id) if draft else None,
                "revisions": [{"revision_id": str(r), "number": n} for r, n in revisions],
            }
        )
    return rows
