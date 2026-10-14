"""Mechanical source management over inert synthetic files and exact frozen inputs."""

import copy
import hashlib
from uuid import UUID

import pytest
from django.test import Client

from specmate.design.models import Definition, Draft, Revision
from specmate.mechanical_sources import operations  # noqa: F401 (standalone registration)
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)
from specmate.sources.models import SourceBundleRevision

from .conftest import ensure_member, op, remove_member
from .scope_helpers import workspace_of
from .test_firmware import component
from .test_pcb import (  # noqa: F401
    attempt,
    intake,
    recipe,
    report_payload,
    source,
    successful_output,
)
from .test_sources import register


def digest(data):
    return hashlib.sha256(data).hexdigest()


DATA = b"# inert synthetic CAD recipe\nraise RuntimeError('must never execute')\n"
MODEL = b"ISO-10303-21;\n/* deliberately not a valid solid */\nEND-ISO-10303-21;\n"


@pytest.fixture
def mec_sources(users, workspace):
    files = []
    for path, data in (("case.py", DATA), ("body.step", MODEL), ("unsupported.bin", b"opaque")):
        register(users["editor"], workspace, data)
        files.append(
            {
                "path": path,
                "sha256": digest(data),
                "media_type": "application/octet-stream",
                "rights": "MIT",
            }
        )
    return op(
        users["editor"],
        "source.create_original_bundle",
        {
            "workspace_id": workspace_of(workspace),
            "name": "Synthetic mechanical original",
            "files": files,
        },
    )


@pytest.fixture
def mec_target(users, workspace):
    created = op(
        users["owner"],
        "definition.create",
        {
            "workspace_id": workspace_of(workspace),
            "kind": "hardware",
            "name": "Synthetic mounting hardware",
            "content": {"unknown_dimensions": True},
        },
    )
    return op(
        users["owner"],
        "draft.freeze",
        {"draft_id": created["draft_id"]},
        expected_state=created["state"],
    )


@pytest.fixture
def mec_board(users, workspace, attempt):  # noqa: F811
    # Simulated accepted output checks management; it establishes no native tool compatibility.
    report = report_payload()
    report["outline"] = [[[0, 0], [40, 0], [40, 25], [0, 25]]]
    report["coverage"]["outline"] = "closed-line-polygons"
    report["unsupported"][0] = "arc outlines unsupported"
    cid = str(UUID(int=2))
    report["components"] = [component(cid, "U1", "Synthetic controller", 10)]
    successful_output(attempt, report)
    accepted = op(users["editor"], "pcb.accept_extraction", {"attempt_id": attempt["attempt_id"]})
    created = op(
        users["editor"],
        "pcb.population_create",
        {"interpretation_id": accepted["interpretation_id"], "name": "Synthetic geometry input"},
    )
    return op(
        users["owner"],
        "pcb.population_freeze",
        {"draft_id": created["draft_id"]},
        expected_state=created["state"],
    )


def declaration(preserved, target):
    return {
        "item_role": "enclosure",
        "sources": [
            {
                "local_id": "native",
                "source_revision_id": preserved["revision_id"],
                "source_manifest_sha256": preserved["manifest_sha256"],
                "files": [
                    {
                        "path": "case.py",
                        "sha256": digest(DATA),
                        "rights": "MIT",
                        "role": "recipe",
                        "format": "build123d",
                    },
                    {
                        "path": "body.step",
                        "sha256": digest(MODEL),
                        "rights": "MIT",
                        "role": "model",
                        "format": "step",
                    },
                    {
                        "path": "unsupported.bin",
                        "sha256": digest(b"opaque"),
                        "rights": "MIT",
                        "role": "unsupported",
                        "format": "other",
                    },
                ],
            }
        ],
        "targets": [
            {
                "local_id": "fastener",
                "role": "hardware",
                "revision_id": target["revision_id"],
                "snapshot_sha256": target["sha256"],
                "basis": "Explicit synthetic hardware input",
            }
        ],
        "models": [],
        "limitations": ["Dimensions and native geometry not validated"],
    }


