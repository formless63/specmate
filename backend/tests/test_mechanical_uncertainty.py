"""Original AGPL synthetic geometry; declarations cannot qualify a valid mesh."""

import copy
import hashlib
import math
from collections import Counter

import pytest
from pydantic import ValidationError

from specmate.design.models import Draft, Revision
from specmate.mechanical_sources.contracts import MechanicalSource
from specmate.operations import Conflict, NotFound, ValidationFailed

from .conftest import member, op, remove_member
from .scope_helpers import workspace_of
from .test_mechanical_sources import mec_target  # noqa: F401
from .test_sources import register
from .test_transports import api

# Original dimensioned tetrahedron: volume 2*3*4/6 = 4 mm³, each edge used twice.
VERTICES = [(0, 0, 0), (2, 0, 0), (0, 3, 0), (0, 0, 4)]
FACES = [(0, 2, 1), (0, 1, 3), (0, 3, 2), (1, 2, 3)]


def normal(face):
    a, b, c = (VERTICES[i] for i in face)
    u, v = ([b[i] - a[i] for i in range(3)], [c[i] - a[i] for i in range(3)])
    vector = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    length = math.sqrt(sum(value**2 for value in vector))
    return [value / length for value in vector]


MESH = (
    "solid original\n"
    + "".join(
        "facet normal {} {} {}\nouter loop\n".format(*normal(face))
        + "".join("vertex {} {} {}\n".format(*VERTICES[index]) for index in face)
        + "endloop\nendfacet\n"
        for face in FACES
    )
    + "endsolid original\n"
).encode()


@pytest.fixture
def mesh_declaration(users, workspace, mec_target):  # noqa: F811
    register(users["owner"], workspace, MESH)
    source = op(
        users["owner"],
        "source.create_original_bundle",
        {
            "workspace_id": workspace_of(workspace),
            "name": "Original closed illustration tetrahedron",
            "files": [
                {
                    "path": "tetrahedron.stl",
                    "sha256": hashlib.sha256(MESH).hexdigest(),
                    "media_type": "application/octet-stream",
                    "rights": "AGPL-3.0-only",
                }
            ],
        },
    )
    represented_draft = op(
        users["owner"],
        "definition.create",
        {
            "workspace_id": workspace_of(workspace),
            "kind": "hardware",
            "name": "Original model owner",
        },
    )
    represented = op(
        users["owner"],
        "draft.freeze",
        {"draft_id": represented_draft["draft_id"]},
        expected_state=represented_draft["state"],
    )
    representation = op(
        users["owner"],
        "catalog.register_representation",
        {
            "revision_id": represented["revision_id"],
            "kind": "model",
            "label": "Original illustration",
            "source_bundle_revision_id": source["revision_id"],
            "source_path": "tetrahedron.stl",
        },
    )
    return {
        "item_role": "enclosure",
        "sources": [
            {
                "local_id": "mesh",
                "source_revision_id": source["revision_id"],
                "source_manifest_sha256": source["manifest_sha256"],
                "files": [
                    {
                        "path": "tetrahedron.stl",
                        "sha256": hashlib.sha256(MESH).hexdigest(),
                        "rights": "AGPL-3.0-only",
                        "role": "model",
                        "format": "mesh",
                    }
                ],
            }
        ],
        "targets": [
            {
                "local_id": "connector",
                "role": "hardware",
                "revision_id": mec_target["revision_id"],
                "snapshot_sha256": mec_target["sha256"],
                "basis": "Explicit target scope, no connector identity inferred",
            }
        ],
        "models": [
            {
                "local_id": "body",
                "representation_id": representation["representation_id"],
                "revision_id": represented["revision_id"],
                "snapshot_sha256": represented["sha256"],
                "source_local_id": "mesh",
                "path": "tetrahedron.stl",
                "target_local_id": "connector",
                "purpose": "illustration",
                "units": "mm",
                "frame": "original_local",
                "accuracy": "Exact original illustrative vertex coordinates",
                "basis": "Synthetic illustration only",
            }
        ],
    }


def assumptions():
    return {
        "materials": [
            {
                "local_id": "plastic",
                "status": "declared",
                "specification": "Synthetic polymer",
                "behavior": "Shrinkage unknown outside this declared experiment",
                "basis": "Original hypothetical assumption",
            }
        ],
        "processes": [
            {
                "local_id": "forming",
                "status": "declared",
                "method": "Synthetic forming",
                "parameters": ["No real machine/process claim"],
                "behavior": "Declared deformation allowance only",
                "basis": "Original hypothetical assumption",
            }
        ],
        "tolerances": [
            {
                "local_id": "width",
                "target_local_id": "connector",
                "model_local_id": "body",
                "status": "declared",
                "dimension": "body width",
                "lower_deviation": 0,
                "upper_deviation": 0,
                "basis": "Explicit synthetic zero deviation, not measured production capability",
            }
        ],
        "connector_envelopes": [
            {
                "local_id": "mated",
                "target_local_id": "connector",
                "usage": "mated",
                "status": "declared",
                "minimum": [0, 0, 0],
                "maximum": [2, 3, 4],
                "frame": "original_local",
                "basis": "Hypothetical mated envelope; other use configurations unassessed",
            }
        ],
    }


