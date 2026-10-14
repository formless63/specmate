"""PRT-001/PRT-002: print profiles, manufacturing variants and the optional slicer stage.

The native slicer boundary is mocked: these tests check records, pins, recipes and the
acceptance of registered evidence. They establish nothing about a real slicer or printer.
"""

import copy
import hashlib
import io
import json
import os
import subprocess
import sys
from uuid import UUID

import pytest
from django.test import Client

from specmate.builds.models import BuildAttempt, BuildStage, StageOutput
from specmate.builds.recipes import Recipe
from specmate.design.models import Revision
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    Unsupported,
    ValidationFailed,
)
from specmate.operations.core import registry
from specmate.printing import operations  # noqa: F401 (standalone registration)
from specmate.printing.native_script import SCRIPT
from specmate.printing.pack import REPORT_PATH, TOOL, canonical, output_media
from specmate.sources import blobstore

from .conftest import op, remove_member
from .test_sources import register

MODEL = b"solid synthetic\nendsolid synthetic\n"
STEP = b"ISO-10303-21;\nEND-ISO-10303-21;\n"
RIGHTS = "CC-BY-4.0"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def known(value, basis="preference", note="Synthetic workshop practice"):
    return {"value": value, "basis": basis, "source": None, "note": note}


@pytest.fixture
def part(users, workspace):
    files = []
    for path, data in (("bracket.stl", MODEL), ("bracket.step", STEP)):
        register(users["editor"], workspace, data)
        files.append(
            {
                "path": path,
                "sha256": digest(data),
                "media_type": "application/octet-stream",
                "rights": RIGHTS,
            }
        )
    bundle = op(
        users["editor"],
        "source.create_original_bundle",
        {"workspace_id": workspace, "name": "Synthetic bracket", "files": files},
    )
    created = op(
        users["editor"],
        "mechanical_source.create",
        {
            "workspace_id": workspace,
            "name": "Synthetic bracket",
            "mechanical_source": {
                "item_role": "part",
                "sources": [
                    {
                        "local_id": "original",
                        "source_revision_id": bundle["revision_id"],
                        "source_manifest_sha256": bundle["manifest_sha256"],
                        "files": [
                            {
                                "path": "bracket.stl",
                                "sha256": digest(MODEL),
                                "rights": RIGHTS,
                                "role": "model",
                                "format": "mesh",
                            },
                            {
                                "path": "bracket.step",
                                "sha256": digest(STEP),
                                "rights": RIGHTS,
                                "role": "model",
                                "format": "step",
                            },
                        ],
                    }
                ],
            },
        },
    )
    frozen = op(
        users["owner"],
        "mechanical_source.freeze",
        {"draft_id": created["draft_id"]},
        expected_state=created["state"],
    )
    return {**frozen, "definition_id": created["definition_id"], "bundle": bundle}


FDM = {
    "printer": {
        "nozzle_diameter_mm": known(0.4),
        "bed_size_x_mm": known(220),
        "bed_size_y_mm": known(220),
        "gcode_flavor": known("marlin2"),
    },
    "process": {
        "layer_height_mm": known(0.2),
        "fill_density_percent": known(20),
        "perimeters": known(3),
    },
    "material": {
        "material_family": known("PETG"),
        "filament_diameter_mm": known(1.75),
        "nozzle_temperature_c": known(
            240,
            "documented",
            None,
        )
        | {"source": {"kind": "citation", "citation": "Synthetic datasheet table 2"}},
    },
}


def create_profile(user, workspace, role, parameters, technology="fdm", **ctx):
    return op(
        user,
        "print_profile.create",
        {
            "workspace_id": workspace,
            "name": f"Synthetic {technology} {role}",
            "print_profile": {"role": role, "technology": technology, "parameters": parameters},
        },
        **ctx,
    )


def freeze(user, operation, created):
    return op(user, operation, {"draft_id": created["draft_id"]}, expected_state=created["state"])


