"""Fabrication authorization and registered evidence contracts, not native proof."""

import copy
import hashlib
import io
import json
from uuid import uuid4

import pytest
from django.test import RequestFactory

from specmate.access.models import WorkspaceMember
from specmate.builds.models import BuildAttempt, BuildOutbox, BuildStage, StageOutput
from specmate.builds.rights import derive_for_record, derive_for_revision
from specmate.operations import (
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    Unauthenticated,
    Unsupported,
    ValidationFailed,
)
from specmate.pcb.models import PcbIntake
from specmate.pcb_fabrication import (
    operations,  # noqa: F401 -- register for this isolated module test
)
from specmate.pcb_fabrication.api import download_output, read_build, read_options
from specmate.pcb_fabrication.native_script import DIAGNOSTICS, STDERR_CLASSES, script
from specmate.pcb_fabrication.pack import (
    ARG_CHUNK,
    MAX_OUTPUT_BYTES,
    REPORT_PATH,
    layers_for,
    output_media,
    recipe_for,
)
from specmate.pcb_fabrication.report import FailureReport
from specmate.sources import blobstore
from specmate.sources.models import SourceBundle, SourceBundleFile, SourceBundleRevision

from . import test_pcb as pcb_fixture
from .conftest import op
from .test_pcb import (
    BOARD,
    RIGHTS,
    report_payload,
    successful_output,
)


@pytest.fixture
def source(users, workspace):
    return pcb_fixture.source.__wrapped__(users, workspace)


@pytest.fixture
def intake(users, workspace, source):
    return pcb_fixture.intake.__wrapped__(users, workspace, source)


@pytest.fixture
def recipe(settings):
    return pcb_fixture.recipe.__wrapped__(settings)


@pytest.fixture
def attempt(users, intake, recipe):
    return pcb_fixture.attempt.__wrapped__(users, intake, recipe)


@pytest.fixture
def accepted(users, intake, attempt):
    report = report_payload()
    report["outline"] = [[[0, 0], [40, 0], [40, 25], [0, 25]]]
    report["coverage"]["outline"] = "closed-line-polygons"
    successful_output(attempt, report)
    return op(users["editor"], "pcb.accept_extraction", {"attempt_id": attempt["attempt_id"]})


@pytest.fixture
def fabrication_recipe(settings, recipe):
    item = recipe_for("board.kicad_pcb", RIGHTS)
    settings.SPECMATE_APPROVED_RECIPES = {recipe["id"]: recipe, item["id"]: item}
    return item


@pytest.fixture
def requested(users, intake, accepted, fabrication_recipe):
    return op(
        users["owner"],
        "pcb_fabrication.request",
        {"intake_id": intake["intake_id"], "recipe_id": fabrication_recipe["id"]},
        idempotency_key="fabrication-one",
    )


