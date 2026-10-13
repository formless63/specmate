"""Independent synthetic scene oracles; simulated extraction is not native proof."""

import json
import math
from uuid import UUID

import pytest
from django.test import Client, RequestFactory

from specmate.access.models import Membership
from specmate.design.models import Definition, Snapshot
from specmate.operations import NotFound, ValidationFailed
from specmate.shared_scene import operations  # noqa: F401
from specmate.shared_scene.api import inspect_snapshot
from specmate.shared_scene.transforms import millimetre_factor

from .conftest import op
from .test_assemblies import create, freeze, occ, part
from .test_assembly_source_authority import sourced_child  # noqa: F401
from .test_cables import capture, fixture
from .test_cables import create as create_cable
from .test_mechanical_sources import create as create_mechanical
from .test_mechanical_sources import (  # noqa: F401
    declaration,
    mec_board,
    mec_sources,
    mec_target,
)
from .test_pcb import attempt, intake, recipe, source  # noqa: F401


def placement(x, y, z=0, rotation=None):
    return {"status": "known", "translation": [x, y, z], "rotation_xyzw": rotation or [0, 0, 0, 1]}


def scene(user, frozen):
    return op(user, "shared_scene.read", {"snapshot_id": frozen["snapshot_id"]})


def test_nested_rotation_repeated_selection_geometry_pins_and_frozen_history(
    users,
    project,
    mec_board,  # noqa: F811
):
    user = users["owner"]
    module = freeze(
        user, create(user, project, [occ("board", mec_board, placement=placement(3, 4, 5))])
    )
    quarter_turn = [0, 0, math.sqrt(0.5), math.sqrt(0.5)]
    root = create(
        user,
        project,
        [
            occ("left", module, placement=placement(10, 20, 30, quarter_turn)),
            occ("right", module, placement=placement(-10, 0, 0)),
            occ("unplaced", module),
        ],
    )
    frozen = freeze(user, root)
    before = bytes(Snapshot.objects.get(id=frozen["snapshot_id"]).canonical)
    result = scene(users["viewer"], frozen)
    by_path = {tuple(n["address"]["path"]): n for n in result["nodes"]}
    left, right, unplaced = [by_path[(side, "board")] for side in ("left", "right", "unplaced")]
    # Parent 90-degree Z rotation maps (3,4,5) to (-4,3,5), then translates.
    assert [row[3] for row in left["world_transform"][:3]] == pytest.approx([6, 23, 35])
    assert [row[3] for row in right["world_transform"][:3]] == [-7, 4, 5]
    assert unplaced["local_transform"] is not None and unplaced["world_transform"] is None
    assert left["node_id"] != right["node_id"]
    assert left["features"][0]["address"] != right["features"][0]["address"]
    assert left["geometry_ids"] == right["geometry_ids"] == unplaced["geometry_ids"]
    assert len(result["geometry"]) == 1
    geometry = result["geometry"][0]
    assert geometry["outline"] == [[[0, 0, 0], [40, 0, 0], [40, -25, 0], [0, -25, 0]]]
    assert geometry["source"]["source_revision_id"] == left["provenance"][0]["source_revision_id"]
    assert geometry["quality"] == "native_extracted_planar"
    assert left["features"][0]["world_transform"] is None  # component depth unknown
    assert result["qualification"] == {
        "fit": "not_evaluated",
        "clearance": "not_evaluated",
        "manufacturing": "not_evaluated",
        "physical": False,
    }
    op(
        user,
        "assembly.update",
        {"draft_id": root["draft_id"], "assembly": {}},
        expected_state=frozen["draft"]["state"],
    )
    assert scene(users["viewer"], frozen) == result
    assert bytes(Snapshot.objects.get(id=frozen["snapshot_id"]).canonical) == before


