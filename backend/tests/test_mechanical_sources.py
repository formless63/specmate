"""Mechanical source management over inert synthetic files and exact frozen inputs."""

import copy
import hashlib
from uuid import UUID

import pytest
from django.test import Client

from specmate.access.models import Membership
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

from .conftest import op
from .test_sources import register


def digest(data):
    return hashlib.sha256(data).hexdigest()


DATA = b"# inert synthetic CAD recipe\nraise RuntimeError('must never execute')\n"
MODEL = b"ISO-10303-21;\n/* deliberately not a valid solid */\nEND-ISO-10303-21;\n"


@pytest.fixture
def mec_sources(users, project):
    files = []
    for path, data in (("case.py", DATA), ("body.step", MODEL), ("unsupported.bin", b"opaque")):
        register(users["editor"], project, data)
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
            "project_id": project,
            "name": "Synthetic mechanical original",
            "files": files,
        },
    )


@pytest.fixture
def mec_target(users, project):
    created = op(
        users["owner"],
        "definition.create",
        {
            "project_id": project,
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


def declaration(source, target):
    return {
        "item_role": "enclosure",
        "sources": [
            {
                "local_id": "native",
                "source_revision_id": source["revision_id"],
                "source_manifest_sha256": source["manifest_sha256"],
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


def create(user, project, content, **ctx):
    return op(
        user,
        "mechanical_source.create",
        {
            "project_id": project,
            "name": "Reusable synthetic enclosure",
            "mechanical_source": content,
        },
        **ctx,
    )


def test_exact_persistence_history_unknowns_and_inert_content(
    users, project, mec_sources, mec_target
):
    content = declaration(mec_sources, mec_target)
    before = bytes(SourceBundleRevision.objects.get(id=mec_sources["revision_id"]).manifest)
    created = create(users["editor"], project, content, idempotency_key="create")
    replay = create(users["editor"], project, content, idempotency_key="create")
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


def test_cas_replay_payload_and_atomic_failure(users, project, mec_sources, mec_target):
    content = declaration(mec_sources, mec_target)
    created = create(users["editor"], project, content, idempotency_key="same")
    changed = copy.deepcopy(content)
    changed["item_role"] = "part"
    with pytest.raises(IdempotencyMismatch):
        create(users["editor"], project, changed, idempotency_key="same")
    before = Definition.objects.count()
    changed["sources"][0]["files"][0]["sha256"] = "0" * 64
    with pytest.raises(ValidationFailed):
        create(users["editor"], project, changed)
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
    users, project, mec_sources, mec_target, field
):
    content = declaration(mec_sources, mec_target)
    content["sources"][0]["files"][0][field] = {
        "sha256": "0" * 64,
        "rights": "CC0",
        "path": "absent.py",
    }[field]
    with pytest.raises(ValidationFailed):
        create(users["editor"], project, content)


def test_exact_model_revision_source_target_pins(users, project, mec_sources, mec_target):
    model = op(
        users["editor"],
        "catalog.register_representation",
        {
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
    created = create(users["editor"], project, content)
    read = op(users["viewer"], "mechanical_source.read", {"draft_id": created["draft_id"]})
    assert read["evaluation"]["models"][0]["sha256"] == digest(MODEL)
    assert any(
        f["code"] == "model_metadata" and f["status"] == "unknown"
        for f in read["evaluation"]["findings"]
    )
    content["models"][0]["snapshot_sha256"] = "0" * 64
    with pytest.raises(ValidationFailed):
        create(users["editor"], project, content)


def test_permissions_read_only_and_cross_scope_non_disclosure(
    users, project, mec_sources, mec_target
):
    content = declaration(mec_sources, mec_target)
    created = create(users["editor"], project, content)
    for actor, error in (("viewer", PermissionDenied), ("outsider", NotFound)):
        with pytest.raises(error):
            create(users[actor], project, content)
    with pytest.raises(PermissionDenied):
        op(
            users["editor"],
            "mechanical_source.freeze",
            {"draft_id": created["draft_id"]},
            expected_state=created["state"],
        )
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


def test_cross_project_reuse_then_live_and_retained_ancestor_denial(
    users, project, mec_sources, mec_target
):
    other = op(users["owner"], "project.create", {"name": "Reusable source origin"})["project_id"]
    Membership.objects.create(project_id=other, user=users["editor"], role="editor")
    Membership.objects.create(project_id=other, user=users["viewer"], role="viewer")
    register(users["editor"], other, DATA)
    origin = op(
        users["editor"],
        "source.create_original_bundle",
        {
            "project_id": other,
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
    # An authorized origin can be explicitly pinned across projects without copying bytes.
    content = declaration(mec_sources, mec_target)
    content["sources"][0].update(
        source_revision_id=origin["revision_id"], source_manifest_sha256=origin["manifest_sha256"]
    )
    content["sources"][0]["files"] = [content["sources"][0]["files"][0]]
    created = create(users["editor"], project, content, idempotency_key="retained")
    Membership.objects.filter(project_id=other, user=users["editor"]).delete()
    with pytest.raises(NotFound):
        op(users["editor"], "mechanical_source.read", {"draft_id": created["draft_id"]})
    with pytest.raises(NotFound):
        create(users["editor"], project, content, idempotency_key="retained")
    # Authorized viewer still sees its independent cross-project declaration.
    assert op(users["viewer"], "mechanical_source.read", {"draft_id": created["draft_id"]})["name"]