@pytest.fixture
def profiles(users, workspace):
    result = {}
    for role, parameters in FDM.items():
        created = create_profile(users["editor"], workspace, role, parameters)
        frozen = freeze(users["editor"], "print_profile.freeze", created)
        result[role] = {**frozen, "definition_id": created["definition_id"]}
    return result


def preparation(part, profiles, **changes):
    body = {
        "variant_label": "FDM PETG 0.2 mm",
        "technology": "fdm",
        "part": {
            "mechanical_revision_id": part["revision_id"],
            "snapshot_sha256": part["sha256"],
            "source_local_id": "original",
            "path": "bracket.stl",
        },
        "model_units": known("mm", "documented", None)
        | {"source": {"kind": "citation", "citation": "Synthetic export settings"}},
        "profiles": {
            role: {"revision_id": p["revision_id"], "snapshot_sha256": p["sha256"]}
            for role, p in profiles.items()
        },
        "orientation": {
            "status": "rotated",
            "rotation_deg": [90, 0, 0],
            "basis": "Layer lines across the load path",
        },
        "supports": {"status": "buildplate_only", "basis": "Overhang under the flange"},
        "copies": 2,
        "slicer_tool": "prusaslicer-2.5.0",
    }
    body.update(changes)
    return body


def create_preparation(user, workspace, body, **ctx):
    return op(
        user,
        "print_preparation.create",
        {"workspace_id": workspace, "name": body["variant_label"], "print_preparation": body},
        **ctx,
    )


@pytest.fixture
def frozen_preparation(users, workspace, part, profiles):
    created = create_preparation(users["editor"], workspace, preparation(part, profiles))
    frozen = freeze(users["editor"], "print_preparation.freeze", created)
    return {**frozen, "definition_id": created["definition_id"]}


IMAGE = "specmate-slicer-check@sha256:" + "a" * 64


@pytest.fixture
def approved(settings, users, frozen_preparation):
    options = op(
        users["viewer"],
        "print_slice.options",
        {"preparation_revision_id": frozen_preparation["revision_id"]},
    )
    recipe = {**options["proposed_recipe"], "image": IMAGE}
    settings.SPECMATE_APPROVED_RECIPES = {recipe["id"]: recipe}
    return recipe


# PRT-001 -------------------------------------------------------------------------------


def test_profiles_are_versioned_with_provenance_and_unknowns(users, workspace):
    created = create_profile(users["editor"], workspace, "material", FDM["material"])
    read = op(users["viewer"], "print_profile.read", {"draft_id": created["draft_id"]})
    rows = {row["key"]: row for row in read["parameters"]}
    assert rows["nozzle_temperature_c"]["value"] == 240
    assert rows["nozzle_temperature_c"]["basis"] == "documented"
    assert rows["nozzle_temperature_c"]["source"]["citation"] == "Synthetic datasheet table 2"
    # Undeclared parameters are listed as unknown, never as zero or a slicer default.
    assert rows["filament_density_g_cm3"] == rows["filament_density_g_cm3"] | {
        "status": "unknown",
        "value": None,
    }
    first = freeze(users["editor"], "print_profile.freeze", created)
    changed = copy.deepcopy(FDM["material"])
    changed["filament_density_g_cm3"] = known(1.27)
    updated = op(
        users["editor"],
        "print_profile.update",
        {
            "draft_id": created["draft_id"],
            "print_profile": {"role": "material", "technology": "fdm", "parameters": changed},
        },
        expected_state=first["draft"]["state"],
    )
    second = freeze(users["editor"], "print_profile.freeze", updated)
    assert second["number"] == 2
    old = op(users["viewer"], "print_profile.read", {"revision_id": first["revision_id"]})
    assert {r["key"]: r for r in old["parameters"]}["filament_density_g_cm3"]["status"] == "unknown"
    client = Client()
    client.force_login(users["viewer"])
    vocabulary = client.get("/api/v0/printing/parameters").json()
    assert {"technology": "fdm", "role": "printer", "key": "nozzle_diameter_mm"}.items() <= next(
        p for p in vocabulary if p["key"] == "nozzle_diameter_mm"
    ).items()
    listed = client.get(f"/api/v0/printing/profiles/{created['definition_id']}/revisions").json()
    assert [r["number"] for r in listed] == [1, 2]