def test_all_disciplines_known_length_unknown_routes_and_inert_models(
    users,
    project,
    mec_sources,  # noqa: F811
    mec_target,  # noqa: F811
):
    user = users["owner"]
    _, _, stock, body, pins, cable = fixture(user, project)
    cable["lengths"] = {
        "finished": {
            "declaration": {
                "amount_mm": "127.5",
                "basis": "human_declaration",
                "explanation": "Synthetic finished length",
            }
        }
    }
    cable_revision = capture(user, create_cable(user, project, cable))
    harness = op(
        user,
        "harness.create",
        {
            "project_id": project,
            "name": "Shared material",
            "harness": {
                "sections": [
                    {
                        "local_id": "shared",
                        "stock_revision_id": stock["revision_id"],
                        "planned_cut_length_mm": "50",
                        "cut_basis": "Synthetic cut",
                    }
                ],
                "segments": [
                    {"local_id": "a", "section_id": "shared"},
                    {"local_id": "b", "section_id": "shared"},
                ],
            },
        },
    )
    harness_revision = op(
        user, "harness.freeze", {"draft_id": harness["draft_id"]}, expected_state=harness["state"]
    )
    model = op(
        user,
        "catalog.register_representation",
        {
            "revision_id": mec_target["revision_id"],
            "kind": "model",
            "label": "Inert model",
            "source_bundle_revision_id": mec_sources["revision_id"],
            "source_path": "body.step",
        },
    )
    mechanical = declaration(mec_sources, mec_target)
    mechanical["models"] = [
        {
            "local_id": "body",
            "representation_id": model["representation_id"],
            "revision_id": mec_target["revision_id"],
            "snapshot_sha256": mec_target["sha256"],
            "source_local_id": "native",
            "path": "body.step",
            "target_local_id": "fastener",
            "purpose": "clearance",
            "units": "in",
            "frame": "declared_local",
            "accuracy": None,
            "basis": "Synthetic unverified correspondence",
        }
    ]
    created = create_mechanical(user, project, mechanical)
    mechanical_revision = op(
        user,
        "mechanical_source.freeze",
        {"draft_id": created["draft_id"]},
        expected_state=created["state"],
    )
    _, unknown = part(user, project, "custom_discipline", "Opaque item")
    frozen = freeze(
        user,
        create(
            user,
            project,
            [
                occ(local, revision)
                for local, revision in [
                    ("cable", cable_revision),
                    ("harness", harness_revision),
                    ("enclosure", mechanical_revision),
                    ("body", body),
                    ("pins", pins),
                    ("hardware", mec_target),
                    ("opaque", unknown),
                ]
            ],
        ),
    )
    result = scene(users["viewer"], frozen)
    assert len(result["nodes"]) == 7
    geometries = {g["type"]: g for g in result["geometry"]}
    cable_geometry = next(g for g in result["geometry"] if g.get("length_mm") is not None)
    assert cable_geometry["length_mm"] == "127.5"
    assert cable_geometry["source"]["revision_id"] == stock["revision_id"]
    assert geometries["unavailable_model"]["millimetre_factor"] == 25.4
    assert geometries["unavailable_model"]["role"] == "clearance"
    assert (
        geometries["unavailable_model"]["source"]["representation_id"] == model["representation_id"]
    )
    assert geometries["unavailable_model"]["source"]["snapshot_sha256"] == mec_target["sha256"]
    harness_node = next(n for n in result["nodes"] if n["kind"] == "harness")
    assert sum(f["role"] == "physical_section" for f in harness_node["features"]) == 1
    assert sum(f["role"] == "segment" for f in harness_node["features"]) == 2
    assert all(f["world_transform"] is None for f in harness_node["features"])
    assert all(n["world_transform"] is None for n in result["nodes"])
    assert millimetre_factor("m") == 1000 and millimetre_factor(None) is None
    assert millimetre_factor("unknown") is None


def test_revoked_nested_parent_no_scene_or_diagnostics(users, project):
    remote = op(users["outsider"], "project.create", {"name": "Other scope"})["project_id"]
    Membership.objects.create(project_id=remote, user=users["owner"], role="viewer")
    _, restricted = part(users["outsider"], remote)
    nested = freeze(
        users["owner"], create(users["owner"], project, [occ("restricted", restricted)])
    )
    frozen = freeze(users["owner"], create(users["owner"], project, [occ("module", nested)]))
    scene(users["owner"], frozen)
    Membership.objects.filter(project_id=remote, user=users["owner"]).delete()
    for user in (users["owner"], users["outsider"]):
        with pytest.raises(NotFound) as error:
            scene(user, frozen)
        assert error.value.details == {} and "restricted" not in error.value.message