def register_test_outputs(
    requested,
    mutate=None,
    invalid=None,
    source_revision_id=None,
    copper=2,
    project=None,
    rights=RIGHTS,
):
    stage = BuildStage.objects.get(build_id=requested["build_id"])
    media = output_media(copper)
    payloads = {p: ("contract-only " + p).encode() for p in media if p != REPORT_PATH}
    drc = {
        "$schema": "https://schemas.kicad.org/drc.v1.json",
        "kicad_version": "10.0.6",
        "coordinate_units": "mm",
        "violations": [{"severity": "error"}],
        "unconnected_items": [],
        "schematic_parity": [],
    }
    payloads["drc.json"] = json.dumps(drc).encode()
    report = {
        "format_version": 2,
        "adapter": "kicad-fabrication-v2",
        "status": "succeeded",
        "tool_version": "10.0.6",
        "native_format_version": 20260206,
        "source_sha256": hashlib.sha256(BOARD).hexdigest(),
        "source_unchanged": True,
        "project": project,
        "custom_rules": None,
        "copper_layer_count": copper,
        "layers": layers_for(copper),
        "drill_format": "excellon-mm-decimal-absolute-separated-through-g85-slots",
        "drills": {"pth": [[30, 10, 0.4, 0.4, 0]], "npth": [[37, 22, 2, 1, 0]]},
        "features": {
            "through_vias": 1,
            "slots": 1,
            "copper_zones": 1,
            "copper_zones_without_stored_copper": 0,
            "rule_areas": 0,
            "zones_refilled": False,
            "production_graphics": 2,
            "unresolved_text_variables": 0,
            "outlines": 1,
            "cutouts": 1,
        },
        "drc_counts": {"violations": 1, "unconnected_items": 0, "schematic_parity": 0},
        "outputs": [
            {"path": p, "sha256": hashlib.sha256(raw).hexdigest(), "size": len(raw)}
            for p, raw in sorted(payloads.items())
        ],
        "physical_qualification": False,
        "manufacturing_approval": False,
        "unsupported": ["schematic parity and physical qualification"],
    }
    if mutate:
        mutate(report)
    payloads[REPORT_PATH] = json.dumps(report).encode()
    for path, content in payloads.items():
        if invalid == "missing" and path == "board-NPTH.drl":
            continue
        blobstore.promote(blobstore.stage(io.BytesIO(content), 16 * 1024**2))
        StageOutput.objects.create(
            stage=stage,
            path=path,
            sha256=hashlib.sha256(content).hexdigest(),
            size=len(content),
            media_type="text/plain" if invalid == "media" else media[path],
            rights="wrong-rights" if invalid == "rights" else rights,
            source_revision_id=source_revision_id or stage.build.source_revision_id,
        )
    stage.state = "succeeded"
    stage.receipt = {
        "outcome": "succeeded",
        "exit_code": 0,
        "outputs": [{"path": o.path, "sha256": o.sha256} for o in stage.outputs.all()],
    }
    if invalid == "receipt":
        stage.receipt["exit_code"] = 1
    stage.save()
    return stage


def read_request(user):
    request = RequestFactory().get("/")
    request.user = user
    return request


def test_request_requires_accepted_outline_and_exact_approved_recipe(
    users, intake, fabrication_recipe
):
    before = BuildAttempt.objects.count()
    with pytest.raises(Unsupported):
        op(
            users["owner"],
            "pcb_fabrication.request",
            {"intake_id": intake["intake_id"], "recipe_id": fabrication_recipe["id"]},
            idempotency_key="no-intake",
        )
    assert BuildAttempt.objects.count() == before


def test_request_replay_scope_and_outbox(users, intake, requested, fabrication_recipe, settings):
    payload = {"intake_id": intake["intake_id"], "recipe_id": fabrication_recipe["id"]}
    before = BuildAttempt.objects.count()
    assert (
        op(users["owner"], "pcb_fabrication.request", payload, idempotency_key="fabrication-one")
        == requested
    )
    assert BuildAttempt.objects.count() == before
    assert BuildOutbox.objects.filter(build_id=requested["build_id"]).count() == 1
    with pytest.raises(IdempotencyMismatch):
        op(
            users["owner"],
            "pcb_fabrication.request",
            {**payload, "recipe_id": "different"},
            idempotency_key="fabrication-one",
        )
    for name, error in (("viewer", PermissionDenied), ("outsider", NotFound)):
        with pytest.raises(error):
            op(users[name], "pcb_fabrication.request", payload, idempotency_key="denied")
    altered = copy.deepcopy(fabrication_recipe)
    altered["limits"]["cpus"] = 3
    settings.SPECMATE_APPROVED_RECIPES = {altered["id"]: altered}
    with pytest.raises(Unsupported):
        op(users["owner"], "pcb_fabrication.request", payload, idempotency_key="fabrication-one")