@pytest.mark.parametrize(
    "parameters",
    [
        {"layer_height_mm": known(0.2)},  # a process key in a material profile
        {"nozzle_temperature_c": known(9000)},  # outside its declared bounds
        {"material_family": known("unobtainium")},
        {"nozzle_temperature_c": {"value": 200, "basis": "unknown", "source": None, "note": None}},
        {"nozzle_temperature_c": {"value": None, "basis": "documented", "source": None}},
    ],
)
def test_profile_parameters_are_typed_and_coherent(users, workspace, parameters):
    with pytest.raises(ValidationFailed):
        create_profile(users["editor"], workspace, "material", parameters)


def test_profile_permissions_cas_and_idempotency(users, workspace):
    for actor, error in (("viewer", PermissionDenied), ("outsider", NotFound)):
        with pytest.raises(error):
            create_profile(users[actor], workspace, "process", FDM["process"])
    created = create_profile(
        users["editor"], workspace, "process", FDM["process"], idempotency_key="k"
    )
    assert (
        create_profile(users["editor"], workspace, "process", FDM["process"], idempotency_key="k")
        == created
    )
    with pytest.raises(IdempotencyMismatch):
        create_profile(users["editor"], workspace, "printer", FDM["printer"], idempotency_key="k")
    with pytest.raises(Conflict):
        op(
            users["editor"],
            "print_profile.update",
            {
                "draft_id": created["draft_id"],
                "print_profile": {"role": "process", "technology": "fdm", "parameters": {}},
            },
            expected_state="draft-v99",
        )
    own = create_profile(users["contributor"], workspace, "process", FDM["process"])
    with pytest.raises(PermissionDenied):
        freeze(users["contributor"], "print_profile.freeze", own)
    with pytest.raises(NotFound):
        op(users["outsider"], "print_profile.read", {"draft_id": created["draft_id"]})


def test_variant_references_the_same_part_identity_and_parameter_provenance(
    users, workspace, part, profiles
):
    """ACC-PRT-001: process-specific variants share the part identity and keep provenance."""
    fdm = create_preparation(users["editor"], workspace, preparation(part, profiles))
    resin = {}
    for role, parameters in (
        ("printer", {"display_pixels_x": known(3840)}),
        ("process", {"layer_height_mm": known(0.05)}),
        ("material", {"exposure_time_s": known(2.5), "material_family": known("tough")}),
    ):
        created = create_profile(users["editor"], workspace, role, parameters, technology="resin")
        frozen = freeze(users["editor"], "print_profile.freeze", created)
        resin[role] = frozen
    resin_body = preparation(part, resin, variant_label="Resin tough 50 um", technology="resin")
    resin_variant = create_preparation(users["editor"], workspace, resin_body)
    variants = op(
        users["viewer"],
        "print_preparation.variants",
        {"mechanical_definition_id": part["definition_id"]},
    )
    assert {v["draft_id"] for v in variants["variants"]} == {
        fdm["draft_id"],
        resin_variant["draft_id"],
    }
    assert {v["technology"] for v in variants["variants"]} == {"fdm", "resin"}
    assert variants["printable"] == "not_evaluated" and variants["physical_qualification"] is False
    read = op(users["viewer"], "print_preparation.read", {"draft_id": fdm["draft_id"]})
    assert read["part_identity"]["mechanical_definition_id"] == part["definition_id"]
    assert read["part_identity"]["model"]["sha256"] == digest(MODEL)
    temperature = next(r for r in read["parameters"] if r["key"] == "nozzle_temperature_c")
    assert temperature["profile_revision_id"] == profiles["material"]["revision_id"]
    assert temperature["basis"] == "documented"
    assert temperature["source"] == {"kind": "citation", "citation": "Synthetic datasheet table 2"}
    resin_read = op(
        users["viewer"], "print_preparation.read", {"draft_id": resin_variant["draft_id"]}
    )
    assert resin_read["part_identity"]["mechanical_definition_id"] == part["definition_id"]
    assert "Resin slicing has no qualified pack" in resin_read["slicing"]["blockers"][0]