def create(user, workspace, content, **ctx):
    return op(
        user,
        "mechanical_source.create",
        {
            "workspace_id": workspace_of(workspace),
            "name": "Reusable synthetic enclosure",
            "mechanical_source": content,
        },
        **ctx,
    )


def test_exact_persistence_history_unknowns_and_inert_content(
    users, workspace, mec_sources, mec_target
):
    content = declaration(mec_sources, mec_target)
    before = bytes(SourceBundleRevision.objects.get(id=mec_sources["revision_id"]).manifest)
    created = create(users["editor"], workspace, content, idempotency_key="create")
    replay = create(users["editor"], workspace, content, idempotency_key="create")
    assert replay == created
    read = op(users["viewer"], "mechanical_source.read", {"draft_id": created["draft_id"]})
    evaluation = read["evaluation"]
    assert evaluation["native_execution"] == "none"
    assert evaluation["readiness"] == "declared_with_unknowns"
    assert (
        evaluation["clearance"]
        == evaluation["fit"]
        == evaluation["manufacturability"]
        == "not_evaluated"
    )
    assert evaluation["physical_qualification"] is False
    assert evaluation["sources"][0]["role"] == "original"
    assert any(f["code"] == "unsupported_source" for f in evaluation["findings"])
    frozen = op(
        users["owner"],
        "mechanical_source.freeze",
        {"draft_id": created["draft_id"]},
        expected_state=created["state"],
    )
    revision = Revision.objects.get(id=frozen["revision_id"])
    assert set(revision.snapshot.dependencies.values_list("revision_id", flat=True)) == {
        UUID(mec_target["revision_id"])
    }
    changed = copy.deepcopy(content)
    changed["item_role"] = "hardware"
    updated = op(
        users["editor"],
        "mechanical_source.update",
        {"draft_id": created["draft_id"], "mechanical_source": changed},
        expected_state=frozen["draft"]["state"],
    )
    assert updated["state"] != created["state"]
    historical = op(
        users["viewer"], "mechanical_source.read", {"revision_id": frozen["revision_id"]}
    )
    assert historical["content"]["mechanical_source"]["item_role"] == "enclosure"
    assert bytes(SourceBundleRevision.objects.get(id=mec_sources["revision_id"]).manifest) == before


def test_cas_replay_payload_and_atomic_failure(users, workspace, mec_sources, mec_target):
    content = declaration(mec_sources, mec_target)
    created = create(users["editor"], workspace, content, idempotency_key="same")
    changed = copy.deepcopy(content)
    changed["item_role"] = "part"
    with pytest.raises(IdempotencyMismatch):
        create(users["editor"], workspace, changed, idempotency_key="same")
    before = Definition.objects.count()
    changed["sources"][0]["files"][0]["sha256"] = "0" * 64
    with pytest.raises(ValidationFailed):
        create(users["editor"], workspace, changed)
    assert Definition.objects.count() == before
    with pytest.raises(Conflict) as error:
        op(
            users["editor"],
            "mechanical_source.update",
            {"draft_id": created["draft_id"], "mechanical_source": content},
            expected_state="draft-v999",
        )
    assert error.value.details["current"]["state"] == created["state"]
    assert Draft.objects.get(id=created["draft_id"]).version == 1


@pytest.mark.parametrize("field", ["sha256", "rights", "path"])
def test_file_pins_and_model_declarations_require_exact_evidence(
    users, workspace, mec_sources, mec_target, field
):
    content = declaration(mec_sources, mec_target)
    content["sources"][0]["files"][0][field] = {
        "sha256": "0" * 64,
        "rights": "CC0",
        "path": "absent.py",
    }[field]
    with pytest.raises(ValidationFailed):
        create(users["editor"], workspace, content)


