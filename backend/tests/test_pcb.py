"""PCB intake authorization/provenance contracts; native qualification is opt-in."""

import copy
import hashlib
import io
import json
from pathlib import Path
from unittest.mock import patch
from uuid import UUID, uuid4

import pytest
from django.db import DatabaseError, transaction
from django.test import Client

from specmate.access.models import Membership
from specmate.builds.models import BuildAttempt, BuildOutbox, BuildStage, StageOutput
from specmate.operations import (
    Conflict,
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
    assert intake["available_recipe_id"] is None
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
    read = op(users["viewer"], "pcb.get", {"intake_id": intake["intake_id"]})
    assert read["available_recipe_id"] == recipe["id"]
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


def test_failed_native_diagnostic_is_scoped_and_never_an_accepted_interpretation(
    users, intake, attempt
):
    diagnostic = {
        "status": "failed",
        "error": "Unsupported board format; original source retained.",
    }
    content = json.dumps(diagnostic).encode()
    staged = blobstore.stage(io.BytesIO(content), 1024)
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
    stage.state = "failed"
    stage.receipt = {
        "outcome": "failed",
        "exit_code": 1,
        "outputs": [{"path": output.path, "sha256": output.sha256}],
    }
    stage.save()
    read = op(users["viewer"], "pcb.get", {"intake_id": intake["intake_id"]})
    assert read["attempts"][0]["diagnostic"] == diagnostic["error"]
    assert read["interpretations"] == []
    with pytest.raises(ValidationFailed):
        op(users["editor"], "pcb.accept_extraction", {"attempt_id": attempt["attempt_id"]})
    with pytest.raises(NotFound):
        op(users["outsider"], "pcb.get", {"intake_id": intake["intake_id"]})


@pytest.fixture
def interpreted_parts(users, intake, attempt):
    component_ids = [str(uuid4()), str(uuid4())]
    pad_id = str(uuid4())
    report = report_payload()
    report["components"] = [
        {
            "id": component_ids[0],
            "reference": "R1",
            "value": "10k",
            "footprint": "R_0805",
            "position": [5, 5],
            "rotation_deg": 0,
            "side": "front",
            "dnp": True,
            "exclude_from_bom": False,
        },
        {
            "id": component_ids[1],
            "reference": "J1",
            "value": "Conn_01x01",
            "footprint": "PinHeader_1x01",
            "position": [15, 5],
            "rotation_deg": 0,
            "side": "front",
            "dnp": False,
            "exclude_from_bom": False,
        },
    ]
    report["pads"] = [
        {
            "id": pad_id,
            "component_id": component_ids[1],
            "number": "1",
            "terminal": "J1.1",
            "position": [15, 5],
            "size": [1, 1],
            "drill": [0, 0],
            "rotation_deg": 0,
            "type": "smd",
            "shape": "rect",
            "net": "",
            "layers": ["F.Cu"],
        }
    ]
    successful_output(attempt, report)
    interpretation = op(
        users["editor"], "pcb.accept_extraction", {"attempt_id": attempt["attempt_id"]}
    )
    return interpretation, component_ids, pad_id


@pytest.fixture
def population(users, interpreted_parts):
    interpretation, component_ids, pad_id = interpreted_parts
    created = op(
        users["editor"],
        "pcb.population_create",
        {"interpretation_id": interpretation["interpretation_id"], "name": "Board fit options"},
        idempotency_key="create-population",
    )
    return created, interpretation, component_ids, pad_id


def test_population_options_exclude_omitted_part_without_promoting_native_dnp(users, population):
    created, interpretation, component_ids, _ = population
    assert created["content"]["pcb_population"]["interpretation_sha256"] == interpretation["sha256"]
    original = op(
        users["viewer"],
        "pcb.population_read",
        {
            "draft_id": created["draft_id"],
            "option_id": "default",
        },
    )
    assert original["projection"]["unresolved_component_ids"] == component_ids
    assert original["projection"]["components"][0]["native_dnp"] is True
    assert original["projection"]["components"][0]["included"] is None
    assert original["projection"]["qualification"] == "not-assessed"
    content = copy.deepcopy(created["content"]["pcb_population"])
    content["options"][0]["decisions"] = [
        {"component_id": component_ids[0], "status": "omit", "basis": "Assembly option omits R1."},
        {"component_id": component_ids[1], "status": "populate", "basis": "Fit J1."},
    ]
    content["options"].append(
        {
            "local_id": "alternate",
            "name": "Alternative",
            "decisions": [
                {"component_id": component_ids[0]},
                {"component_id": component_ids[1]},
            ],
        }
    )
    updated = op(
        users["editor"],
        "pcb.population_update",
        {
            "draft_id": created["draft_id"],
            "population": content,
        },
        expected_state=created["state"],
        idempotency_key="population-edit",
    )
    projected = op(
        users["viewer"],
        "pcb.population_read",
        {
            "draft_id": created["draft_id"],
            "option_id": "default",
        },
    )["projection"]
    assert projected["included_component_ids"] == [component_ids[1]]
    assert projected["omitted_component_ids"] == [component_ids[0]]
    assert projected["unresolved_component_ids"] == []
    assert projected["components"][0]["native_dnp"] is True
    assert (
        op(
            users["editor"],
            "pcb.population_update",
            {
                "draft_id": created["draft_id"],
                "population": content,
            },
            expected_state=created["state"],
            idempotency_key="population-edit",
        )
        == updated
    )
    with pytest.raises(Conflict):
        op(
            users["editor"],
            "pcb.population_update",
            {
                "draft_id": created["draft_id"],
                "population": content,
            },
            expected_state=created["state"],
        )
    with pytest.raises(PermissionDenied):
        op(
            users["viewer"],
            "pcb.population_update",
            {
                "draft_id": created["draft_id"],
                "population": content,
            },
            expected_state=updated["state"],
        )


def test_population_reviewed_associations_pin_every_target_and_evidence(
    users, project, source, population
):
    from specmate.pcb.population import closure

    created, _, component_ids, pad_id = population
    body = op(
        users["owner"],
        "interface.create",
        {
            "project_id": project,
            "name": "One contact body",
            "interface": {
                "kind": "connector_body",
                "contacts": [
                    {"contact_id": "1"},
                    {"contact_id": "K", "physical_role": "key"},
                ],
            },
        },
    )
    body_revision = op(
        users["owner"],
        "interface.freeze",
        {
            "draft_id": body["draft_id"],
        },
        expected_state=body["state"],
    )["revision_id"]
    pinout = op(
        users["owner"],
        "interface.create",
        {
            "project_id": project,
            "name": "One contact pinout",
            "interface": {
                "kind": "pinout",
                "body_revision_id": body_revision,
                "assignments": [],
            },
        },
    )
    pinout_revision = op(
        users["owner"],
        "interface.freeze",
        {
            "draft_id": pinout["draft_id"],
        },
        expected_state=pinout["state"],
    )["revision_id"]
    part = op(
        users["owner"],
        "definition.create",
        {
            "project_id": project,
            "kind": "part",
            "name": "Synthetic component",
        },
    )
    part_revision = op(
        users["owner"],
        "draft.freeze",
        {
            "draft_id": part["draft_id"],
        },
        expected_state=part["state"],
    )["revision_id"]
    model = op(
        users["editor"],
        "catalog.register_representation",
        {
            "revision_id": part_revision,
            "kind": "model",
            "label": "Candidate STEP",
            "source_bundle_revision_id": source["revision_id"],
            "source_path": "source.py",
        },
    )
    content = copy.deepcopy(created["content"]["pcb_population"])
    content["associations"] = [
        {
            "local_id": "port-j1",
            "kind": "port",
            "component_id": component_ids[1],
            "pad_id": pad_id,
            "target_revision_id": pinout_revision,
            "target_contact_id": "1",
            "review": "accepted",
            "basis": "Reviewed pad/contact numbering.",
            "evidence": {
                "kind": "source_file",
                "source_revision_id": source["revision_id"],
                "path": "board.kicad_pcb",
                "sha256": digest(BOARD),
                "rights": RIGHTS,
            },
        },
        {
            "local_id": "model-r1",
            "kind": "model",
            "component_id": component_ids[0],
            "representation_id": model["representation_id"],
            "review": "candidate",
        },
        {
            "local_id": "part-r1",
            "kind": "library",
            "component_id": component_ids[0],
            "target_revision_id": part_revision,
            "review": "rejected",
            "basis": "Package differs from reviewed part.",
            "evidence": {"kind": "citation", "citation": "Synthetic package review note."},
        },
    ]
    updated = op(
        users["editor"],
        "pcb.population_update",
        {
            "draft_id": created["draft_id"],
            "population": content,
        },
        expected_state=created["state"],
    )
    frozen = op(
        users["owner"],
        "pcb.population_freeze",
        {
            "draft_id": created["draft_id"],
        },
        expected_state=updated["state"],
    )
    assert frozen["revision_id"]
    from specmate.design.models import Draft, SnapshotDependency

    draft = Draft.objects.get(id=created["draft_id"])
    assert set(closure(users["viewer"], draft.definition, draft.content)) == {
        UUID(pinout_revision),
        UUID(part_revision),
    }
    assert set(
        SnapshotDependency.objects.filter(snapshot_id=frozen["snapshot_id"]).values_list(
            "revision_id", flat=True
        )
    ) == {UUID(pinout_revision), UUID(part_revision)}
    client = Client()
    client.force_login(users["viewer"])
    target_response = client.get(f"/api/v0/pcb/projects/{project}/association-targets")
    assert target_response.status_code == 200
    pinout_target = next(
        row for row in target_response.json()["revisions"] if row["revision_id"] == pinout_revision
    )
    assert pinout_target["contacts"] == ["1"]
    wrong = copy.deepcopy(content)
    wrong["associations"][0]["target_contact_id"] = "K"
    with pytest.raises(ValidationFailed):
        op(
            users["editor"],
            "pcb.population_update",
            {
                "draft_id": created["draft_id"],
                "population": wrong,
            },
            expected_state=frozen["draft"]["state"],
        )
    wrong = copy.deepcopy(content)
    wrong["associations"][2]["target_revision_id"] = str(uuid4())
    with pytest.raises(NotFound):
        op(
            users["editor"],
            "pcb.population_update",
            {
                "draft_id": created["draft_id"],
                "population": wrong,
            },
            expected_state=frozen["draft"]["state"],
        )
    wrong = copy.deepcopy(content)
    wrong["associations"][0]["evidence"]["rights"] = "invented-license"
    with pytest.raises(ValidationFailed):
        op(
            users["editor"],
            "pcb.population_update",
            {
                "draft_id": created["draft_id"],
                "population": wrong,
            },
            expected_state=frozen["draft"]["state"],
        )
    wrong["associations"][0]["evidence"]["rights"] = " " + RIGHTS
    with pytest.raises(ValidationFailed):
        op(
            users["editor"],
            "pcb.population_update",
            {"draft_id": created["draft_id"], "population": wrong},
            expected_state=frozen["draft"]["state"],
        )


def test_population_authorizes_later_hidden_targets_before_provenance_or_anchor_errors(
    users, population
):
    created, _, _, _ = population
    hidden_project = op(users["owner"], "project.create", {"name": "Separate project"})[
        "project_id"
    ]
    hidden = op(
        users["owner"],
        "definition.create",
        {
            "project_id": hidden_project,
            "kind": "part",
            "name": "Hidden part",
        },
    )
    hidden_revision = op(
        users["owner"],
        "draft.freeze",
        {
            "draft_id": hidden["draft_id"],
        },
        expected_state=hidden["state"],
    )["revision_id"]
    content = copy.deepcopy(created["content"]["pcb_population"])
    content["interpretation_sha256"] = "0" * 64
    content["associations"] = [
        {
            "local_id": "bad-anchor",
            "kind": "library",
            "component_id": str(uuid4()),
            "target_revision_id": hidden_revision,
            "review": "rejected",
            "basis": "Rejected candidate.",
            "evidence": {"kind": "citation", "citation": "Synthetic review."},
        },
    ]
    with pytest.raises(NotFound):
        op(
            users["editor"],
            "pcb.population_update",
            {
                "draft_id": created["draft_id"],
                "population": content,
            },
            expected_state=created["state"],
        )
    from specmate.design.models import Draft

    Draft.objects.filter(id=created["draft_id"]).update(content={"pcb_population": content})
    with pytest.raises(NotFound):
        op(users["editor"], "pcb.population_read", {"draft_id": created["draft_id"]})
    with pytest.raises(NotFound):
        op(
            users["editor"],
            "pcb.population_create",
            {
                "interpretation_id": created["content"]["pcb_population"]["interpretation_id"],
                "name": "Board fit options",
            },
            idempotency_key="create-population",
        )


def test_population_access_and_api_reads_recheck_scope(users, project, intake, population):
    created, interpretation, _, _ = population
    client = Client()
    client.force_login(users["viewer"])
    assert client.get(f"/api/v0/pcb/intakes/{intake['intake_id']}/populations").status_code == 200
    assert client.get(f"/api/v0/pcb/projects/{project}/association-targets").status_code == 200
    with pytest.raises(NotFound):
        op(users["outsider"], "pcb.population_read", {"draft_id": created["draft_id"]})
    with pytest.raises(NotFound):
        op(
            users["outsider"],
            "pcb.population_create",
            {
                "interpretation_id": interpretation["interpretation_id"],
                "name": "Hidden",
            },
            idempotency_key="outsider",
        )
    Membership.objects.filter(project_id=project, user=users["editor"]).delete()
    with pytest.raises(NotFound):
        op(
            users["editor"],
            "pcb.population_create",
            {
                "interpretation_id": interpretation["interpretation_id"],
                "name": "Board fit options",
            },
            idempotency_key="create-population",
        )
    Membership.objects.filter(project_id=project, user=users["viewer"]).delete()
    assert client.get(f"/api/v0/pcb/intakes/{intake['intake_id']}/populations").status_code == 404
    assert client.get(f"/api/v0/pcb/projects/{project}/association-targets").status_code == 404


def test_generic_design_commands_apply_pcb_population_contract(users, project, population):
    from specmate.design.models import Draft
    from specmate.queries import get_draft, get_revision

    created, _, component_ids, _ = population
    content = copy.deepcopy(created["content"]["pcb_population"])
    content["options"][0]["decisions"][0] = {
        "component_id": component_ids[0],
        "status": "omit",
        "basis": "Do not fit this option.",
    }
    updated = op(
        users["editor"],
        "draft.update",
        {
            "draft_id": created["draft_id"],
            "changes": {"pcb_population": content},
        },
        expected_state=created["state"],
    )
    assert updated["content"]["pcb_population"]["options"][0]["decisions"][0]["status"] == "omit"
    assert get_draft(users["viewer"], created["draft_id"])["state"] == updated["state"]
    snapshot = op(
        users["editor"],
        "draft.snapshot",
        {
            "draft_id": created["draft_id"],
        },
        expected_state=updated["state"],
    )
    assert snapshot["snapshot_id"]
    frozen = op(
        users["owner"],
        "draft.freeze",
        {
            "draft_id": created["draft_id"],
        },
        expected_state=updated["state"],
    )
    assert get_revision(users["viewer"], frozen["revision_id"]).id == UUID(frozen["revision_id"])
    bad = copy.deepcopy(content)
    bad["options"][0]["decisions"] = []
    with pytest.raises(ValidationFailed):
        op(
            users["editor"],
            "draft.update",
            {
                "draft_id": created["draft_id"],
                "changes": {"pcb_population": bad},
            },
            expected_state=frozen["draft"]["state"],
        )
    with pytest.raises(ValidationFailed):
        op(
            users["editor"],
            "definition.create",
            {
                "project_id": project,
                "kind": "part",
                "name": "Wrong typed content",
                "content": {"pcb_population": content},
            },
        )
    Draft.objects.filter(id=created["draft_id"]).update(
        content={
            "pcb_population": {**content, "interpretation_sha256": "0" * 64},
        }
    )
    with pytest.raises(ValidationFailed):
        get_draft(users["viewer"], created["draft_id"])
    assert get_revision(users["viewer"], frozen["revision_id"]).id == UUID(frozen["revision_id"])


def test_population_snapshot_guard_allows_older_revision_in_acyclic_history(users, population):
    created_a, interpretation, component_ids, _ = population
    a1 = op(
        users["owner"],
        "pcb.population_freeze",
        {
            "draft_id": created_a["draft_id"],
        },
        expected_state=created_a["state"],
    )
    created_b = op(
        users["editor"],
        "pcb.population_create",
        {
            "interpretation_id": interpretation["interpretation_id"],
            "name": "Related set",
        },
    )
    b_content = copy.deepcopy(created_b["content"]["pcb_population"])
    b_content["associations"] = [
        {
            "local_id": "prior-a",
            "kind": "library",
            "component_id": component_ids[0],
            "target_revision_id": a1["revision_id"],
            "review": "candidate",
        }
    ]
    b_updated = op(
        users["editor"],
        "pcb.population_update",
        {
            "draft_id": created_b["draft_id"],
            "population": b_content,
        },
        expected_state=created_b["state"],
    )
    b1 = op(
        users["owner"],
        "pcb.population_freeze",
        {
            "draft_id": created_b["draft_id"],
        },
        expected_state=b_updated["state"],
    )
    a_content = copy.deepcopy(a1["draft"]["content"]["pcb_population"])
    a_content["associations"] = [
        {
            "local_id": "related-b",
            "kind": "library",
            "component_id": component_ids[1],
            "target_revision_id": b1["revision_id"],
            "review": "candidate",
        }
    ]
    a_updated = op(
        users["editor"],
        "pcb.population_update",
        {
            "draft_id": created_a["draft_id"],
            "population": a_content,
        },
        expected_state=a1["draft"]["state"],
    )
    a2 = op(
        users["owner"],
        "pcb.population_freeze",
        {
            "draft_id": created_a["draft_id"],
        },
        expected_state=a_updated["state"],
    )
    assert a2["number"] == 2
    assert (
        op(
            users["viewer"],
            "pcb.population_read",
            {
                "draft_id": created_a["draft_id"],
            },
        )["state"]
        == a2["draft"]["state"]
    )