def test_review_drc_findings_download_and_revoked_access(users, intake, requested):
    stage = register_test_outputs(requested)
    payload = {"intake_id": intake["intake_id"], "build_id": requested["build_id"]}
    result = op(users["viewer"], "pcb_fabrication.read", payload)
    assert result["report"]["drc_counts"]["violations"] == 1
    assert result["report"]["manufacturing_approval"] is False
    assert len(result["outputs"]) == 14
    assert (
        read_build(read_request(users["viewer"]), intake["intake_id"], requested["build_id"])
        == result
    )
    output = stage.outputs.get(path="drc.json")
    response = download_output(
        read_request(users["viewer"]), intake["intake_id"], requested["build_id"], output.id
    )
    assert hashlib.sha256(b"".join(response.streaming_content)).hexdigest() == output.sha256
    assert "attachment" in response["Content-Disposition"]
    assert (
        read_options(read_request(users["viewer"]), intake["intake_id"])["builds"][0]["state"]
        == "succeeded"
    )
    WorkspaceMember.objects.filter(user=users["viewer"]).delete()
    with pytest.raises(NotFound):
        op(users["viewer"], "pcb_fabrication.read", payload)
    with pytest.raises(NotFound):
        download_output(
            read_request(users["viewer"]), intake["intake_id"], requested["build_id"], output.id
        )


@pytest.mark.parametrize(
    "mutation",
    [
        lambda report: report.update(source_sha256="a" * 64),
        lambda report: report.update(manufacturing_approval=True),
        lambda report: report.update(layers=["F.Cu"]),
        lambda report: report["outputs"][0].update(sha256="b" * 64),
        lambda report: report["drc_counts"].update(violations=0),
    ],
)
def test_review_rejects_contradictory_registered_reports(users, intake, requested, mutation):
    register_test_outputs(requested, mutation)
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "pcb_fabrication.read",
            {"intake_id": intake["intake_id"], "build_id": requested["build_id"]},
        )


def test_failed_or_partial_native_stage_never_becomes_reviewable(users, intake, requested):
    stage = BuildStage.objects.get(build_id=requested["build_id"])
    stage.state = "failed"
    stage.receipt = {"outcome": "failed", "exit_code": 1}
    stage.save()
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "pcb_fabrication.read",
            {"intake_id": intake["intake_id"], "build_id": requested["build_id"]},
        )
    with pytest.raises(NotFound):
        read_build(read_request(users["owner"]), intake["intake_id"], uuid4())


@pytest.mark.parametrize("invalid", ["missing", "rights", "media", "receipt"])
def test_review_requires_complete_output_provenance(users, intake, requested, invalid):
    register_test_outputs(requested, invalid=invalid)
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "pcb_fabrication.read",
            {"intake_id": intake["intake_id"], "build_id": requested["build_id"]},
        )


def test_keyed_mismatch_rechecks_current_authority(users, intake, requested):
    WorkspaceMember.objects.filter(user=users["owner"]).delete()
    with pytest.raises(NotFound):
        op(
            users["owner"],
            "pcb_fabrication.request",
            {"intake_id": intake["intake_id"], "recipe_id": "changed-recipe"},
            idempotency_key="fabrication-one",
        )


def derived_record(user, source_id, parent_id):
    """Synthetic retained same-workspace ancestry; no source bytes are fabricated."""
    source = SourceBundleRevision.objects.select_related("bundle").get(id=source_id)
    bundle = SourceBundle.objects.create(
        workspace_id=source.bundle.workspace_id,
        name="Synthetic retained derivative",
        role="derivative",
        derived_from_id=parent_id,
        created_by=user,
    )
    revision = SourceBundleRevision.objects.create(
        bundle=bundle,
        number=1,
        manifest=source.manifest,
        manifest_sha256=source.manifest_sha256,
        created_by=user,
    )
    for file in source.files.all():
        SourceBundleFile.objects.create(
            revision=revision,
            path=file.path,
            blob=file.blob,
            rights=file.rights,
            media_type=file.media_type,
        )
    return revision


def test_lost_membership_blocks_request_and_options_before_missing_report(
    users, source, fabrication_recipe
):
    derived = derived_record(users["owner"], source["revision_id"], source["revision_id"])
    item = PcbIntake.objects.create(
        source_revision=derived, board_path="board.kicad_pcb", created_by=users["owner"]
    )
    WorkspaceMember.objects.filter(user=users["owner"]).delete()
    with pytest.raises(NotFound):
        op(
            users["owner"],
            "pcb_fabrication.request",
            {"intake_id": str(item.id), "recipe_id": fabrication_recipe["id"]},
            idempotency_key="hidden-parent",
        )
    with pytest.raises(NotFound):
        read_options(read_request(users["owner"]), item.id)


