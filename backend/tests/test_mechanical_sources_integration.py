"""Production generic capture and mounted mechanical adapters cannot bypass source pins."""

import copy

import pytest

from specmate.design.models import Revision
from specmate.operations import ValidationFailed

from .conftest import op
from .test_mechanical_sources import (  # noqa: F401
    declaration,
    mec_sources,
    mec_target,
)
from .test_transports import api


def test_generic_empty_mechanical_draft_remains_editable_but_never_captures(users, workspace):
    draft = op(
        users["owner"],
        "definition.create",
        {
            "workspace_id": workspace,
            "kind": "mechanical_source",
            "name": "Pending native source",
        },
    )
    for command in ("draft.snapshot", "draft.freeze"):
        with pytest.raises(ValidationFailed, match="Typed mechanical source"):
            op(
                users["owner"],
                command,
                {"draft_id": draft["draft_id"]},
                expected_state=draft["state"],
            )
    assert not Revision.objects.filter(definition_id=draft["definition_id"]).exists()


def test_generic_write_and_capture_validate_exact_files_and_union_model_targets(
    users,
    workspace,
    mec_sources,  # noqa: F811
    mec_target,  # noqa: F811
):
    owner = users["owner"]
    model_draft = op(
        owner,
        "definition.create",
        {
            "workspace_id": workspace,
            "kind": "hardware",
            "name": "Declared model owner",
        },
    )
    model_revision = op(
        owner,
        "draft.freeze",
        {"draft_id": model_draft["draft_id"]},
        expected_state=model_draft["state"],
    )
    representation = op(
        owner,
        "catalog.register_representation",
        {
            "rights_status": "unknown",
            "revision_id": model_revision["revision_id"],
            "kind": "model",
            "label": "Unvalidated source model",
            "source_bundle_revision_id": mec_sources["revision_id"],
            "source_path": "body.step",
        },
    )
    content = declaration(mec_sources, mec_target)
    content["models"] = [
        {
            "local_id": "body",
            "representation_id": representation["representation_id"],
            "revision_id": model_revision["revision_id"],
            "snapshot_sha256": model_revision["sha256"],
            "source_local_id": "native",
            "path": "body.step",
            "target_local_id": "fastener",
            "purpose": "clearance",
            "units": None,
            "frame": None,
            "accuracy": None,
            "basis": "Declared correspondence, not verified fit",
        }
    ]
    draft = op(
        owner,
        "definition.create",
        {
            "workspace_id": workspace,
            "kind": "mechanical_source",
            "name": "Generic mechanical source",
            "content": {"mechanical_source": content},
        },
    )
    broken = copy.deepcopy(content)
    broken["sources"][0]["files"][0]["sha256"] = "0" * 64
    with pytest.raises(ValidationFailed):
        op(
            owner,
            "draft.update",
            {"draft_id": draft["draft_id"], "changes": {"mechanical_source": broken}},
            expected_state=draft["state"],
        )
    frozen = op(
        owner, "draft.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"]
    )
    client = api(users["viewer"])
    canonical = client.get(f"/api/v0/revisions/{frozen['revision_id']}/snapshot")
    assert canonical.status_code == 200
    assert {pin["revision_id"] for pin in canonical.json()["dependencies"]} == {
        mec_target["revision_id"],
        model_revision["revision_id"],
    }
    mounted = client.get(f"/api/v0/mechanical-sources/revisions/{frozen['revision_id']}")
    assert mounted.status_code == 200
    assert mounted.json()["evaluation"]["native_execution"] == "none"
    assert mounted.json()["evaluation"]["fit"] == "not_evaluated"