def create(user, workspace, content):
    return op(
        user,
        "mechanical_source.create",
        {
            "workspace_id": workspace_of(workspace),
            "name": "Declared uncertainty",
            "mechanical_source": content,
        },
    )


def test_closed_mesh_cannot_supply_missing_tolerance_connector_or_manufacturing_inputs(
    users, workspace, mesh_declaration
):
    edges = Counter(tuple(sorted((face[i], face[(i + 1) % 3]))) for face in FACES for i in range(3))
    assert len(edges) == 6 and set(edges.values()) == {2}
    assert VERTICES[1][0] * VERTICES[2][1] * VERTICES[3][2] / 6 == 4
    draft = create(users["owner"], workspace, mesh_declaration)
    # Mounted HTTP view uses current shared operation/closure, not a direct assessor call.
    response = api(users["viewer"]).get(f"/api/v0/mechanical-sources/drafts/{draft['draft_id']}")
    assert response.status_code == 200
    assessment = response.json()["evaluation"]["uncertainty_assessment"]
    assert {row["code"] for row in assessment["missing_prerequisites"]} >= {
        "material",
        "process",
        "tolerance",
        "connector_scope",
        "model_tolerance",
    }
    transfer = next(p for p in assessment["prerequisites"] if p["code"] == "purpose_transfer_limit")
    assert (
        transfer["status"] == "not_evaluated"
        and "no clearance or manufacturing" in transfer["message"]
    )
    assert assessment["geometry"][0]["source_sha256"] == hashlib.sha256(MESH).hexdigest()
    assert (
        assessment["fit"]
        == assessment["clearance"]
        == assessment["manufacturability"]
        == "not_evaluated"
    )
    assert assessment["physical_qualification"] is False
    for command in ("mechanical_source.freeze", "draft.freeze"):
        frozen = op(
            users["owner"],
            command,
            {"draft_id": draft["draft_id"]},
            expected_state=Draft.objects.get(id=draft["draft_id"]).state_token,
        )
        assert Revision.objects.filter(id=frozen["revision_id"]).exists()