def test_lost_membership_precedes_provenance_diagnostics_and_keyed_mismatch(
    users, intake, source, requested
):
    derived = derived_record(users["owner"], source["revision_id"], source["revision_id"])
    stage = register_test_outputs(requested, source_revision_id=derived.id)
    WorkspaceMember.objects.filter(user=users["owner"]).delete()
    with pytest.raises(NotFound):
        read_build(read_request(users["owner"]), intake["intake_id"], requested["build_id"])
    with pytest.raises(NotFound):
        download_output(
            read_request(users["owner"]),
            intake["intake_id"],
            requested["build_id"],
            stage.outputs.first().id,
        )
    for recipe_id in [stage.build.recipe_id, "changed-recipe"]:
        with pytest.raises(NotFound):
            op(
                users["owner"],
                "pcb_fabrication.request",
                {"intake_id": intake["intake_id"], "recipe_id": recipe_id},
                idempotency_key="fabrication-one",
            )


def test_direct_api_refresh_rejects_stale_inactive_actor(users, intake, requested):
    from django.contrib.auth import get_user_model

    register_test_outputs(requested)
    get_user_model().objects.filter(pk=users["owner"].pk).update(is_active=False)
    assert users["owner"].is_active  # Stale request object must not grant authority.
    with pytest.raises(Unauthenticated):
        read_options(read_request(users["owner"]), intake["intake_id"])
    with pytest.raises(Unauthenticated):
        read_build(read_request(users["owner"]), intake["intake_id"], requested["build_id"])


# --- Real-board support and specific diagnostics (native boundary mocked) ---


def failed_stage(requested, exit_code, report=None, path=REPORT_PATH, message=None):
    stage = BuildStage.objects.get(build_id=requested["build_id"])
    outputs = []
    if report is not None:
        content = json.dumps(report).encode()
        blobstore.promote(blobstore.stage(io.BytesIO(content), 16 * 1024**2))
        output = StageOutput.objects.create(
            stage=stage,
            path=path,
            sha256=hashlib.sha256(content).hexdigest(),
            size=len(content),
            media_type="application/json",
            rights=RIGHTS,
            source_revision_id=stage.build.source_revision_id,
        )
        outputs.append({"path": output.path, "sha256": output.sha256})
    stage.state = "failed"
    stage.receipt = {"outcome": "failed", "exit_code": exit_code, "outputs": outputs}
    if message:
        stage.receipt["message"] = message
    stage.save()
    return stage


def failure_report(code, native=None, detail=""):
    check, message = DIAGNOSTICS[code]
    return {
        "format_version": 2,
        "adapter": "kicad-fabrication-v2",
        "status": "failed",
        "code": code,
        "check": check,
        "message": message,
        "detail": detail,
        "native": native,
        "manufacturing_approval": False,
        "physical_qualification": False,
    }


def build_row(user, intake, requested):
    rows = read_options(read_request(user), intake["intake_id"])["builds"]
    return next(r for r in rows if r["build_id"] == requested["build_id"])


@pytest.mark.parametrize(
    "code,check",
    [
        (11, "board_format"),
        (14, "copper_layer_count"),
        (16, "board_outline"),
        (17, "via_type"),
        (19, "unfilled_zones"),
        (20, "project_file"),
    ],
)
def test_failed_build_names_the_failed_check_from_the_exit_code(
    users, intake, requested, code, check
):
    failed_stage(requested, code)
    diagnostic = build_row(users["viewer"], intake, requested)["diagnostic"]
    assert diagnostic["code"] == code
    assert diagnostic["check"] == check
    assert diagnostic["message"] == DIAGNOSTICS[code][1]
    assert "Unsupported input or native export failure" not in diagnostic["message"]
    assert diagnostic["detail_retained"] is False