def test_preparation_pins_are_exact_and_role_checked(users, workspace, part, profiles):
    body = preparation(part, profiles)
    swapped = copy.deepcopy(body)
    swapped["profiles"]["printer"], swapped["profiles"]["material"] = (
        body["profiles"]["material"],
        body["profiles"]["printer"],
    )
    stale = copy.deepcopy(body)
    stale["part"]["snapshot_sha256"] = "0" * 64
    absent = copy.deepcopy(body)
    absent["part"]["path"] = "absent.stl"
    for bad in (swapped, stale, absent):
        with pytest.raises(ValidationFailed):
            create_preparation(users["editor"], workspace, bad)
    with pytest.raises(NotFound):
        create_preparation(users["outsider"], workspace, body)


def test_frozen_preparation_pins_part_and_profile_revisions(
    users, frozen_preparation, part, profiles
):
    revision = Revision.objects.get(id=frozen_preparation["revision_id"])
    pinned = set(revision.snapshot.dependencies.values_list("revision_id", flat=True))
    assert pinned == {UUID(part["revision_id"])} | {
        UUID(p["revision_id"]) for p in profiles.values()
    }
    read = op(
        users["viewer"],
        "print_preparation.read",
        {"revision_id": frozen_preparation["revision_id"]},
    )
    slicing = read["slicing"]
    assert slicing["blockers"] == []
    assert slicing["configuration"]["bed_shape"] == "0x0,220x0,220x220,0x220"
    assert slicing["configuration"]["fill_density"] == "20%"
    assert slicing["configuration"]["support_material_buildplate_only"] == "1"
    # Unknown settings are left to the tool and listed as such, never declared.
    assert "material.filament_density_g_cm3" in slicing["tool_default_settings"]
    assert "filament_density" not in slicing["configuration"]
    assert read["printable"] == "not_evaluated" and read["printer_submission"] == "not_available"


# PRT-002 -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"orientation": {"status": "unknown"}}, "Orientation is unknown"),
        ({"supports": {"status": "unknown"}}, "support strategy is unknown"),
        ({"model_units": {"value": None, "basis": "unknown"}}, "Model units are unknown"),
        ({"part_path": "bracket.step"}, "STEP"),
    ],
)
def test_unknown_inputs_block_slicing_without_inventing_values(
    users, workspace, part, profiles, change, message
):
    body = preparation(part, profiles)
    if "part_path" in change:
        body["part"]["path"] = change.pop("part_path")
    body.update(change)
    created = create_preparation(users["editor"], workspace, body)
    frozen = freeze(users["editor"], "print_preparation.freeze", created)
    options = op(
        users["viewer"], "print_slice.options", {"preparation_revision_id": frozen["revision_id"]}
    )
    assert options["recipe_id"] is None and message in options["unavailable_reason"]


def test_missing_required_parameter_blocks_slicing(users, workspace, part, profiles):
    created = create_profile(users["editor"], workspace, "process", {"perimeters": known(2)})
    profiles = {**profiles, "process": freeze(users["editor"], "print_profile.freeze", created)}
    prepared = create_preparation(users["editor"], workspace, preparation(part, profiles))
    read = op(users["viewer"], "print_preparation.read", {"draft_id": prepared["draft_id"]})
    assert any("process.layer_height_mm" in b for b in read["slicing"]["blockers"])


