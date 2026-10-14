"""Recorded KiCad format upgrade: derivative provenance with the native boundary mocked.

The native stage itself (kicad-cli upgrade in the pinned image) is exercised only by the
opt-in real-tool probe. These tests set up verified build evidence directly, exactly as
the PCB extraction tests do, and never claim native compatibility.
"""

import hashlib
import io
import json
from uuid import uuid4

import pytest
from django.db import DatabaseError, transaction
from django.test import Client

from specmate.access.models import WorkspaceMember
from specmate.builds.models import BuildStage, StageOutput
from specmate.operations import NotFound, PermissionDenied, Unsupported, ValidationFailed
from specmate.pcb.formats import CLASSIFIER, format_message, kicad_major
from specmate.pcb.models import PcbFormatUpgrade, PcbIntake
from specmate.pcb.native_script import PROGRAM as EXTRACT_PROGRAM
from specmate.pcb.native_script import SCRIPT as EXTRACT_SCRIPT
from specmate.pcb.pack import recipe_for, upgrade_recipe_for
from specmate.pcb.upgrade_report import UpgradeReport
from specmate.pcb.upgrade_script import PROGRAM as UPGRADE_PROGRAM
from specmate.pcb.upgrade_script import SCRIPT as UPGRADE_SCRIPT
from specmate.sources import blobstore
from specmate.sources.models import SourceBundle, SourceBundleRevision

from .conftest import op

RIGHTS = "AGPL-3.0-only"
BOARD_PATH = "hw/board.kicad_pcb"
SCH_PATH = "hw/board.kicad_sch"
# Synthetic stand-ins: the app never parses these bytes; only hashes are compared.
OLD_BOARD = b"(kicad_pcb (version 20221018) (generator pcbnew)\n)\n"
OLD_SCH = b"(kicad_sch (version 20230121) (generator eeschema)\n)\n"
NEW_BOARD = b'(kicad_pcb\n\t(version 20260206)\n\t(generator "pcbnew")\n)\n'
NEW_SCH = b'(kicad_sch\n\t(version 20260306)\n\t(generator "eeschema")\n)\n'
README = b"synthetic companion notes\n"


def digest(content):
    return hashlib.sha256(content).hexdigest()


def register(user, workspace, content):
    op(
        user,
        "source.register_blob",
        {
            "workspace_id": workspace,
            "sha256": digest(content),
            "size": len(content),
            "media_type": "application/octet-stream",
        },
        attachments={"content": io.BytesIO(content)},
    )


@pytest.fixture
def source(users, workspace):
    files = []
    for path, content in ((BOARD_PATH, OLD_BOARD), (SCH_PATH, OLD_SCH), ("README.md", README)):
        register(users["editor"], workspace, content)
        files.append(
            {
                "path": path,
                "sha256": digest(content),
                "media_type": "application/x-kicad" if path.startswith("hw/") else "text/plain",
                "rights": RIGHTS,
            }
        )
    return op(
        users["editor"],
        "source.create_original_bundle",
        {"workspace_id": workspace, "name": "Older synthetic board", "files": files},
    )


@pytest.fixture
def intake(users, workspace, source):
    return op(
        users["editor"],
        "pcb.register_intake",
        {
            "workspace_id": workspace,
            "source_revision_id": source["revision_id"],
            "board_path": BOARD_PATH,
        },
    )


@pytest.fixture
def recipes(settings):
    upgrade = upgrade_recipe_for(BOARD_PATH, RIGHTS, [SCH_PATH])
    extract = recipe_for(BOARD_PATH, RIGHTS)
    settings.SPECMATE_APPROVED_RECIPES = {upgrade["id"]: upgrade, extract["id"]: extract}
    return {"upgrade": upgrade, "extract": extract}


@pytest.fixture
def requested(users, intake, recipes):
    return op(
        users["owner"],
        "pcb.request_upgrade",
        {"intake_id": intake["intake_id"], "recipe_id": recipes["upgrade"]["id"]},
        idempotency_key="upgrade-one",
    )


