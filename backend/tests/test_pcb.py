"""PCB intake authorization/provenance contracts; native qualification is opt-in."""

import copy
import hashlib
import io
import json
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import pytest
from django.db import DatabaseError, transaction
from django.test import Client

from specmate.access.models import Membership
from specmate.builds.models import BuildAttempt, BuildOutbox, BuildStage, StageOutput
from specmate.operations import (
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    Unsupported,
    ValidationFailed,
)
from specmate.pcb.models import PcbExtractionAttempt, PcbIntake, PcbInterpretation
from specmate.pcb.pack import IMAGE, SCRIPT, recipe_for
from specmate.pcb.report import Report
from specmate.sources import blobstore

from .conftest import op

ROOT = Path(__file__).resolve().parents[2]
RIGHTS = "AGPL-3.0-only"
BOARD = (ROOT / "tests/fixtures/native/kicad/two-net-board.kicad_pcb").read_bytes()


def digest(content):
    return hashlib.sha256(content).hexdigest()


@pytest.fixture
def source(users, project):
    files = []
    for path, content in (
        ("board.kicad_pcb", BOARD),
        ("source.py", b"raise RuntimeError('inert')\n"),
        ("schematic.kicad_sch", b"preserved unsupported schematic\n"),
    ):
        op(
            users["editor"],
            "source.register_blob",
            {
                "project_id": project,
                "sha256": digest(content),
                "size": len(content),
                "media_type": "application/octet-stream",
            },
            attachments={"content": io.BytesIO(content)},
        )
        files.append(
            {
                "path": path,
                "sha256": digest(content),
                "media_type": "application/octet-stream",
                "rights": RIGHTS,
            }
        )
    return op(
        users["editor"],
        "source.create_original_bundle",
        {
            "project_id": project,
            "name": "Synthetic PCB package",
            "files": files,
        },
    )


@pytest.fixture
def intake(users, project, source):
    return op(
        users["editor"],
        "pcb.register_intake",
        {
            "project_id": project,
            "source_revision_id": source["revision_id"],
            "board_path": "board.kicad_pcb",
        },
    )


@pytest.fixture
def recipe(settings):
    recipe = recipe_for("board.kicad_pcb", RIGHTS)
    settings.SPECMATE_APPROVED_RECIPES = {recipe["id"]: recipe}
    return recipe


@pytest.fixture
def attempt(users, intake, recipe):
    return op(
        users["owner"],
        "pcb.request_extraction",
        {
            "intake_id": intake["intake_id"],
            "recipe_id": recipe["id"],
        },
        idempotency_key="pcb-extract-one",
    )


def report_payload():
    """Contract sample is deliberately partial; this is not a fake native proof."""
    return {
        "format_version": 1,
        "adapter": "kicad-intake-v1",
        "tool_version": "10.0.6",
        "native_format_version": 20260206,
        "source_sha256": digest(BOARD),
        "units": "mm",
        "coordinate_frame": "KiCad absolute: x right, y down; angles native degrees",
        "components": [],
        "pads": [],
        "copper_nets": {},
        "outline": [],
        "cutouts": [],
        "mounting_holes": [],
        "component_passages": [],
        "coverage": {
            "components": "identity-reference-value-footprint-and-flags",
            "pads": "identity-and-basic-geometry",
            "nets": "pad-membership-not-connectivity-proof",
            "outline": "unsupported",
            "holes": "nonplated-pad-drills-not-reviewed-mounts",
            "placements": "native-absolute",
        },
        "unsupported": [
            "outline unresolved",
            "schematic unsupported",
            "models unsupported",
            "manufacturing unsupported",
        ],
        "physical_qualification": False,
    }


def successful_output(attempt, report=None):
    """Set up immutable verified build evidence; runner protocol has separate tests."""
    content = json.dumps(report or report_payload()).encode()
    staged = blobstore.stage(io.BytesIO(content), 2 * 1024**2)
    blobstore.promote(staged)
    stage = BuildStage.objects.get(build_id=attempt["build_id"])
    output = StageOutput.objects.create(
        stage=stage,
        path="pcb-intake.json",
        sha256=digest(content),
        size=len(content),
        media_type="application/json",
        rights=RIGHTS,
        source_revision_id=stage.build.source_revision_id,
    )
    stage.state = "succeeded"
    stage.receipt = {
        "outcome": "succeeded",
        "exit_code": 0,
        "outputs": [{"path": output.path, "sha256": output.sha256}],
    }
    stage.save()
    return output


def test_intake_preserves_exact_sources_and_reports_unparsed_coverage(users, source, intake):
    assert intake["source_revision_id"] == source["revision_id"]
    assert intake["source_manifest_sha256"] == source["manifest_sha256"]
    assert not BuildAttempt.objects.exists()
    files = {f["path"]: f for f in intake["files"]}
    assert files["source.py"]["coverage"] == "preserved-unparsed"
    assert files["schematic.kicad_sch"]["unsupported"]
    assert not intake["support"]["version_verified"]
    with blobstore.open_blob(files["board.kicad_pcb"]["sha256"]) as stream:
        assert stream.read() == BOARD
    client = Client()
    client.force_login(users["viewer"])
    response = client.get(
        f"/api/v0/pcb/intakes/{intake['intake_id']}/original", {"path": "board.kicad_pcb"}
    )
    assert response.status_code == 200
    assert b"".join(response.streaming_content) == BOARD
    assert response["Content-Disposition"].startswith("attachment;")