def test_exact_model_revision_source_target_pins(users, workspace, mec_sources, mec_target):
    model = op(
        users["editor"],
        "catalog.register_representation",
        {
            "rights_status": "unknown",
            "revision_id": mec_target["revision_id"],
            "kind": "model",
            "label": "Unvalidated synthetic model",
            "source_bundle_revision_id": mec_sources["revision_id"],
            "source_path": "body.step",
        },
    )
    content = declaration(mec_sources, mec_target)
    content["models"] = [
        {
            "local_id": "body",
            "representation_id": model["representation_id"],
            "revision_id": mec_target["revision_id"],
            "snapshot_sha256": mec_target["sha256"],
            "source_local_id": "native",
            "path": "body.step",
            "target_local_id": "fastener",
            "purpose": "clearance",
            "units": None,
            "frame": None,
            "accuracy": None,
            "basis": "Declared correspondence only",
        }
    ]
    created = create(users["editor"], workspace, content)
    read = op(users["viewer"], "mechanical_source.read", {"draft_id": created["draft_id"]})
    assert read["evaluation"]["models"][0]["sha256"] == digest(MODEL)
    assert any(
        f["code"] == "model_metadata" and f["status"] == "unknown"
        for f in read["evaluation"]["findings"]
    )
    content["models"][0]["snapshot_sha256"] = "0" * 64
    with pytest.raises(ValidationFailed):
        create(users["editor"], workspace, content)


def test_permissions_read_only_and_cross_scope_non_disclosure(
    users, workspace, mec_sources, mec_target
):
    content = declaration(mec_sources, mec_target)
    created = create(users["editor"], workspace, content)
    for actor, error in (("viewer", PermissionDenied), ("outsider", NotFound)):
        with pytest.raises(error):
            create(users[actor], workspace, content)
    # Contributors create and edit their own drafts but cannot freeze; editors can.
    own = create(users["contributor"], workspace, content)
    update_args = {"draft_id": own["draft_id"], "mechanical_source": content}
    op(users["contributor"], "mechanical_source.update", update_args, expected_state=own["state"])
    with pytest.raises(PermissionDenied):
        op(
            users["contributor"],
            "mechanical_source.freeze",
            {"draft_id": own["draft_id"]},
            expected_state=own["state"],
        )
    with pytest.raises(PermissionDenied):
        op(
            users["contributor"],
            "mechanical_source.update",
            {"draft_id": created["draft_id"], "mechanical_source": content},
            expected_state=created["state"],
        )
    frozen = op(
        users["editor"],
        "mechanical_source.freeze",
        {"draft_id": created["draft_id"]},
        expected_state=created["state"],
    )
    assert frozen["revision_id"]
    with pytest.raises(NotFound):
        op(users["outsider"], "mechanical_source.read", {"draft_id": created["draft_id"]})
    client = Client()
    client.force_login(users["viewer"])
    response = client.post(
        "/api/v0/operations",
        data={
            "operation": "mechanical_source.read",
            "request_id": "read-mechanical",
            "payload": {"draft_id": created["draft_id"]},
        },
        content_type="application/json",
    )
    assert response.status_code == 200
    assert response.json()["result"]["evaluation"]["native_execution"] == "none"


def test_reused_origin_then_membership_loss_and_foreign_origin_denial(
    users, workspace, other_workspace, mec_sources, mec_target
):
    register(users["editor"], workspace, DATA)
    origin = op(
        users["editor"],
        "source.create_original_bundle",
        {
            "workspace_id": workspace,
            "name": "Retained mechanical origin",
            "files": [
                {
                    "path": "case.py",
                    "sha256": digest(DATA),
                    "media_type": "text/plain",
                    "rights": "MIT",
                }
            ],
        },
    )
    # A second preserved origin in the workspace is pinned explicitly without copying bytes.
    content = declaration(mec_sources, mec_target)
    content["sources"][0].update(
        source_revision_id=origin["revision_id"], source_manifest_sha256=origin["manifest_sha256"]
    )
    content["sources"][0]["files"] = [content["sources"][0]["files"][0]]
    created = create(users["editor"], workspace, content, idempotency_key="retained")
    remove_member(users["editor"])
    with pytest.raises(NotFound):
        op(users["editor"], "mechanical_source.read", {"draft_id": created["draft_id"]})
    with pytest.raises(NotFound):
        create(users["editor"], workspace, content, idempotency_key="retained")
    # Another member still reads the declaration.
    assert op(users["viewer"], "mechanical_source.read", {"draft_id": created["draft_id"]})["name"]
    # A source preserved in a foreign workspace cannot be pinned by a non-member of it.
    register(users["outsider"], other_workspace, DATA)
    foreign = op(
        users["outsider"],
        "source.create_original_bundle",
        {
            "workspace_id": other_workspace,
            "name": "Foreign mechanical origin",
            "files": [
                {
                    "path": "case.py",
                    "sha256": digest(DATA),
                    "media_type": "text/plain",
                    "rights": "MIT",
                }
            ],
        },
    )
    ensure_member(users["editor"], "editor")
    content["sources"][0].update(
        source_revision_id=foreign["revision_id"], source_manifest_sha256=foreign["manifest_sha256"]
    )
    with pytest.raises(NotFound):
        create(users["editor"], workspace, content)