def upgrade_report(**board_overrides):
    board = {
        "path": BOARD_PATH,
        "kind": "board",
        "output_path": "upgraded/" + BOARD_PATH,
        "source_sha256": digest(OLD_BOARD),
        "output_sha256": digest(NEW_BOARD),
        "from_format_version": 20221018,
        "from_kicad_major": 7,
        "to_format_version": 20260206,
        "argv": ["kicad-cli", "pcb", "upgrade", "/tmp/specmate-upgrade/0/board.kicad_pcb"],  # noqa: S108
        **board_overrides,
    }
    schematic = {
        "path": SCH_PATH,
        "kind": "schematic",
        "output_path": "upgraded/" + SCH_PATH,
        "source_sha256": digest(OLD_SCH),
        "output_sha256": digest(NEW_SCH),
        "from_format_version": 20230121,
        "from_kicad_major": 7,
        "to_format_version": 20260306,
        "argv": ["kicad-cli", "sch", "upgrade", "/tmp/specmate-upgrade/1/board.kicad_sch"],  # noqa: S108
    }
    return {
        "format_version": 1,
        "adapter": "kicad-format-upgrade-v1",
        "tool_version": "10.0.6",
        "files": [board, schematic],
        "unsupported": ["companion files preserved unchanged"],
        "physical_qualification": False,
    }


def finish(requested, report=None, state="succeeded", outputs=None):
    """Record verified stage outputs and a terminal receipt (runner protocol tested elsewhere)."""
    stage = BuildStage.objects.get(build_id=requested["build_id"])
    contents = outputs or {
        "kicad-upgrade.json": json.dumps(report or upgrade_report()).encode(),
        "upgraded/" + BOARD_PATH: NEW_BOARD,
        "upgraded/" + SCH_PATH: NEW_SCH,
    }
    receipt = []
    for path, content in contents.items():
        staged = blobstore.stage(io.BytesIO(content), 64 * 1024**2)
        blobstore.promote(staged)
        StageOutput.objects.create(
            stage=stage,
            path=path,
            sha256=digest(content),
            size=len(content),
            media_type="application/json" if path.endswith(".json") else "application/octet-stream",
            rights=RIGHTS,
            source_revision_id=stage.build.source_revision_id,
        )
        receipt.append({"path": path, "sha256": digest(content)})
    stage.state = state
    stage.receipt = {
        "outcome": state,
        "exit_code": 0 if state == "succeeded" else 1,
        "outputs": receipt,
    }
    stage.save()


def accept(users, requested, key="accept-one"):
    return op(
        users["editor"],
        "pcb.accept_upgrade",
        {"upgrade_attempt_id": requested["upgrade_attempt_id"]},
        idempotency_key=key,
    )


def test_format_classifier_gives_specific_messages():
    assert "KiCad 7 board format 20221018 must be upgraded first" in format_message(
        "board", 20221018
    )
    assert "KiCad 6 schematic format 20211123" in format_message("schematic", 20211123)
    assert "predates KiCad 6 and is too old" in format_message("board", 20171130)
    assert "not a released KiCad 6-10 format" in format_message("board", 20230517)
    assert "newer than KiCad 10.0.6" in format_message("board", 20990101)
    assert "Not a KiCad s-expression board" in format_message("board", None)
    assert [kicad_major("board", v) for v in (20211014, 20221018, 20240108, 20241229)] == [
        6,
        7,
        8,
        9,
    ]
    assert kicad_major("board", 20260206) == 10
    assert kicad_major("board", 20230517) is None
    # The native programs embed the very classifier text the app executes.
    assert CLASSIFIER in EXTRACT_PROGRAM and CLASSIFIER in UPGRADE_PROGRAM
    assert "Only KiCad board format" not in EXTRACT_SCRIPT


def test_upgrade_recipe_is_bounded_and_pins_exact_inputs_and_outputs():
    recipe = upgrade_recipe_for(BOARD_PATH, RIGHTS, ["z.kicad_sch", "a.kicad_sch"])
    assert len(UPGRADE_SCRIPT) <= 8192 and len(EXTRACT_SCRIPT) <= 8192
    assert recipe["argv"][3:] == [
        "/outputs",
        f"/inputs/{BOARD_PATH}",
        "/inputs/a.kicad_sch",
        "/inputs/z.kicad_sch",
    ]
    assert [o["path"] for o in recipe["outputs"]] == [
        "kicad-upgrade.json",
        "upgraded/" + BOARD_PATH,
        "upgraded/a.kicad_sch",
        "upgraded/z.kicad_sch",
    ]
    assert (
        recipe["network"] == "none" and recipe["image"] == recipe_for(BOARD_PATH, RIGHTS)["image"]
    )
    assert recipe["id"] != upgrade_recipe_for(BOARD_PATH, RIGHTS, [])["id"]
    assert "pcbnew" not in __import__("sys").modules