def test_intake_scope_and_selection(users, project, source):
    payload = {"project_id": project, "source_revision_id": source["revision_id"]}
    for user, error in (("viewer", PermissionDenied), ("outsider", NotFound)):
        with pytest.raises(error):
            op(users[user], "pcb.register_intake", payload)
    with pytest.raises(NotFound):
        op(users["owner"], "pcb.register_intake", {**payload, "source_revision_id": str(uuid4())})
    for board_path, error in (
        ("missing.kicad_pcb", ValidationFailed),
        ("schematic.kicad_sch", Unsupported),
        ("../board.kicad_pcb", ValidationFailed),
    ):
        with pytest.raises(error):
            op(users["owner"], "pcb.register_intake", {**payload, "board_path": board_path})
    assert not PcbIntake.objects.exists()
    result = op(users["owner"], "pcb.register_intake", payload)
    assert all(f["coverage"] == "preserved-unparsed" for f in result["files"])


def test_request_uses_one_shared_build_outbox_and_idempotency(users, intake, recipe, attempt):
    payload = {"intake_id": intake["intake_id"], "recipe_id": recipe["id"]}
    assert (
        op(users["owner"], "pcb.request_extraction", payload, idempotency_key="pcb-extract-one")
        == attempt
    )
    assert (
        BuildAttempt.objects.count()
        == BuildOutbox.objects.count()
        == PcbExtractionAttempt.objects.count()
        == 1
    )
    with pytest.raises(IdempotencyMismatch):
        op(
            users["owner"],
            "pcb.request_extraction",
            {**payload, "recipe_id": "other"},
            idempotency_key="pcb-extract-one",
        )
    with pytest.raises(PermissionDenied):
        op(users["editor"], "pcb.request_extraction", payload, idempotency_key="editor")
    with pytest.raises(NotFound):
        op(users["outsider"], "pcb.request_extraction", payload, idempotency_key="outsider")
    with pytest.raises(ValidationFailed):
        op(users["owner"], "pcb.request_extraction", payload)


@pytest.mark.parametrize(
    "field,value",
    [
        ("image", "example.invalid/tool@sha256:" + "1" * 64),
        ("argv", ["/usr/bin/python3", "-c", "print('forged')"]),
        (
            "outputs",
            [{"path": "different.json", "media_type": "application/json", "rights": RIGHTS}],
        ),
    ],
)
def test_unrelated_approved_recipe_cannot_be_pcb_extraction(
    users, intake, recipe, settings, field, value
):
    forged = {**recipe, field: value}
    settings.SPECMATE_APPROVED_RECIPES = {recipe["id"]: forged}
    with pytest.raises(Unsupported):
        op(
            users["owner"],
            "pcb.request_extraction",
            {
                "intake_id": intake["intake_id"],
                "recipe_id": recipe["id"],
            },
            idempotency_key="forged",
        )
    assert not BuildAttempt.objects.exists()


def test_attempt_and_build_rollback_together(users, intake, recipe):
    with patch(
        "specmate.pcb.operations.PcbExtractionAttempt.objects.create",
        side_effect=RuntimeError("rollback"),
    ):
        with pytest.raises(RuntimeError):
            op(
                users["owner"],
                "pcb.request_extraction",
                {
                    "intake_id": intake["intake_id"],
                    "recipe_id": recipe["id"],
                },
                idempotency_key="rollback",
            )
    assert not BuildAttempt.objects.exists()
    assert not BuildOutbox.objects.exists()


def test_accept_validated_report_links_exact_revision_and_is_immutable(users, intake, attempt):
    output = successful_output(attempt)
    accepted = op(users["editor"], "pcb.accept_extraction", {"attempt_id": attempt["attempt_id"]})
    assert accepted["output_id"] == str(output.id)
    assert accepted["report"]["source_sha256"] == digest(BOARD)
    assert (
        op(users["editor"], "pcb.accept_extraction", {"attempt_id": attempt["attempt_id"]})
        == accepted
    )
    assert PcbInterpretation.objects.count() == 1
    for model in (PcbIntake, PcbExtractionAttempt, PcbInterpretation):
        with pytest.raises(DatabaseError), transaction.atomic():
            model.objects.all().delete()
    with pytest.raises(DatabaseError), transaction.atomic():
        PcbInterpretation.objects.all().update(sha256="0" * 64)
    read = op(users["viewer"], "pcb.get", {"intake_id": intake["intake_id"]})
    assert read["interpretations"] == [accepted]