def test_native_failure_report_adds_classification_but_keeps_stderr_private(
    users, intake, requested
):
    excerpt = "synthetic native stderr: failed to load board"
    native = {"exit_code": 3, "stderr_class": "invalid_input", "stderr_excerpt": excerpt}
    failed_stage(requested, 32, failure_report(32, native, "export gerbers"))
    row = build_row(users["viewer"], intake, requested)
    assert row["diagnostic"] == {
        "code": 32,
        "check": "native_gerber_export",
        "message": DIAGNOSTICS[32][1],
        "detail": "export gerbers",
        "stderr_class": "invalid_input",
        "detail_retained": True,
    }
    assert excerpt not in json.dumps(row)
    # The bounded excerpt remains only in the registered, access-checked failure report.
    stage = BuildStage.objects.get(build_id=requested["build_id"])
    with blobstore.open_blob(stage.outputs.get(path=REPORT_PATH).sha256) as stream:
        assert FailureReport.model_validate_json(stream.read()).native.stderr_excerpt == excerpt


@pytest.mark.parametrize(
    "exit_code,message,expected",
    [
        (137, None, (137, "unknown", DIAGNOSTICS[70][1])),
        (None, "Stage exceeded timeout", (None, "runner", "Stage exceeded timeout")),
    ],
)
def test_unknown_exit_codes_and_runner_failures_are_labelled(
    users, intake, requested, exit_code, message, expected
):
    failed_stage(requested, exit_code, message=message)
    diagnostic = build_row(users["viewer"], intake, requested)["diagnostic"]
    assert (diagnostic["code"], diagnostic["check"], diagnostic["message"]) == expected


@pytest.mark.parametrize(
    "report",
    [
        failure_report(19),  # differs from the receipt's exit code
        {**failure_report(31), "message": "Rewritten explanation"},
        {**failure_report(31), "native": {"exit_code": 1, "stderr_class": "made-up"}},
    ],
)
def test_contradictory_failure_reports_are_rejected(users, intake, requested, report):
    failed_stage(requested, 31, report)
    with pytest.raises(ValidationFailed):
        read_options(read_request(users["viewer"]), intake["intake_id"])


def test_failed_build_is_never_reviewable_as_fabrication_evidence(users, intake, requested):
    failed_stage(requested, 31, failure_report(31))
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "pcb_fabrication.read",
            {"intake_id": intake["intake_id"], "build_id": requested["build_id"]},
        )


def test_intake_outline_shape_does_not_gate_fabrication(users, intake, attempt, fabrication_recipe):
    report = report_payload()
    report["outline"] = []
    report["coverage"]["outline"] = "unsupported"  # e.g. arcs before intake supports them
    successful_output(attempt, report)
    op(users["editor"], "pcb.accept_extraction", {"attempt_id": attempt["attempt_id"]})
    result = op(
        users["owner"],
        "pcb_fabrication.request",
        {"intake_id": intake["intake_id"], "recipe_id": fabrication_recipe["id"]},
        idempotency_key="arc-outline",
    )
    assert result["build_id"]


def test_four_layer_recipe_declares_inner_layers_and_reviews_complete_output_set(
    users, intake, accepted, settings, recipe
):
    four = recipe_for("board.kicad_pcb", RIGHTS, 4)
    two = recipe_for("board.kicad_pcb", RIGHTS)
    settings.SPECMATE_APPROVED_RECIPES = {recipe["id"]: recipe, four["id"]: four, two["id"]: two}
    listed = read_options(read_request(users["viewer"]), intake["intake_id"])
    assert {(r["recipe_id"], r["copper_layers"]) for r in listed["available_recipes"]} == {
        (two["id"], 2),
        (four["id"], 4),
    }
    requested = op(
        users["owner"],
        "pcb_fabrication.request",
        {"intake_id": intake["intake_id"], "recipe_id": four["id"]},
        idempotency_key="four-layer",
    )
    register_test_outputs(requested, copper=4)
    result = op(
        users["viewer"],
        "pcb_fabrication.read",
        {"intake_id": intake["intake_id"], "build_id": requested["build_id"]},
    )
    assert result["report"]["layers"][:4] == ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"]
    assert {o["path"] for o in result["outputs"]} == set(output_media(4))
    assert build_row(users["viewer"], intake, requested)["copper_layers"] == 4