def test_scoped_declarations_immutable_history_cas_and_purpose_limits(
    users, workspace, mesh_declaration
):
    content = copy.deepcopy(mesh_declaration)
    content["uncertainty"] = assumptions()
    content["models"][0]["purpose"] = "manufacturing"
    draft = create(users["owner"], workspace, content)
    first = op(
        users["owner"],
        "draft.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )
    draft["state"] = first["draft"]["state"]
    canonical = bytes(Revision.objects.get(id=first["revision_id"]).snapshot.canonical)
    before = op(users["viewer"], "mechanical_source.read", {"revision_id": first["revision_id"]})
    assessment = before["evaluation"]["uncertainty_assessment"]
    assert [r["code"] for r in assessment["missing_prerequisites"]] == ["manufacturing_format"]
    assert assessment["fit"] == "not_evaluated" and not assessment["physical_qualification"]
    assert (
        before["content"]["mechanical_source"]["uncertainty"]["tolerances"][0]["lower_deviation"]
        == 0
    )
    content["uncertainty"]["tolerances"][0]["lower_deviation"] = -0.25
    updated = op(
        users["owner"],
        "mechanical_source.update",
        {"draft_id": draft["draft_id"], "mechanical_source": content},
        expected_state=draft["state"],
        idempotency_key="uncertainty-change",
    )
    assert (
        op(
            users["owner"],
            "mechanical_source.update",
            {"draft_id": draft["draft_id"], "mechanical_source": content},
            expected_state=draft["state"],
            idempotency_key="uncertainty-change",
        )
        == updated
    )
    with pytest.raises(Conflict):
        op(
            users["owner"],
            "mechanical_source.update",
            {"draft_id": draft["draft_id"], "mechanical_source": content},
            expected_state=draft["state"],
        )
    assert bytes(Revision.objects.get(id=first["revision_id"]).snapshot.canonical) == canonical
    assert (
        op(users["viewer"], "mechanical_source.read", {"revision_id": first["revision_id"]})
        == before
    )
    with pytest.raises(NotFound):
        op(users["outsider"], "mechanical_source.read", {"draft_id": draft["draft_id"]})


@pytest.mark.parametrize(
    "change",
    [
        lambda a: a["tolerances"][0].update(lower_deviation=1, upper_deviation=-1),
        lambda a: a["tolerances"][0].update(lower_deviation=float("nan")),
        lambda a: a["connector_envelopes"][0].update(maximum=[float("inf"), 0, 0]),
        lambda a: a["connector_envelopes"][0].update(minimum=[3, 0, 0]),
        lambda a: a["connector_envelopes"][0].update(target_local_id="absent"),
        lambda a: a["tolerances"][0].update(model_local_id="absent"),
        lambda a: a["materials"][0].update(basis=None),
        lambda a: a["connector_envelopes"][0].update(status="unknown"),
    ],
)
def test_invalid_bounds_and_scope_rejected_by_typed_contract(mesh_declaration, change):
    content = copy.deepcopy(mesh_declaration)
    content["uncertainty"] = assumptions()
    change(content["uncertainty"])
    with pytest.raises(ValidationError):
        MechanicalSource.model_validate(content)


def test_invalid_generic_content_rolls_back_and_unknown_has_no_numeric_defaults(
    users, workspace, mesh_declaration
):
    content = copy.deepcopy(mesh_declaration)
    content["uncertainty"] = {
        "tolerances": [{"local_id": "unknown", "dimension": "unassessed opening"}],
        "connector_envelopes": [
            {
                "local_id": "not-needed",
                "target_local_id": "connector",
                "usage": "body",
                "status": "not_applicable",
                "basis": "Explicitly no body-envelope use in this hypothetical scope",
            }
        ],
    }
    draft = create(users["owner"], workspace, content)
    row = draft["content"]["mechanical_source"]["uncertainty"]["tolerances"][0]
    assert row["lower_deviation"] is row["upper_deviation"] is None
    broken = copy.deepcopy(content)
    broken["uncertainty"]["connector_envelopes"][0]["target_local_id"] = "absent"
    for operation in ("mechanical_source.update", "draft.update"):
        payload = {
            "draft_id": draft["draft_id"],
            **(
                {"mechanical_source": broken}
                if operation.startswith("mechanical")
                else {"changes": {"mechanical_source": broken}}
            ),
        }
        with pytest.raises(ValidationFailed):
            op(users["owner"], operation, payload, expected_state=draft["state"])
    assert Draft.objects.get(id=draft["draft_id"]).state_token == draft["state"]


def test_precise_model_metadata_and_membership_authority(users, workspace, mesh_declaration):
    content = copy.deepcopy(mesh_declaration)
    content["uncertainty"] = assumptions()
    content["models"][0].update(units=None, frame=None, accuracy=None)
    draft = create(users["owner"], workspace, content)
    before = op(users["viewer"], "mechanical_source.read", {"draft_id": draft["draft_id"]})
    assessment = before["evaluation"]["uncertainty_assessment"]
    metadata = [
        p
        for p in assessment["missing_prerequisites"]
        if p["code"] in {"model_units", "model_frame", "model_accuracy"}
    ]
    assert len(metadata) == 3 and all(
        p["scope"] == {"target_local_id": "connector", "model_local_id": "body"} for p in metadata
    )
    remove_member(users["viewer"])
    client = api(users["viewer"])
    assert client.get(f"/api/v0/workspaces/{workspace}/definitions").status_code == 404
    denied = client.get(f"/api/v0/mechanical-sources/drafts/{draft['draft_id']}")
    assert denied.status_code == 404
    assert (
        b"Original hypothetical" not in denied.content and b"tetrahedron.stl" not in denied.content
    )
    with pytest.raises(NotFound):
        op(users["viewer"], "mechanical_source.read", {"draft_id": draft["draft_id"]})
    member(users["viewer"], "viewer")
    assert op(users["viewer"], "mechanical_source.read", {"draft_id": draft["draft_id"]}) == before


def test_mixed_clearance_and_illustration_purposes_need_no_manufacturing_geometry(
    users, workspace, mesh_declaration
):
    content = copy.deepcopy(mesh_declaration)
    content["uncertainty"] = assumptions()
    content["models"][0]["purpose"] = "clearance"
    preview = {**content["models"][0], "local_id": "preview", "purpose": "illustration"}
    content["models"].append(preview)
    content["uncertainty"]["tolerances"].append(
        {
            **content["uncertainty"]["tolerances"][0],
            "local_id": "preview-width",
            "model_local_id": "preview",
        }
    )
    draft = create(users["owner"], workspace, content)
    assessment = op(users["viewer"], "mechanical_source.read", {"draft_id": draft["draft_id"]})[
        "evaluation"
    ]["uncertainty_assessment"]
    assert (
        assessment["readiness"] == "declared_inputs_only"
        and assessment["missing_prerequisites"] == []
    )
    transfers = [p for p in assessment["prerequisites"] if p["code"] == "purpose_transfer_limit"]
    assert len(transfers) == 2 and all(p["status"] == "not_evaluated" for p in transfers)
    assert {g["purpose"] for g in assessment["geometry"]} == {"clearance", "illustration"}
    assert (
        assessment["fit"]
        == assessment["clearance"]
        == assessment["manufacturability"]
        == "not_evaluated"
    )
    assert assessment["physical_qualification"] is False