def test_recipe_is_exact_and_needs_separate_approval(users, frozen_preparation, settings):
    ref = {"preparation_revision_id": frozen_preparation["revision_id"]}
    settings.SPECMATE_APPROVED_RECIPES = {}
    options = op(users["viewer"], "print_slice.options", ref)
    proposed = options["proposed_recipe"]
    assert options["available_recipe_id"] is None and proposed["image"] is None
    assert proposed["network"] == "none" and proposed["argv"][0] == "/usr/bin/python3"
    spec = json.loads(proposed["argv"][-1])
    assert spec["tool"] == TOOL
    assert spec["part"]["sha256"] == digest(MODEL) and spec["copies"] == 2
    assert spec["orientation"] == {"status": "rotated", "rotation_deg": [90.0, 0.0, 0.0]}
    assert {o["rights"] for o in proposed["outputs"]} == {RIGHTS}
    with pytest.raises(Unsupported):
        op(users["owner"], "print_slice.request", {**ref, "recipe_id": proposed["id"]})
    tampered = {**proposed, "image": IMAGE, "argv": [*proposed["argv"][:-1], "{}"]}
    settings.SPECMATE_APPROVED_RECIPES = {proposed["id"]: tampered}
    with pytest.raises(Unsupported):
        op(users["owner"], "print_slice.request", {**ref, "recipe_id": proposed["id"]})


def test_slice_request_permissions_and_build(users, frozen_preparation, approved):
    ref = {
        "preparation_revision_id": frozen_preparation["revision_id"],
        "recipe_id": approved["id"],
    }
    for actor, error in (("viewer", PermissionDenied), ("outsider", NotFound)):
        with pytest.raises(error):
            op(users[actor], "print_slice.request", ref)
    result = op(users["owner"], "print_slice.request", ref, idempotency_key="slice")
    assert op(users["owner"], "print_slice.request", ref, idempotency_key="slice") == result
    build = BuildAttempt.objects.get(id=result["build_id"])
    assert build.recipe == Recipe.model_validate(approved).model_dump(mode="json")
    options = op(
        users["viewer"],
        "print_slice.options",
        {"preparation_revision_id": frozen_preparation["revision_id"]},
    )
    assert options["available_recipe_id"] == approved["id"]
    assert [b["build_id"] for b in options["builds"]] == [result["build_id"]]


def gcode(time="1h 2m 3s", length="1234.50", mass="3.70"):
    lines = ["; generated by PrusaSlicer 2.5.0+linux-x64 on 2026-01-01 at 00:00:00 UTC", "G28"]
    if time:
        lines.append(f"; estimated printing time (normal mode) = {time}")
    if length:
        lines.append(f"; filament used [mm] = {length}")
    if mass:
        lines.append(f"; filament used [g] = {mass}")
    return ("\n".join(lines) + "\n").encode()


def report_for(spec, files, estimates):
    return {
        "format_version": 1,
        "adapter": "print-slice-prusaslicer-v1",
        "input_sha256": hashlib.sha256(canonical(spec)).hexdigest(),
        "tool": {k: TOOL[k] for k in ("name", "package", "package_version")},
        "model_sha256": spec["part"]["sha256"],
        "source_unchanged": True,
        "slicer_exit_code": 0,
        "outputs": [
            {"path": p, "sha256": digest(d), "size": len(d)} for p, d in sorted(files.items())
        ],
        "estimates": estimates,
        "printable": "not_evaluated",
        "printer_submission": "not_performed",
        "physical_qualification": False,
    }


UNKNOWN = {"value": None, "status": "unknown"}