def test_repeated_contextual_firmware_keeps_independent_exact_source_target_pins(users, project):
    user = users["owner"]
    _, board = part(user, project)
    _, fw_left = part(user, project, "firmware", "Left program")
    _, fw_right = part(user, project, "firmware", "Right program")
    module = freeze(user, create(user, project, [occ("board", board)]))
    root = freeze(
        user,
        create(
            user,
            project,
            [occ("left", module), occ("right", module)],
            assignments=[
                {
                    "path": ["left", "board"],
                    "assignments": {"firmware_revision_id": fw_left["revision_id"]},
                },
                {
                    "path": ["right", "board"],
                    "assignments": {"firmware_revision_id": fw_right["revision_id"]},
                },
            ],
        ),
    )
    result = scene(users["viewer"], root)
    left, right = [
        next(n for n in result["nodes"] if n["address"]["path"] == [side, "board"])
        for side in ("left", "right")
    ]
    assert left["revision_id"] == right["revision_id"] == board["revision_id"]
    assert left["firmware"]["revision_id"] == fw_left["revision_id"]
    assert right["firmware"]["revision_id"] == fw_right["revision_id"]
    assert left["firmware"]["snapshot_sha256"] == fw_left["sha256"]
    assert right["firmware"]["snapshot_sha256"] == fw_right["sha256"]
    assert left["firmware"]["declaration"]["sources"]
    assert right["firmware"]["declaration"]["target"]