def test_board_input_retains_exact_geometry_revision_and_component_identity(
    users, workspace, mec_sources, mec_board
):
    from specmate.mechanical_sources.api import target_result
    from specmate.queries import get_revision

    frozen = mec_board
    target = target_result(users["editor"], get_revision(users["editor"], frozen["revision_id"]))
    content = declaration(mec_sources, frozen)
    content["targets"] = [
        {
            "local_id": "controller",
            "role": "board",
            "revision_id": target["revision_id"],
            "snapshot_sha256": target["snapshot_sha256"],
            "basis": "Exact synthetic board input",
            "board": {k: v for k, v in target["board"].items() if k != "options"}
            | {"option_id": "default"},
        }
    ]
    created = create(users["editor"], workspace, content)
    read = op(users["viewer"], "mechanical_source.read", {"draft_id": created["draft_id"]})
    geometry = read["evaluation"]["targets"][0]["board_geometry"]
    assert geometry["units"] == "mm"
    assert geometry["outline"] == [[[0, 0], [40, 0], [40, 25], [0, 25]]]
    assert geometry["extractor"] == {"adapter": "kicad-intake-v1", "tool_version": "10.0.6"}
    assert read["evaluation"]["fit"] == "not_evaluated"
    content["targets"][0].update(
        role="component", native_component_id=target["components"][0]["id"]
    )
    selected = create(users["editor"], workspace, content)
    read = op(users["viewer"], "mechanical_source.read", {"draft_id": selected["draft_id"]})
    assert read["evaluation"]["targets"][0]["component"]["reference"] == "U1"
    content["targets"][0]["native_component_id"] = str(UUID(int=1))
    invalid = create(users["editor"], workspace, content)
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "mechanical_source.freeze",
            {"draft_id": invalid["draft_id"]},
            expected_state=invalid["state"],
        )
    assert not Revision.objects.filter(definition_id=invalid["definition_id"]).exists()
    content["targets"][0]["board"]["interpretation_sha256"] = "0" * 64
    with pytest.raises(ValidationFailed):
        create(users["editor"], workspace, content)


def test_read_adapters_authorize_derivative_ancestry_before_disclosure(
    users, workspace, mec_sources, mec_target
):
    from django.test import RequestFactory

    from specmate.mechanical_sources.api import list_records, list_targets, read_draft, read_target

    derivative = op(
        users["editor"],
        "source.derive_bundle",
        {"source_revision_id": mec_sources["revision_id"], "name": "Edited mechanical derivative"},
    )
    content = declaration(derivative, mec_target)
    created = create(users["editor"], workspace, content, idempotency_key="derivative")
    request = RequestFactory().get("/")
    request.user = users["viewer"]
    read = read_draft(request, UUID(created["draft_id"]))
    assert read["evaluation"]["sources"][0]["role"] == "derivative"
    assert read["evaluation"]["sources"][0]["derived_from"] == mec_sources["revision_id"]
    assert mec_sources["revision_id"] in read["evaluation"]["sources"][0]["ancestry"]
    assert (
        list_records(request, UUID(workspace))["records"][0]["definition_id"]
        == created["definition_id"]
    )
    assert list_targets(request, UUID(workspace))["targets"]
    assert (
        read_target(request, UUID(mec_target["revision_id"]))["snapshot_sha256"]
        == mec_target["sha256"]
    )
    # Membership loss changes authority without mutating immutable native bytes.
    remove_member(users["viewer"])
    remove_member(users["editor"])
    for query in (
        lambda: read_draft(request, UUID(created["draft_id"])),
        lambda: list_records(request, UUID(workspace)),
        lambda: create(users["editor"], workspace, content, idempotency_key="derivative"),
    ):
        with pytest.raises(NotFound):
            query()