def test_two_layer_report_cannot_satisfy_a_four_layer_build(users, intake, accepted, settings):
    four = recipe_for("board.kicad_pcb", RIGHTS, 4)
    settings.SPECMATE_APPROVED_RECIPES = {four["id"]: four}
    requested = op(
        users["owner"],
        "pcb_fabrication.request",
        {"intake_id": intake["intake_id"], "recipe_id": four["id"]},
        idempotency_key="four-layer-mismatch",
    )
    register_test_outputs(requested, copper=2)
    with pytest.raises(ValidationFailed):
        op(
            users["viewer"],
            "pcb_fabrication.read",
            {"intake_id": intake["intake_id"], "build_id": requested["build_id"]},
        )


PROJECT = b'{"meta": {"version": 3}}\n'


def request_with_project(users, workspace, settings, project_rights=RIGHTS):
    """A preserved board with its same-stem project file, accepted intake and request."""
    files = []
    for path, content, rights in (
        ("board.kicad_pcb", BOARD, RIGHTS),
        ("board.kicad_pro", PROJECT, project_rights),
    ):
        op(
            users["editor"],
            "source.register_blob",
            {
                "workspace_id": workspace,
                "sha256": hashlib.sha256(content).hexdigest(),
                "size": len(content),
                "media_type": "application/octet-stream",
            },
            attachments={"content": io.BytesIO(content)},
        )
        files.append(
            {
                "path": path,
                "sha256": hashlib.sha256(content).hexdigest(),
                "media_type": "application/octet-stream",
                "rights": rights,
            }
        )
    source = op(
        users["editor"],
        "source.create_original_bundle",
        {"workspace_id": workspace, "name": "Synthetic board with project", "files": files},
    )
    intake = pcb_fixture.intake.__wrapped__(users, workspace, source)
    recipe = pcb_fixture.recipe.__wrapped__(settings)
    attempt = pcb_fixture.attempt.__wrapped__(users, intake, recipe)
    accepted.__wrapped__(users, intake, attempt)
    item = recipe_for("board.kicad_pcb", RIGHTS)
    settings.SPECMATE_APPROVED_RECIPES = {recipe["id"]: recipe, item["id"]: item}
    requested = op(
        users["owner"],
        "pcb_fabrication.request",
        {"intake_id": intake["intake_id"], "recipe_id": item["id"]},
        idempotency_key="with-project",
    )
    return intake, requested


@pytest.fixture
def project_requested(users, workspace, settings):
    return request_with_project(users, workspace, settings)


def test_project_file_companion_is_accepted_and_must_match_the_report(users, project_requested):
    intake, requested = project_requested
    digest = hashlib.sha256(PROJECT).hexdigest()
    payload = {"intake_id": intake["intake_id"], "build_id": requested["build_id"]}
    register_test_outputs(requested, project={"path": "board.kicad_pro", "sha256": digest})
    result = op(users["viewer"], "pcb_fabrication.read", payload)
    assert result["report"]["project"]["sha256"] == digest


def test_project_bundle_with_mixed_per_file_rights_fabricates_with_derived_output_rights(
    users, workspace, settings
):
    """A board and its project file under different rights are neither refused nor collapsed:
    outputs carry the server-derived most restrictive rights of every staged input."""
    intake, requested = request_with_project(users, workspace, settings, "proprietary")
    build = BuildAttempt.objects.get(id=requested["build_id"])
    assert sorted(e["rights"] for e in build.staged_inputs) == sorted([RIGHTS, "proprietary"])
    derived = derive_for_record(build.staged_inputs)[0]
    assert derived == derive_for_revision(build.source_revision) == "proprietary"
    payload = {"intake_id": intake["intake_id"], "build_id": requested["build_id"]}
    project = {"path": "board.kicad_pro", "sha256": hashlib.sha256(PROJECT).hexdigest()}
    register_test_outputs(requested, project=project, rights=derived)
    result = op(users["viewer"], "pcb_fabrication.read", payload)
    assert result["report"]["project"] == project
    assert {o["rights"] for o in result["outputs"]} == {"proprietary"}