def test_source_origin_ancestor_revocation_denies_exact_frozen_scene(
    users,
    project,
    mec_sources,  # noqa: F811
    mec_target,  # noqa: F811
):
    from specmate.sources.models import SourceBundle, SourceBundleRevision

    user = users["owner"]
    derivative = op(
        user,
        "source.derive_bundle",
        {
            "source_revision_id": mec_sources["revision_id"],
            "name": "Local derivative",
        },
    )
    draft = create_mechanical(user, project, declaration(derivative, mec_target))
    revision = op(
        user,
        "mechanical_source.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )
    frozen = freeze(user, create(user, project, [occ("enclosure", revision)]))
    first = scene(user, frozen)
    hidden = op(users["outsider"], "project.create", {"name": "Retained source owner"})[
        "project_id"
    ]
    # Simulate an operator changing origin authority; immutable source bytes stay intact.
    origin = SourceBundleRevision.objects.get(id=mec_sources["revision_id"]).bundle_id
    SourceBundle.objects.filter(id=origin).update(project_id=hidden)
    with pytest.raises(NotFound):
        scene(user, frozen)
    assert op(user, "shared_scene.list", {"project_id": project})["assemblies"] == []
    SourceBundle.objects.filter(id=origin).update(project_id=project)
    assert scene(user, frozen) == first


def test_read_jobs_and_router_adapter_share_projection_and_never_cache(users, project):
    frozen = freeze(users["owner"], create(users["owner"], project))
    expected = scene(users["viewer"], frozen)
    request = RequestFactory().get("/shared-scenes/snapshots/" + frozen["snapshot_id"])
    request.user = users["viewer"]
    assert inspect_snapshot(request, UUID(frozen["snapshot_id"])) == expected
    client = Client()
    client.force_login(users["viewer"])
    response = client.post(
        "/api/v0/operations",
        data=json.dumps(
            {
                "operation": "shared_scene.read",
                "request_id": "scene-http",
                "payload": {"snapshot_id": frozen["snapshot_id"]},
            }
        ),
        content_type="application/json",
    )
    assert response.status_code == 200 and response.json()["result"] == expected
    client.force_login(users["outsider"])
    denial = client.post(
        "/api/v0/operations",
        data=json.dumps(
            {
                "operation": "shared_scene.read",
                "request_id": "scene-denial",
                "payload": {"snapshot_id": frozen["snapshot_id"]},
            }
        ),
        content_type="application/json",
    )
    assert denial.status_code == 404 and denial.json()["error"]["details"] == {}
    with pytest.raises(ValidationFailed):
        op(
            users["viewer"],
            "shared_scene.read",
            {"snapshot_id": frozen["snapshot_id"]},
            idempotency_key="no-cache",
        )
    captured = op(
        users["owner"],
        "assembly.snapshot",
        {"draft_id": frozen["draft"]["draft_id"]},
        expected_state=frozen["draft"]["state"],
    )
    with pytest.raises(ValidationFailed, match="frozen"):
        op(users["owner"], "shared_scene.read", {"snapshot_id": captured["snapshot_id"]})


def test_generic_unsupported_child_still_authorizes_its_facts_and_sources(
    users,
    project,
    sourced_child,  # noqa: F811
):
    revision, revoke = sourced_child
    frozen = freeze(users["owner"], create(users["owner"], project, [occ("module", revision)]))
    first = scene(users["viewer"], frozen)
    assert any(n["kind"] == "workshop_profile" for n in first["nodes"])
    revoke()
    with pytest.raises(NotFound):
        scene(users["viewer"], frozen)
    assert op(users["viewer"], "shared_scene.list", {"project_id": project})["assemblies"] == []


def test_model_revision_authority_is_independent_from_mechanical_target(
    users,
    project,
    mec_sources,  # noqa: F811
    mec_target,  # noqa: F811
):
    user = users["owner"]
    represented_draft, represented = part(user, project, "part", "Represented model identity")
    model = op(
        user,
        "catalog.register_representation",
        {
            "revision_id": represented["revision_id"],
            "kind": "model",
            "label": "Source model",
            "source_bundle_revision_id": mec_sources["revision_id"],
            "source_path": "body.step",
        },
    )
    declared = declaration(mec_sources, mec_target)
    declared["models"] = [
        {
            "local_id": "model",
            "representation_id": model["representation_id"],
            "revision_id": represented["revision_id"],
            "snapshot_sha256": represented["sha256"],
            "source_local_id": "native",
            "path": "body.step",
            "target_local_id": "fastener",
            "purpose": "manufacturing",
            "units": "m",
            "frame": "declared_local",
            "accuracy": None,
            "basis": "Explicit unverified model-to-target correspondence",
        }
    ]
    draft = create_mechanical(user, project, declared)
    revision = op(
        user,
        "mechanical_source.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )
    frozen = freeze(user, create(user, project, [occ("enclosure", revision)]))
    first = scene(user, frozen)
    model_resource = next(g for g in first["geometry"] if g["type"] == "unavailable_model")
    assert model_resource["role"] == "manufacturing" and model_resource["millimetre_factor"] == 1000
    assert model_resource["source"]["revision_id"] != mec_target["revision_id"]
    hidden = op(users["outsider"], "project.create", {"name": "Model owner"})["project_id"]
    Definition.objects.filter(id=represented_draft["definition_id"]).update(project_id=hidden)
    with pytest.raises(NotFound):
        scene(user, frozen)
    Definition.objects.filter(id=represented_draft["definition_id"]).update(project_id=project)
    assert scene(user, frozen) == first


def test_composed_nonfinite_coordinates_fail_without_returning_invalid_world_geometry(
    users, project
):
    _, child = part(users["owner"], project)
    module = freeze(
        users["owner"],
        create(users["owner"], project, [occ("item", child, placement=placement(1e308, 0))]),
    )
    frozen = freeze(
        users["owner"],
        create(users["owner"], project, [occ("module", module, placement=placement(1e308, 0))]),
    )
    with pytest.raises(ValidationFailed, match="finite coordinate bounds"):
        scene(users["viewer"], frozen)


def test_root_adoption_origin_authority_is_rechecked_before_any_root_label(users, project):
    from specmate.catalog_packs.models import AdoptionEntry
    from specmate.queries import get_draft

    from .test_catalog_packs import adopt, install, manifest, registered

    original = freeze(users["owner"], create(users["owner"], project))
    remote = op(users["outsider"], "project.create", {"name": "Pack source scope"})["project_id"]
    for actor in ("owner", "editor", "viewer"):
        Membership.objects.create(project_id=remote, user=users[actor], role="viewer")
    _, other = part(users["outsider"], remote, "part", "Other pack entry")
    entries = manifest(original)["entries"] + [
        {
            "key": "other",
            "label": "Other source",
            "category": "content",
            "revision_id": other["revision_id"],
            "revision_sha256": other["sha256"],
            "rights": "synthetic-original",
        }
    ]
    version = registered(users, project, original, entries=entries)
    install(users, version)
    adopt(users, version)
    record = AdoptionEntry.objects.get()
    draft = get_draft(users["owner"], record.draft_id)
    frozen = freeze(users["owner"], draft)
    scene(users["viewer"], frozen)
    # The retained pack's entire origin closure is distinct from adopted item dependencies.
    Membership.objects.filter(project_id=remote, user=users["viewer"]).delete()
    with pytest.raises(NotFound):
        scene(users["viewer"], frozen)
    available = op(users["viewer"], "shared_scene.list", {"project_id": project})
    assert all(row["snapshot_id"] != frozen["snapshot_id"] for row in available["assemblies"])