def complete(build_id, files, rights=RIGHTS, report=None):
    """Register immutable evidence as the runner would; this is not native proof."""
    stage = BuildStage.objects.get(build_id=build_id)
    spec = json.loads(stage.build.recipe["argv"][-1])
    if report is None:
        report = report_for(
            spec,
            files,
            {
                "print_time_s": {"value": 3723.0, "status": "slicer_estimate"},
                "filament_length_mm": {"value": 1234.5, "status": "slicer_estimate"},
                "filament_mass_g": UNKNOWN,
            },
        )
    everything = {**files, REPORT_PATH: json.dumps(report).encode()}
    media = output_media(spec["output_format"])
    for path, data in everything.items():
        staged = blobstore.stage(io.BytesIO(data), 2 * 1024**2)
        blobstore.promote(staged)
        StageOutput.objects.create(
            stage=stage,
            path=path,
            sha256=digest(data),
            size=len(data),
            media_type=media.get(path, "application/octet-stream"),
            rights=rights,
            source_revision_id=stage.build.source_revision_id,
        )
    stage.state = "succeeded"
    stage.receipt = {
        "outcome": "succeeded",
        "exit_code": 0,
        "outputs": [{"path": p, "sha256": digest(d)} for p, d in sorted(everything.items())],
    }
    stage.save()
    return spec


@pytest.fixture
def requested(users, frozen_preparation, approved):
    return op(
        users["owner"],
        "print_slice.request",
        {"preparation_revision_id": frozen_preparation["revision_id"], "recipe_id": approved["id"]},
        idempotency_key="slice-one",
    )


def test_slice_result_identifies_exact_profile_and_tool_and_is_not_printable(
    users, frozen_preparation, profiles, requested
):
    """ACC-PRT-002: an exact profile/tool identity and no printable/qualified claim."""
    complete(requested["build_id"], {"slice.gcode": gcode(mass="0.00"), "slice.log": b"log\n"})
    ref = {
        "preparation_revision_id": frozen_preparation["revision_id"],
        "build_id": requested["build_id"],
    }
    read = op(users["viewer"], "print_slice.read", ref)
    assert read["image"] == IMAGE
    assert read["inputs"]["tool"]["package_version"] == "2.5.0+dfsg-4"
    assert {role: p["revision_id"] for role, p in read["inputs"]["profiles"].items()} == {
        role: p["revision_id"] for role, p in profiles.items()
    }
    assert read["inputs"]["preparation"]["revision_id"] == frozen_preparation["revision_id"]
    assert read["report"]["printable"] == read["printable"] == "not_evaluated"
    assert read["report"]["printer_submission"] == "not_performed"
    assert (
        read["physical_qualification"] is False
        and read["report"]["physical_qualification"] is False
    )
    assert read["report"]["estimates"]["filament_mass_g"] == UNKNOWN
    assert {o["rights"] for o in read["outputs"]} == {RIGHTS}
    client = Client()
    client.force_login(users["viewer"])
    gcode_output = next(o for o in read["outputs"] if o["path"] == "slice.gcode")
    base = f"/api/v0/printing/preparation-revisions/{frozen_preparation['revision_id']}"
    response = client.get(
        f"{base}/slices/{requested['build_id']}/outputs/{gcode_output['output_id']}"
    )
    assert response.status_code == 200
    assert b"".join(response.streaming_content) == gcode(mass="0.00")
    assert client.get(f"{base}/slicing").json()["builds"][0]["state"] == "succeeded"
    client.force_login(users["outsider"])
    assert client.get(f"{base}/slices/{requested['build_id']}").status_code == 404


def test_mass_estimate_without_declared_density_is_rejected(users, frozen_preparation, requested):
    spec = json.loads(BuildAttempt.objects.get(id=requested["build_id"]).recipe["argv"][-1])
    assert spec["mass_estimate"] == "density_unknown"
    files = {"slice.gcode": gcode(), "slice.log": b"log\n"}
    claimed = report_for(
        spec,
        files,
        {
            "print_time_s": UNKNOWN,
            "filament_length_mm": UNKNOWN,
            "filament_mass_g": {"value": 3.7, "status": "slicer_estimate"},
        },
    )
    complete(requested["build_id"], files, report=claimed)
    ref = {
        "preparation_revision_id": frozen_preparation["revision_id"],
        "build_id": requested["build_id"],
    }
    with pytest.raises(ValidationFailed):
        op(users["viewer"], "print_slice.read", ref)