@pytest.mark.parametrize(
    "change",
    [
        {"from_format_version": 20230517},  # development format
        {"from_format_version": 20171130, "from_kicad_major": 6},  # KiCad 5
        {"from_kicad_major": 8},  # major disagrees with the format table
        {"to_format_version": 20241229},
        {"argv": ["sh", "-c", "true", "x"]},
        {"output_path": "elsewhere.kicad_pcb"},
    ],
)
def test_upgrade_report_rejects_unrecognized_or_inconsistent_claims(change):
    UpgradeReport.model_validate(upgrade_report())
    with pytest.raises(ValueError):
        UpgradeReport.model_validate(upgrade_report(**change))


def test_intake_offers_exact_upgrade_and_request_is_scoped(users, workspace, intake, recipes):
    assert intake["upgrade"]["available_recipe_id"] is None
    shown = op(users["viewer"], "pcb.get", {"intake_id": intake["intake_id"]})
    assert shown["upgrade"]["available_recipe_id"] == recipes["upgrade"]["id"]
    assert shown["upgrade"]["upgradable_kicad_majors"] == [6, 7, 8, 9]
    assert shown["format_upgrade"] is None
    payload = {"intake_id": intake["intake_id"], "recipe_id": recipes["upgrade"]["id"]}
    with pytest.raises(PermissionDenied):
        op(users["viewer"], "pcb.request_upgrade", payload, idempotency_key="v")
    with pytest.raises(NotFound):
        op(users["outsider"], "pcb.request_upgrade", payload, idempotency_key="o")
    with pytest.raises(Unsupported):
        op(
            users["owner"],
            "pcb.request_upgrade",
            {**payload, "recipe_id": recipes["extract"]["id"]},
            idempotency_key="wrong-recipe",
        )


def test_accepted_upgrade_is_a_derivative_with_original_ancestry(
    users, workspace, source, intake, recipes, requested
):
    finish(requested)
    result = accept(users, requested)
    original = SourceBundleRevision.objects.get(id=source["revision_id"])
    derived = SourceBundleRevision.objects.select_related("bundle").get(
        id=result["source_revision_id"]
    )
    assert derived.bundle.role == SourceBundle.Role.DERIVATIVE
    assert derived.bundle.derived_from_id == original.id
    assert json.loads(bytes(derived.manifest))["ancestry"] == [str(original.id)]
    files = {f.path: f.blob.sha256 for f in derived.files.select_related("blob")}
    assert files == {
        BOARD_PATH: digest(NEW_BOARD),
        SCH_PATH: digest(NEW_SCH),
        "README.md": digest(README),
    }
    # The original revision and its bytes are untouched.
    assert {f.path: f.blob.sha256 for f in original.files.select_related("blob")} == {
        BOARD_PATH: digest(OLD_BOARD),
        SCH_PATH: digest(OLD_SCH),
        "README.md": digest(README),
    }
    assert original.manifest_sha256 == source["manifest_sha256"]
    provenance = result["format_upgrade"]
    assert provenance["label"] == "Upgraded from KiCad 7 format"
    assert (provenance["from_format_version"], provenance["to_format_version"]) == (
        20221018,
        20260206,
    )
    assert provenance["image"] == recipes["upgrade"]["image"]
    assert provenance["files"][0]["argv"][:3] == ["kicad-cli", "pcb", "upgrade"]
    assert provenance["files"][1]["argv"][:3] == ["kicad-cli", "sch", "upgrade"]
    assert provenance["original_source_revision_id"] == source["revision_id"]
    assert provenance["original_intake_id"] == intake["intake_id"]
    assert provenance["build_id"] == requested["build_id"]
    assert result["board_path"] == BOARD_PATH and result["upgrade"] is None
    # Extraction runs on the derivative with the same approved, path-pinned recipe.
    assert result["available_recipe_id"] == recipes["extract"]["id"]
    extraction = op(
        users["owner"],
        "pcb.request_extraction",
        {"intake_id": result["intake_id"], "recipe_id": recipes["extract"]["id"]},
        idempotency_key="extract-derived",
    )
    stage = BuildStage.objects.select_related("build").get(build_id=extraction["build_id"])
    assert stage.build.source_revision_id == derived.id
    # The original intake lists the accepted derivative; acceptance is idempotent.
    original_view = op(users["viewer"], "pcb.get", {"intake_id": intake["intake_id"]})
    [attempt] = original_view["upgrade"]["attempts"]
    assert attempt["derived_intake_id"] == result["intake_id"]
    assert accept(users, requested, key="accept-two")["intake_id"] == result["intake_id"]
    assert accept(users, requested)["format_upgrade"] == provenance  # keyed replay
    assert PcbFormatUpgrade.objects.count() == 1
    # A recorded upgrade cannot itself be upgraded again.
    with pytest.raises(Unsupported):
        op(
            users["owner"],
            "pcb.request_upgrade",
            {"intake_id": result["intake_id"], "recipe_id": recipes["upgrade"]["id"]},
            idempotency_key="again",
        )
    viewer = op(users["viewer"], "pcb.get", {"intake_id": result["intake_id"]})
    assert viewer["format_upgrade"]["label"] == "Upgraded from KiCad 7 format"
    client = Client()
    client.force_login(users["viewer"])
    listed = {
        i["intake_id"]: i["upgraded_from_kicad"]
        for i in client.get(f"/api/v0/pcb/workspaces/{workspace}/intakes").json()
    }
    assert listed == {intake["intake_id"]: None, result["intake_id"]: 7}