def test_membership_loss_on_retained_outcome_precedes_key_mismatch(
    users, workspace, mec_sources, mec_target
):

    original = declaration(mec_sources, mec_target)
    created = create(users["editor"], workspace, original, idempotency_key="retained-outcome")
    # Create a separate currently readable source set with the same inert bytes.
    replacement = op(
        users["editor"],
        "source.create_original_bundle",
        {
            "workspace_id": workspace,
            "name": "Replacement source",
            "files": [
                {
                    "path": "case.py",
                    "sha256": digest(DATA),
                    "media_type": "text/plain",
                    "rights": "MIT",
                }
            ],
        },
    )
    changed = copy.deepcopy(original)
    changed["sources"][0].update(
        source_revision_id=replacement["revision_id"],
        source_manifest_sha256=replacement["manifest_sha256"],
    )
    changed["sources"][0]["files"] = [changed["sources"][0]["files"][0]]
    op(
        users["owner"],
        "mechanical_source.update",
        {"draft_id": created["draft_id"], "mechanical_source": changed},
        expected_state=created["state"],
    )
    assert op(users["editor"], "mechanical_source.read", {"draft_id": created["draft_id"]})
    remove_member(users["editor"])
    with pytest.raises(NotFound):
        create(users["editor"], workspace, changed, idempotency_key="retained-outcome")


def test_membership_precedes_mismatch_diagnostics(users, workspace, mec_sources, mec_target):

    content = declaration(mec_sources, mec_target)
    inaccessible = op(
        users["editor"],
        "source.derive_bundle",
        {"source_revision_id": mec_sources["revision_id"], "name": "Second source"},
    )
    content["sources"].append(
        {
            **copy.deepcopy(content["sources"][0]),
            "local_id": "second",
            "source_revision_id": inaccessible["revision_id"],
            "source_manifest_sha256": inaccessible["manifest_sha256"],
        }
    )
    content["sources"][0]["files"][0]["sha256"] = "0" * 64
    with pytest.raises(ValidationFailed):
        create(users["editor"], workspace, content)
    remove_member(users["editor"])
    with pytest.raises(NotFound):
        create(users["editor"], workspace, content)


def test_uninterpreted_board_revision_is_reusable_with_explicit_unknown_geometry(
    users, workspace, mec_sources
):
    board = op(
        users["owner"],
        "definition.create",
        {
            "workspace_id": workspace,
            "kind": "board",
            "name": "Unsupported native board",
            "content": {"geometry": "unknown"},
        },
    )
    frozen_board = op(
        users["owner"],
        "draft.freeze",
        {"draft_id": board["draft_id"]},
        expected_state=board["state"],
    )
    content = declaration(mec_sources, frozen_board)
    content["targets"][0]["role"] = "board"
    created = create(users["editor"], workspace, content)
    frozen = op(
        users["owner"],
        "mechanical_source.freeze",
        {"draft_id": created["draft_id"]},
        expected_state=created["state"],
    )
    read = op(users["viewer"], "mechanical_source.read", {"revision_id": frozen["revision_id"]})
    assert read["evaluation"]["targets"][0]["board_geometry"] is None
    assert any(
        f["code"] == "board_geometry" and f["status"] == "unknown"
        for f in read["evaluation"]["findings"]
    )
    assert read["evaluation"]["clearance"] == "not_evaluated"