@pytest.mark.parametrize("defect", ["rights", "producer", "missing", "tool"])
def test_inconsistent_slice_evidence_is_rejected(users, frozen_preparation, requested, defect):
    files = {"slice.gcode": gcode(), "slice.log": b"log\n"}
    kwargs = {}
    if defect == "rights":
        kwargs["rights"] = "unknown"
    elif defect == "producer":
        files["slice.gcode"] = b"; generated by another tool\n"
    elif defect == "missing":
        files.pop("slice.log")
    if defect == "tool":
        spec = json.loads(BuildAttempt.objects.get(id=requested["build_id"]).recipe["argv"][-1])
        report = report_for(
            spec,
            files,
            {k: UNKNOWN for k in ("print_time_s", "filament_length_mm", "filament_mass_g")},
        )
        report["tool"]["package_version"] = "2.9.0"
        kwargs["report"] = report
    elif defect == "missing":
        spec = json.loads(BuildAttempt.objects.get(id=requested["build_id"]).recipe["argv"][-1])
        kwargs["report"] = report_for(
            spec,
            {**files, "slice.gcode": gcode()},
            {k: UNKNOWN for k in ("print_time_s", "filament_length_mm", "filament_mass_g")},
        )
    complete(requested["build_id"], files, **kwargs)
    ref = {
        "preparation_revision_id": frozen_preparation["revision_id"],
        "build_id": requested["build_id"],
    }
    with pytest.raises(ValidationFailed):
        op(users["viewer"], "print_slice.read", ref)


def test_failed_slice_is_not_accepted(users, frozen_preparation, requested):
    stage = BuildStage.objects.get(build_id=requested["build_id"])
    stage.state = "failed"
    stage.receipt = {"outcome": "failed", "exit_code": 2, "message": "Slicer exited 2"}
    stage.save()
    ref = {"preparation_revision_id": frozen_preparation["revision_id"]}
    options = op(users["viewer"], "print_slice.options", ref)
    assert options["builds"][0] == options["builds"][0] | {"state": "failed", "exit_code": 2}
    with pytest.raises(ValidationFailed):
        op(users["viewer"], "print_slice.read", {**ref, "build_id": requested["build_id"]})


def test_revoked_membership_hides_retained_slice(users, frozen_preparation, requested):
    complete(requested["build_id"], {"slice.gcode": gcode(), "slice.log": b"log\n"})
    remove_member(users["viewer"])
    with pytest.raises(NotFound):
        op(
            users["viewer"],
            "print_slice.read",
            {
                "preparation_revision_id": frozen_preparation["revision_id"],
                "build_id": requested["build_id"],
            },
        )


def test_no_operation_submits_to_or_controls_a_printer():
    """PRT-004 boundary: preparation has no printer submission path or permission atom."""
    from specmate.access.permissions import Perm

    names = [n for n in registry if n.startswith("print")]
    assert names and not [n for n in names if any(w in n for w in ("submit", "send", "start"))]
    assert not [p for p in Perm if "print" in p.value]


# Native adapter with a mocked slicer boundary ---------------------------------------------


FAKE_SLICER = r"""
import pathlib, sys
argv = sys.argv[1:]
out = pathlib.Path(argv[argv.index("--output") + 1])
config = pathlib.Path(argv[argv.index("--load") + 1]).read_text()
assert "layer_height = 0.2" in config, config
if "--export-3mf" in argv:
    out.write_bytes(b"PK\x03\x04synthetic")
else:
    out.write_text("; generated by PrusaSlicer 2.5.0\n"
                   "; estimated printing time (normal mode) = 1h 1s\n"
                   "; filament used [mm] = 10.5\n; filament used [g] = 0.00\n")
print("sliced", argv)
"""