def test_upgrade_evidence_is_immutable(users, requested):
    finish(requested)
    accept(users, requested)
    upgrade = PcbFormatUpgrade.objects.get()
    with pytest.raises(DatabaseError), transaction.atomic():
        PcbFormatUpgrade.objects.filter(id=upgrade.id).update(from_kicad_major=9)
    with pytest.raises(DatabaseError), transaction.atomic():
        upgrade.attempt.delete()


@pytest.mark.parametrize(
    ("report", "outputs"),
    [
        (upgrade_report(source_sha256="0" * 64), None),
        (upgrade_report(output_sha256=digest(b"other")), None),
        ({**upgrade_report(), "files": upgrade_report()["files"][:1]}, None),
        ({**upgrade_report(), "adapter": "something-else"}, None),
    ],
)
def test_accept_rejects_mismatched_native_evidence(users, requested, report, outputs):
    finish(requested, report=report, outputs=outputs)
    with pytest.raises(ValidationFailed):
        accept(users, requested)
    assert not PcbFormatUpgrade.objects.exists()
    assert not SourceBundle.objects.filter(role="derivative").exists()


def test_failed_upgrade_shows_specific_diagnostic_and_cannot_be_accepted(users, intake, requested):
    message = "hw/board.kicad_pcb: " + format_message("board", 20171130)
    finish(
        requested,
        state="failed",
        outputs={"kicad-upgrade.json": json.dumps({"status": "failed", "error": message}).encode()},
    )
    with pytest.raises(ValidationFailed):
        accept(users, requested)
    view = op(users["viewer"], "pcb.get", {"intake_id": intake["intake_id"]})
    [attempt] = view["upgrade"]["attempts"]
    assert attempt["state"] == "failed"
    assert "predates KiCad 6 and is too old" in attempt["diagnostic"]
    assert attempt["derived_intake_id"] is None


def test_accept_rechecks_current_authority(users, workspace, requested):
    finish(requested)
    with pytest.raises(PermissionDenied):
        op(
            users["viewer"],
            "pcb.accept_upgrade",
            {"upgrade_attempt_id": requested["upgrade_attempt_id"]},
            idempotency_key="viewer",
        )
    with pytest.raises(NotFound):
        op(
            users["outsider"],
            "pcb.accept_upgrade",
            {"upgrade_attempt_id": requested["upgrade_attempt_id"]},
            idempotency_key="outsider",
        )
    with pytest.raises(NotFound):
        op(
            users["editor"],
            "pcb.accept_upgrade",
            {"upgrade_attempt_id": str(uuid4())},
            idempotency_key="missing",
        )
    result = accept(users, requested)
    WorkspaceMember.objects.filter(workspace_id=workspace, user=users["editor"]).delete()
    with pytest.raises(NotFound):
        accept(users, requested)
    assert PcbIntake.objects.filter(id=result["intake_id"]).exists()