def test_mixed_rights_outputs_claiming_only_the_board_rights_are_rejected(
    users, workspace, settings
):
    intake, requested = request_with_project(users, workspace, settings, "proprietary")
    project = {"path": "board.kicad_pro", "sha256": hashlib.sha256(PROJECT).hexdigest()}
    register_test_outputs(requested, project=project, rights=RIGHTS)
    with pytest.raises(ValidationFailed):
        op(
            users["viewer"],
            "pcb_fabrication.read",
            {"intake_id": intake["intake_id"], "build_id": requested["build_id"]},
        )


@pytest.mark.parametrize("claimed", [None, {"path": "board.kicad_pro", "sha256": "c" * 64}])
def test_report_must_record_the_exact_preserved_project_file(users, project_requested, claimed):
    intake, requested = project_requested
    register_test_outputs(requested, project=claimed)
    with pytest.raises(ValidationFailed):
        op(
            users["viewer"],
            "pcb_fabrication.read",
            {"intake_id": intake["intake_id"], "build_id": requested["build_id"]},
        )


def program_helpers(tmp_path):
    """Execute only the program's helper definitions; no KiCad or container is used."""
    namespace = {}
    exec(script(MAX_OUTPUT_BYTES).split("\ndef main(")[0], namespace)  # noqa: S102 -- exact trusted constant
    return namespace


def test_program_classifies_native_stderr_and_writes_valid_failure_reports(tmp_path):
    helpers = program_helpers(tmp_path)
    classify = helpers["classify"]
    assert classify(-9, "") == "terminated_by_signal"
    assert classify(3, "") == "invalid_input"
    assert classify(1, "terminate called after throwing std::bad_alloc") == "out_of_memory"
    assert classify(1, "Failed to load board") == "board_load"
    assert classify(1, "something new") == "unknown"
    (tmp_path / "partial.gbr").write_text("left behind")
    with pytest.raises(SystemExit) as exited:
        helpers["fail"](
            tmp_path,
            32,
            "export gerbers",
            {"exit_code": 1, "stderr_class": "unknown", "stderr_excerpt": "x" * 5000},
        )
    assert exited.value.code == 32
    assert [p.name for p in tmp_path.iterdir()] == [REPORT_PATH]
    report = FailureReport.model_validate_json((tmp_path / REPORT_PATH).read_bytes())
    assert report.check == "native_gerber_export"
    long_excerpt = helpers["excerpt"]("y" * 5000)
    assert len(long_excerpt) == 2000


def test_diagnostic_table_and_recipe_envelope():
    assert all(0 < code < 126 for code in DIAGNOSTICS)
    assert len({check for check, _ in DIAGNOSTICS.values()}) == len(DIAGNOSTICS)
    assert {name for name, _ in STDERR_CLASSES} < set(
        FailureReport.model_fields["native"]
        .annotation.__args__[0]
        .model_fields["stderr_class"]
        .annotation.__args__
    )
    for copper in (2, 4, 6):
        item = recipe_for("dir/board.kicad_pcb", RIGHTS, copper)
        argv = item["argv"]
        count = int(argv[3])
        assert all(len(a) <= ARG_CHUNK for a in argv)
        assert "".join(argv[4 : 4 + count]) == script(MAX_OUTPUT_BYTES)
        assert argv[4 + count :] == ["/inputs/dir/board.kicad_pcb", "/outputs", str(copper)]
        assert {o["path"] for o in item["outputs"]} == set(output_media(copper))
    assert (
        recipe_for("board.kicad_pcb", RIGHTS, 2)["id"]
        != recipe_for("board.kicad_pcb", RIGHTS, 4)["id"]
    )
    with pytest.raises(ValueError):
        recipe_for("board.kicad_pcb", RIGHTS, 3)