def run_adapter(tmp_path, spec, model):
    """Run the trusted adapter text with the tool and mounts redirected to a sandbox dir."""
    inputs, outputs, bin_dir = tmp_path / "in", tmp_path / "out", tmp_path / "bin"
    for d in (inputs, outputs, bin_dir):
        d.mkdir()
    (inputs / "bracket.stl").write_bytes(model)
    slicer = bin_dir / "prusa-slicer"
    slicer.write_text(f"#!{sys.executable}\n{FAKE_SLICER}")
    dpkg = bin_dir / "dpkg-query"
    dpkg.write_text("#!/bin/sh\nprintf '%s' 2.5.0+dfsg-4\n")
    for tool in (slicer, dpkg):
        os.chmod(tool, 0o700)
    script = (
        SCRIPT.replace('"/usr/bin/prusa-slicer"', repr(str(slicer)))
        .replace('"/usr/bin/dpkg-query"', repr(str(dpkg)))
        .replace('"/inputs"', repr(str(inputs)))
        .replace('"/outputs"', repr(str(outputs)))
        .replace('"/tmp/specmate-slice.ini"', repr(str(tmp_path / "slice.ini")))
    )
    done = subprocess.run(  # noqa: S603 - this interpreter and the trusted adapter text
        [sys.executable, "-I", "-c", script, canonical(spec).decode()],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    return done, outputs


def test_adapter_reports_hashes_and_keeps_zero_estimates_unknown(
    users, frozen_preparation, approved, requested, tmp_path
):
    spec = json.loads(approved["argv"][-1])
    done, outputs = run_adapter(tmp_path, spec, MODEL)
    assert done.returncode == 0, done.stderr
    report = json.loads((outputs / "slice.json").read_text())
    assert report["estimates"]["print_time_s"] == {"value": 3601.0, "status": "slicer_estimate"}
    assert report["estimates"]["filament_length_mm"]["value"] == 10.5
    # The fake slicer states 0.00 g and density is undeclared: unknown, never zero.
    assert report["estimates"]["filament_mass_g"] == UNKNOWN
    assert report["input_sha256"] == hashlib.sha256(canonical(spec)).hexdigest()
    assert {o["path"] for o in report["outputs"]} == {"slice.gcode", "slice.log"}
    assert "--rotate-x" in (outputs / "slice.log").read_text()
    # The adapter's own registered evidence passes the application acceptance checks.
    files = {p: (outputs / p).read_bytes() for p in ("slice.gcode", "slice.log")}
    complete(requested["build_id"], files, report=report)
    read = op(
        users["viewer"],
        "print_slice.read",
        {
            "preparation_revision_id": frozen_preparation["revision_id"],
            "build_id": requested["build_id"],
        },
    )
    assert read["report_sha256"] == digest(json.dumps(report).encode())


def test_adapter_refuses_changed_model_bytes(users, frozen_preparation, approved, tmp_path):
    spec = json.loads(approved["argv"][-1])
    done, outputs = run_adapter(tmp_path, spec, MODEL + b"tampered")
    assert done.returncode != 0 and not (outputs / "slice.json").exists()


def test_print_profiles_ship_and_adopt_through_catalog_packs(users, workspace, profiles):
    """Profiles reuse the catalog-pack content path: register, install, adopt, freeze."""
    from specmate.catalog_packs.models import AdoptionEntry

    from .test_catalog_packs import adopt, install, registered

    material = profiles["material"]
    entry = {
        "key": "part",
        "label": "Synthetic PETG material profile",
        "category": "profile",
        "revision_id": material["revision_id"],
        "revision_sha256": material["sha256"],
        "rights": "synthetic-original",
    }
    version = registered(users, workspace, material, entries=[entry])
    install(users, version)
    adopt(users, version)
    copied = AdoptionEntry.objects.get()
    read = op(users["viewer"], "print_profile.read", {"draft_id": str(copied.draft_id)})
    assert read["content"]["print_profile"]["role"] == "material"
    frozen = op(
        users["owner"],
        "print_profile.freeze",
        {"draft_id": str(copied.draft_id)},
        expected_state=read["state"],
    )
    assert frozen["number"] == 1
