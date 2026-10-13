"""Fabrication authorization and registered evidence contracts, not native proof."""

import copy
import hashlib
import io
import json
from uuid import uuid4

import pytest
from django.test import RequestFactory

from specmate.access.models import Membership
from specmate.builds.models import BuildAttempt, BuildOutbox, BuildStage, StageOutput
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
from specmate.pcb_fabrication.pack import LAYERS, OUTPUT_MEDIA, REPORT_PATH, recipe_for
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
def source(users, project):
    return pcb_fixture.source.__wrapped__(users, project)


@pytest.fixture
def intake(users, project, source):
    return pcb_fixture.intake.__wrapped__(users, project, source)


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


def register_test_outputs(requested, mutate=None, invalid=None, source_revision_id=None):
    stage = BuildStage.objects.get(build_id=requested["build_id"])
    payloads = {p: ("contract-only " + p).encode() for p in OUTPUT_MEDIA if p != REPORT_PATH}
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
        "format_version": 1,
        "adapter": "kicad-fabrication-v1",
        "tool_version": "10.0.6",
        "native_format_version": 20260206,
        "source_sha256": hashlib.sha256(BOARD).hexdigest(),
        "source_unchanged": True,
        "layers": LAYERS,
        "drill_format": "excellon-mm-decimal-absolute-separated-through",
        "drills": {"pth": [], "npth": []},
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
            media_type="text/plain" if invalid == "media" else OUTPUT_MEDIA[path],
            rights="wrong-rights" if invalid == "rights" else RIGHTS,
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
    Membership.objects.filter(user=users["viewer"]).delete()
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
    Membership.objects.filter(user=users["owner"]).delete()
    with pytest.raises(NotFound):
        op(
            users["owner"],
            "pcb_fabrication.request",
            {"intake_id": intake["intake_id"], "recipe_id": "changed-recipe"},
            idempotency_key="fabrication-one",
        )


def derived_record(user, source_id, parent_id):
    """Synthetic retained cross-project ancestry; no source bytes are fabricated."""
    source = SourceBundleRevision.objects.select_related("bundle").get(id=source_id)
    bundle = SourceBundle.objects.create(
        project_id=source.bundle.project_id,
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


def other_source(users):
    project_id = op(users["owner"], "project.create", {"name": "Synthetic source parent"})[
        "project_id"
    ]
    content = b"preserved synthetic parent bytes"
    digest = hashlib.sha256(content).hexdigest()
    op(
        users["owner"],
        "source.register_blob",
        {
            "project_id": project_id,
            "sha256": digest,
            "size": len(content),
            "media_type": "text/plain",
        },
        attachments={"content": io.BytesIO(content)},
    )
    source = op(
        users["owner"],
        "source.create_original_bundle",
        {
            "project_id": project_id,
            "name": "Synthetic parent",
            "files": [
                {
                    "path": "parent.txt",
                    "sha256": digest,
                    "media_type": "text/plain",
                    "rights": RIGHTS,
                }
            ],
        },
    )
    return project_id, source["revision_id"]


def test_hidden_source_parent_blocks_request_and_options_before_missing_report(
    users, source, fabrication_recipe
):
    parent_project, parent_id = other_source(users)
    derived = derived_record(users["owner"], source["revision_id"], parent_id)
    item = PcbIntake.objects.create(
        source_revision=derived, board_path="board.kicad_pcb", created_by=users["owner"]
    )
    Membership.objects.filter(user=users["owner"], project_id=parent_project).delete()
    with pytest.raises(NotFound):
        op(
            users["owner"],
            "pcb_fabrication.request",
            {"intake_id": str(item.id), "recipe_id": fabrication_recipe["id"]},
            idempotency_key="hidden-parent",
        )
    with pytest.raises(NotFound):
        read_options(read_request(users["owner"]), item.id)


def test_hidden_output_parent_precedes_provenance_diagnostics_and_keyed_mismatch(
    users, intake, source, requested
):
    parent_project, parent_id = other_source(users)
    derived = derived_record(users["owner"], source["revision_id"], parent_id)
    stage = register_test_outputs(requested, source_revision_id=derived.id)
    Membership.objects.filter(user=users["owner"], project_id=parent_project).delete()
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