@pytest.mark.parametrize(
    "field,value",
    [
        ("source_sha256", "0" * 64),
        ("tool_version", "unknown"),
        ("physical_qualification", True),
        ("copper_nets", {"invented": ["R1.1"]}),
    ],
)
def test_wrong_source_or_unsupported_or_inconsistent_report_rejected(users, attempt, field, value):
    report = report_payload()
    report[field] = value
    successful_output(attempt, report)
    with pytest.raises(ValidationFailed):
        op(users["editor"], "pcb.accept_extraction", {"attempt_id": attempt["attempt_id"]})
    assert not PcbInterpretation.objects.exists()


def test_incomplete_stage_cannot_be_accepted(users, attempt):
    with pytest.raises(ValidationFailed):
        op(users["editor"], "pcb.accept_extraction", {"attempt_id": attempt["attempt_id"]})
    assert not PcbInterpretation.objects.exists()


def test_report_corruption_and_wrong_receipt_are_rejected(users, attempt):
    output = successful_output(attempt)
    stage = output.stage
    stage.receipt["outputs"][0]["sha256"] = "0" * 64
    # Terminal receipts are immutable at the DB, so malformed evidence cannot replace one.
    with pytest.raises(DatabaseError), transaction.atomic():
        stage.save()
    path = blobstore.blob_path(output.sha256)
    path.chmod(0o600)
    path.write_bytes(b"corrupt derived report")
    with pytest.raises(ValidationFailed):
        op(users["editor"], "pcb.accept_extraction", {"attempt_id": attempt["attempt_id"]})


def test_api_and_job_authorization_apply_to_reports_and_originals_after_revocation(
    users, project, intake, attempt
):
    successful_output(attempt)
    op(users["editor"], "pcb.accept_extraction", {"attempt_id": attempt["attempt_id"]})
    client = Client()
    client.force_login(users["viewer"])
    path = f"/api/v0/pcb/intakes/{intake['intake_id']}"
    assert client.get(path).status_code == 200
    with pytest.raises(PermissionDenied):
        op(users["viewer"], "pcb.accept_extraction", {"attempt_id": attempt["attempt_id"]})
    Membership.objects.filter(project_id=project, user=users["viewer"]).delete()
    for endpoint in (
        path,
        path + "/original?path=board.kicad_pcb",
        f"/api/v0/pcb/projects/{project}/intakes",
    ):
        response = client.get(endpoint)
        assert response.status_code == 404
        assert b"board.kicad_pcb" not in response.content
    with pytest.raises(NotFound):
        op(users["viewer"], "pcb.get", {"intake_id": intake["intake_id"]})
    with pytest.raises(NotFound):
        op(users["viewer"], "pcb.accept_extraction", {"attempt_id": attempt["attempt_id"]})


def test_recipe_program_is_bounded_and_native_import_never_occurs_in_app():
    assert IMAGE.endswith("40568bc95527f3a673a31a9b59badf512e71046c2d5068a364503c525f946a4e")
    assert len(SCRIPT) <= 8192
    assert "pcbnew" not in __import__("sys").modules
    assert (
        recipe_for("nested/board.kicad_pcb", RIGHTS)["argv"][-2] == "/inputs/nested/board.kicad_pcb"
    )
    original = report_payload()
    invalid = copy.deepcopy(original)
    invalid["outline"] = [[[0, 0], [40, 0], [40, 25], [0, 25]]]
    with pytest.raises(ValueError):
        Report.model_validate(invalid)


def test_replay_guard_rechecks_scope_execution_and_recipe(
    users, project, intake, attempt, recipe, settings
):
    from specmate.operations import Context
    from specmate.pcb.operations import RequestExtraction, authorize_pcb_replay

    payload = RequestExtraction(intake_id=intake["intake_id"], recipe_id=recipe["id"])
    ctx = Context(user=users["owner"], via="job", request_id="replay")
    authorize_pcb_replay(ctx, payload, attempt)
    settings.SPECMATE_APPROVED_RECIPES = {}
    with pytest.raises(Unsupported):
        authorize_pcb_replay(ctx, payload, attempt)
    settings.SPECMATE_APPROVED_RECIPES = {recipe["id"]: recipe}
    membership = Membership.objects.get(project_id=project, user=users["owner"])
    membership.role = "viewer"
    membership.save()
    with pytest.raises(PermissionDenied):
        authorize_pcb_replay(ctx, payload, attempt)
    membership.delete()
    with pytest.raises(NotFound):
        authorize_pcb_replay(ctx, payload, attempt)


def test_replay_accept_guard_rechecks_scope_and_pinned_provenance(users, project, attempt):
    from specmate.operations import Context
    from specmate.pcb.operations import AttemptRef, authorize_pcb_replay

    successful_output(attempt)
    accepted = op(users["editor"], "pcb.accept_extraction", {"attempt_id": attempt["attempt_id"]})
    ctx = Context(user=users["editor"], via="job", request_id="replay")
    payload = AttemptRef(attempt_id=attempt["attempt_id"])
    authorize_pcb_replay(ctx, payload, accepted)
    with pytest.raises(ValidationFailed):
        authorize_pcb_replay(ctx, payload, {**accepted, "output_id": str(uuid4())})
    Membership.objects.filter(project_id=project, user=users["editor"]).delete()
    with pytest.raises(NotFound):
        authorize_pcb_replay(ctx, payload, accepted)
