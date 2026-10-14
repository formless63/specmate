"""Real PostgreSQL/server SVG oracles; accepted PCB fixtures simulate extraction.

These tests run no native program and establish no physical qualification.
"""

import hashlib
import io
import json
import math
import xml.etree.ElementTree as ET
import zipfile
from uuid import uuid4

import pytest
from django.db import DatabaseError, transaction
from django.test import Client

from specmate.design.models import Snapshot
from specmate.operations import IdempotencyMismatch, NotFound, Unauthenticated, ValidationFailed
from specmate.operations.models import IdempotencyRecord
from specmate.shared_scene import drawing_operations
from specmate.shared_scene.drawing_contracts import DrawingOptions
from specmate.shared_scene.drawing_render import projected, render_drawing
from specmate.shared_scene.models import SceneDrawing

from .conftest import member, op, remove_member
from .scope_helpers import workspace_of
from .test_assemblies import create, freeze, occ, part
from .test_assembly_source_authority import sourced_child  # noqa: F401
from .test_cables import capture, fixture
from .test_cables import create as create_cable
from .test_mechanical_sources import create as create_mechanical
from .test_mechanical_sources import declaration, mec_board, mec_sources, mec_target  # noqa: F401
from .test_pcb import attempt, intake, recipe, source  # noqa: F401
from .test_shared_scene import placement


def drawing(user, project, frozen, *, options=None, key="draw-once"):
    return op(
        user,
        "shared_scene.create_drawing",
        {"snapshot_id": frozen["snapshot_id"], "options": options or {}},
        idempotency_key=key,
    )


def read(user, record):
    return op(user, "shared_scene.read_drawing", {"drawing_id": record["drawing_id"]})


def repeated(user, project, board):
    module = freeze(
        user, create(user, project, [occ("board", board, placement=placement(3, 4, 5))])
    )
    root = create(
        user,
        project,
        [
            occ(
                "left",
                module,
                placement=placement(10, 20, 30, [0, 0, math.sqrt(0.5), math.sqrt(0.5)]),
            ),
            occ("right", module, placement=placement(60, 0)),
            occ("unknown", module),
        ],
    )
    return root, freeze(user, root)


def test_deterministic_geometry_nested_ids_provenance_hashes_replay_and_frozen_history(
    users,
    project,
    mec_board,  # noqa: F811
):
    root, frozen = repeated(users["owner"], project, mec_board)
    before = bytes(Snapshot.objects.get(id=frozen["snapshot_id"]).canonical)
    first = drawing(users["viewer"], project, frozen)
    assert drawing(users["viewer"], project, frozen) == first and SceneDrawing.objects.count() == 1
    inspected = read(users["viewer"], first)
    manifest = inspected["manifest"]
    assert manifest["root"]["revision_id"] == frozen["revision_id"]
    assert manifest["scene_snapshot_sha256"] == frozen["sha256"]
    boards = [row for row in manifest["nodes"] if row["kind"] == "pcb_population"]
    assert boards[0]["features"][0]["address"] != boards[1]["features"][0]["address"]
    assert boards[0]["geometry_ids"] == boards[1]["geometry_ids"]
    assert boards[0]["provenance"][0]["source_rights"]
    left = [
        line
        for line in manifest["projected_segments"]
        if line["address"]["path"] == ["left", "board"]
    ]
    right = [
        line
        for line in manifest["projected_segments"]
        if line["address"]["path"] == ["right", "board"]
    ]
    # Independent quarter turn maps local3,4,5 ->6,23,35, then native X/-Y40x25.
    assert left[0]["start"] == pytest.approx([6, -23])
    assert left[0]["end"] == pytest.approx([6, -63])
    assert right[0]["start"] == [63, -4] and right[0]["end"] == [103, -4]
    assert len(left) == len(right) == 4
    assert not any(
        line["address"]["path"][0] == "unknown" for line in manifest["projected_segments"]
    )
    assert any("placement unknown" in row["reason"] for row in manifest["unresolved"])
    stored = SceneDrawing.objects.get(id=first["drawing_id"])
    assert hashlib.sha256(bytes(stored.svg)).hexdigest() == first["svg_sha256"]
    assert hashlib.sha256(bytes(stored.manifest)).hexdigest() == first["manifest_sha256"]
    assert manifest["outputs"][0]["sha256"] == first["svg_sha256"]
    svg = ET.fromstring(bytes(stored.svg))  # noqa: S314 -- only our generated synthetic SVG.
    assert len(svg.findall(".//{http://www.w3.org/2000/svg}line")) == 8
    displayed = " ".join(svg.itertext())
    assert frozen["revision_id"] in displayed and frozen["sha256"] in displayed
    assert "scene-line-svg-v1" in displayed and "uncapped" in displayed
    second = drawing(users["viewer"], project, frozen, key="distinct-record")
    assert second["drawing_id"] != first["drawing_id"]
    assert (second["svg_sha256"], second["manifest_sha256"]) == (
        first["svg_sha256"],
        first["manifest_sha256"],
    )
    op(
        users["owner"],
        "assembly.update",
        {"draft_id": root["draft_id"], "assembly": {}},
        expected_state=frozen["draft"]["state"],
    )
    assert read(users["viewer"], first) == inspected
    assert bytes(Snapshot.objects.get(id=frozen["snapshot_id"]).canonical) == before
    with pytest.raises(IdempotencyMismatch):
        drawing(users["viewer"], project, frozen, options={"view": "front"})


def test_illustrative_opening_explosion_clipped_segments_and_identical_restore(
    users,
    project,
    mec_board,  # noqa: F811
):
    _, frozen = repeated(users["owner"], project, mec_board)
    original = drawing(users["owner"], project, frozen)
    moved = drawing(
        users["owner"],
        project,
        frozen,
        key="open-explode",
        options={
            "opening": {
                "path": ["left"],
                "axis": "x",
                "angle_deg": 90,
                "pivot_local_mm": [0, 2, 0],
            },
            "explosion": {"enabled": True, "axis": "x", "spacing_mm": 20},
        },
    )
    opened = read(users["owner"], moved)["manifest"]
    # Rx90 about(0,2,0): child(3,4,5)->(3,-3,2), Rz90+parent->(13,23,32).
    # Three root branches put left at rank0 -> display-20X =>(-7,23,32).
    left = next(
        line
        for line in opened["projected_segments"]
        if line["address"]["path"] == ["left", "board"]
    )
    assert left["start"] == pytest.approx([-7, -23])
    assert (
        next(row for row in opened["instances"] if row["address"]["path"] == ["left", "board"])[
            "canonical_world_transform"
        ][2][3]
        == 35
    )
    clipped = drawing(
        users["owner"],
        project,
        frozen,
        key="section",
        options={
            "section": {"enabled": True, "axis": "x", "offset_mm": 80, "keep": "positive"},
        },
    )
    lines = read(users["owner"], clipped)["manifest"]["projected_segments"]
    assert lines and all(line["address"]["path"] == ["right", "board"] for line in lines)
    assert all(line["start"][0] >= 80 and line["end"][0] >= 80 for line in lines)
    restored = drawing(users["owner"], project, frozen, key="restore")
    assert restored["svg_sha256"] == original["svg_sha256"]
    assert restored["manifest_sha256"] == original["manifest_sha256"]
    with pytest.raises(ValidationFailed):
        drawing(
            users["owner"],
            project,
            frozen,
            key="unknown-open",
            options={"opening": {"path": ["unknown"]}},
        )
    assert SceneDrawing.objects.count() == 4


def test_inert_model_and_stock_axis_limits_rights_and_no_native_shape_or_default_length(
    users,
    project,
    mec_sources,  # noqa: F811
    mec_target,  # noqa: F811
):
    owner = users["owner"]
    _, _, _, _, _, cable = fixture(owner, project)
    cable["lengths"] = {
        "finished": {
            "declaration": {
                "amount_mm": "12.5",
                "basis": "human_declaration",
                "explanation": "Synthetic declared length",
            }
        }
    }
    cable_revision = capture(owner, create_cable(owner, project, cable))
    representation = op(
        owner,
        "catalog.register_representation",
        {
            "revision_id": mec_target["revision_id"],
            "kind": "model",
            "label": "Inert model",
            "source_bundle_revision_id": mec_sources["revision_id"],
            "source_path": "body.step",
        },
    )
    content = declaration(mec_sources, mec_target)
    content["models"] = [
        {
            "local_id": "model",
            "representation_id": representation["representation_id"],
            "revision_id": mec_target["revision_id"],
            "snapshot_sha256": mec_target["sha256"],
            "source_local_id": "native",
            "path": "body.step",
            "target_local_id": "fastener",
            "purpose": "clearance",
            "units": "in",
            "frame": "declared_local",
            "accuracy": None,
            "basis": "Explicit unverified synthetic correspondence",
        }
    ]
    mechanical = create_mechanical(owner, project, content)
    mechanical = op(
        owner,
        "mechanical_source.freeze",
        {"draft_id": mechanical["draft_id"]},
        expected_state=mechanical["state"],
    )
    frozen = freeze(
        owner,
        create(
            owner,
            project,
            [
                occ("cable", cable_revision, placement=placement(10, 0)),
                occ("model", mechanical, placement=placement(20, 30)),
            ],
        ),
    )
    value = read(owner, drawing(owner, project, frozen))["manifest"]
    assert value["projected_segments"][0]["start"] == [10, 0]
    assert value["projected_segments"][0]["end"] == [22.5, 0]
    assert len(value["projected_segments"]) == 1
    model = next(
        resource
        for resource in value["geometry_provenance"]
        if resource["type"] == "unavailable_model"
    )
    assert model["source"]["representation_id"] == representation["representation_id"]
    assert model["source"]["rights"] == "MIT" and model["role"] == "clearance"
    assert any("fit not evaluated" in item["reason"] for item in value["unresolved"])
    assert value["qualification"]["physical"] is False
    assert value["scale"]["print"] == "unknown_not_calibrated"


def test_svg_label_escaping_has_no_active_content_or_external_asset_references(users, project):
    _, target = part(
        users["owner"],
        project,
        "part",
        '<script>alert("x")</script><image href="https://invalid.example/model"/>',
    )
    frozen = freeze(users["owner"], create(users["owner"], project, [occ("unavailable", target)]))
    record = SceneDrawing.objects.get(id=drawing(users["owner"], project, frozen)["drawing_id"])
    root = ET.fromstring(bytes(record.svg))  # noqa: S314 -- only our generated synthetic SVG.
    assert {node.tag.rsplit("}", 1)[-1] for node in root.iter()} <= {
        "svg",
        "title",
        "desc",
        "g",
        "line",
        "text",
        "metadata",
    }
    assert all(
        not key.startswith("on") and "href" not in key
        for node in root.iter()
        for key in node.attrib
    )
    assert "<script>" not in bytes(record.svg).decode()


def test_current_source_denial_blocks_existing_read_download_and_changed_key_replay(
    users,
    project,
    sourced_child,  # noqa: F811
):
    module, revoke = sourced_child
    frozen = freeze(users["owner"], create(users["owner"], project, [occ("module", module)]))
    created = drawing(users["viewer"], project, frozen)
    client = Client()
    client.force_login(users["viewer"])
    base = f"/api/v0/shared-scenes/drawings/{created['drawing_id']}"
    svg = client.get(base + "/svg")
    assert svg.status_code == 200
    assert svg["Cache-Control"] == "no-store, private"
    assert hashlib.sha256(svg.content).hexdigest() == svg["X-Content-SHA256"]
    package = client.get(base + "/package")
    assert package.status_code == 200
    assert client.get(base + "/package").content == package.content
    with zipfile.ZipFile(io.BytesIO(package.content)) as archive:
        assert archive.namelist() == ["drawing.svg", "manifest.json"]
        assert archive.read("drawing.svg") == svg.content
        assert (
            json.loads(archive.read("manifest.json"))["outputs"][0]["sha256"]
            == created["svg_sha256"]
        )
    revoke()
    for suffix in ("", "/svg", "/manifest", "/package"):
        denied = client.get(base + suffix)
        assert denied.status_code == 404
        assert denied.json()["error"]["details"] == {}
    for options in ({}, {"view": "front"}):
        with pytest.raises(NotFound):
            drawing(users["viewer"], project, frozen, options=options)
    assert SceneDrawing.objects.count() == 1


def test_scopes_actor_liveness_and_database_immutable_bytes_are_independent(users, project):
    frozen = freeze(users["owner"], create(users["owner"], project))
    created = drawing(users["viewer"], project, frozen)
    with pytest.raises(NotFound):
        read(users["outsider"], created)
    with pytest.raises(NotFound):
        op(users["viewer"], "shared_scene.read_drawing", {"drawing_id": str(uuid4())})
    assert created["workspace_id"] == workspace_of(project)
    record = SceneDrawing.objects.get(id=created["drawing_id"])
    for values in ({"svg": b"changed"}, {"manifest_sha256": "f" * 64}):
        with pytest.raises(DatabaseError), transaction.atomic():
            SceneDrawing.objects.filter(pk=record.pk).update(**values)
    with pytest.raises(DatabaseError), transaction.atomic():
        SceneDrawing.objects.filter(pk=record.pk).delete()
    stale = users["viewer"]
    type(stale).objects.filter(pk=stale.pk).update(is_active=False)
    with pytest.raises(Unauthenticated):
        read(stale, created)
    with pytest.raises(Unauthenticated):
        drawing(stale, project, frozen)


def test_mid_render_revocation_and_generation_failure_roll_back_row_and_receipt(
    users,
    project,
    sourced_child,  # noqa: F811
    monkeypatch,
):
    module, revoke = sourced_child
    frozen = freeze(users["owner"], create(users["owner"], project, [occ("module", module)]))

    def denied(scene, options, version):
        result = render_drawing(scene, options, version)
        revoke()
        return result

    monkeypatch.setattr(drawing_operations, "render_drawing", denied)
    before = IdempotencyRecord.objects.count()
    with pytest.raises(NotFound):
        drawing(users["viewer"], project, frozen)
    assert SceneDrawing.objects.count() == 0 and IdempotencyRecord.objects.count() == before


def test_database_insert_rejects_forged_hash_snapshot_and_manifest(users, project):
    frozen = freeze(users["owner"], create(users["owner"], project))
    created = drawing(users["owner"], project, frozen)
    record = SceneDrawing.objects.get(id=created["drawing_id"])
    base = {
        field.name: getattr(record, field.name)
        for field in record._meta.fields
        if field.name not in {"id", "created_at"}
    }
    forged = json.loads(bytes(record.manifest))
    forged["qualification"]["physical"] = True
    content = json.dumps(forged).encode()
    for changes in (
        {"svg": b"forged"},
        {
            "workspace": record.workspace,
            "snapshot": Snapshot.objects.get(
                id=freeze(users["owner"], create(users["owner"], project))["snapshot_id"]
            ),
        },
        {"manifest": content, "manifest_sha256": hashlib.sha256(content).hexdigest()},
        {"options": {"view": "front"}},
    ):
        with pytest.raises(DatabaseError), transaction.atomic():
            SceneDrawing.objects.create(**(base | changes))
    assert SceneDrawing.objects.count() == 1


def test_huge_finite_transform_and_overflow_reject_before_clipping_without_outputs(
    users,
    project,
    mec_board,  # noqa: F811
):
    _, frozen = repeated(users["owner"], project, mec_board)
    scene = op(users["owner"], "shared_scene.read", {"snapshot_id": frozen["snapshot_id"]})
    scene["nodes"][0]["world_transform"][0][3] = 1e308
    with pytest.raises(ValidationFailed, match="finite illustration coordinates"):
        render_drawing(
            scene,
            DrawingOptions(section={"enabled": True, "axis": "x", "keep": "negative"}),
            "scene-line-svg-v1",
        )
    scene["nodes"][0]["world_transform"][0][3] = float("inf")
    with pytest.raises(ValidationFailed, match="finite illustration coordinates"):
        render_drawing(scene, DrawingOptions(), "scene-line-svg-v1")
    assert SceneDrawing.objects.count() == 0


def test_derivative_origin_and_nested_parent_authority_restore_same_historic_outputs(
    users,
    project,
    mec_sources,  # noqa: F811
    mec_target,  # noqa: F811
):
    owner, viewer = users["owner"], users["viewer"]
    derivative = op(
        owner,
        "source.derive_bundle",
        {"source_revision_id": mec_sources["revision_id"], "name": "Derived inspection source"},
    )
    draft = create_mechanical(owner, project, declaration(derivative, mec_target))
    child = op(
        owner,
        "mechanical_source.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )
    frozen = freeze(owner, create(owner, project, [occ("enclosure", child)]))
    created = drawing(viewer, project, frozen)
    expected = read(viewer, created)
    _, target = part(owner, project)
    module = freeze(owner, create(owner, project, [occ("restricted", target)]))
    nested = freeze(owner, create(owner, project, [occ("module", module)]))
    second = drawing(viewer, project, nested, key="parent")
    exact = read(viewer, second)
    # Sources and nested parents share the workspace boundary: membership loss is the
    # remaining revocation, and restoring it restores the same historic outputs.
    remove_member(viewer)
    for record, root, key in ((created, frozen, "draw-once"), (second, nested, "parent")):
        with pytest.raises(NotFound):
            read(viewer, record)
        with pytest.raises(NotFound):
            drawing(viewer, project, root, options={"view": "front"}, key=key)
    member(viewer, "viewer")
    assert read(viewer, created) == expected
    assert read(viewer, second) == exact


def test_drawing_scene_read_is_workspace_scoped_before_any_labels(users, project):
    owner = users["owner"]
    first = freeze(owner, create(owner, project))
    other = op(owner, "project.create", {"name": "Separate root project"})["project_id"]
    # A root made in another project is the same workspace collection item.
    second = freeze(owner, create(owner, other))
    for frozen in (first, second):
        expected = op(owner, "shared_scene.read", {"snapshot_id": frozen["snapshot_id"]})
        assert (
            op(owner, "shared_scene.read_drawing_scene", {"snapshot_id": frozen["snapshot_id"]})
            == expected
        )
    outsider = users["outsider"]
    remote = op(outsider, "project.create", {"name": "Foreign root project"})["project_id"]
    foreign = freeze(outsider, create(outsider, remote))
    with pytest.raises(NotFound) as error:
        op(owner, "shared_scene.read_drawing_scene", {"snapshot_id": foreign["snapshot_id"]})
    assert error.value.details == {}
    client = Client()
    client.force_login(owner)
    result = client.get(f"/api/v0/shared-scenes/drawing-scenes/{foreign['snapshot_id']}")
    assert result.status_code == 404 and "Foreign root project" not in result.content.decode()


def test_http_generation_and_mcp_read_match_trusted_jobs_with_current_denial(
    users,
    project,
    sourced_child,  # noqa: F811
):
    from specmate.operations import Context, execute

    module, revoke = sourced_child
    frozen = freeze(users["owner"], create(users["owner"], project, [occ("module", module)]))
    client = Client()
    client.force_login(users["viewer"])
    payload = {"snapshot_id": frozen["snapshot_id"]}
    body = {
        "operation": "shared_scene.create_drawing",
        "request_id": "http-drawing",
        "idempotency_key": "shared-channel-intent",
        "payload": payload,
    }
    response = client.post(
        "/api/v0/operations", data=json.dumps(body), content_type="application/json"
    )
    assert response.status_code == 200
    created = response.json()["result"]
    assert drawing(users["viewer"], project, frozen, key="shared-channel-intent") == created
    read_payload = {"drawing_id": created["drawing_id"]}
    mcp = Context(user=users["viewer"], via="mcp", request_id="mcp-drawing")
    assert execute("shared_scene.read_drawing", mcp, read_payload).result == read(
        users["viewer"], created
    )
    revoke()
    with pytest.raises(NotFound):
        execute("shared_scene.read_drawing", mcp, read_payload)
    assert (
        client.post(
            "/api/v0/operations", data=json.dumps(body), content_type="application/json"
        ).status_code
        == 404
    )
    client.logout()
    assert (
        client.get(f"/api/v0/shared-scenes/drawings/{created['drawing_id']}/svg").status_code == 401
    )


def test_manifest_retains_repeated_contextual_firmware_exact_pins(users, project):
    owner = users["owner"]
    _, board = part(owner, project)
    _, first = part(owner, project, "firmware", "First program")
    _, second = part(owner, project, "firmware", "Second program")
    module = freeze(owner, create(owner, project, [occ("board", board)]))
    frozen = freeze(
        owner,
        create(
            owner,
            project,
            [occ("left", module), occ("right", module)],
            assignments=[
                {
                    "path": ["left", "board"],
                    "assignments": {"firmware_revision_id": first["revision_id"]},
                },
                {
                    "path": ["right", "board"],
                    "assignments": {"firmware_revision_id": second["revision_id"]},
                },
            ],
        ),
    )
    manifest = read(users["viewer"], drawing(users["viewer"], project, frozen))["manifest"]
    rows = {tuple(node["address"]["path"]): node for node in manifest["nodes"]}
    assert rows[("left", "board")]["firmware"]["revision_id"] == first["revision_id"]
    assert rows[("right", "board")]["firmware"]["snapshot_sha256"] == second["sha256"]
    assert rows[("left", "board")]["firmware"]["declaration"]["sources"]
    assert rows[("right", "board")]["firmware"]["declaration"]["target"]


def test_orthographic_axes_and_isometric_equal_foreshortening_are_independent():
    assert projected([7, 11, 13], "top") == [7, -11]
    assert projected([7, 11, 13], "front") == [7, -13]
    assert projected([7, 11, 13], "end") == [11, -13]
    for axis in ([1, 0, 0], [0, 1, 0], [0, 0, 1]):
        assert math.hypot(*projected(axis, "isometric")) == pytest.approx(math.sqrt(2 / 3))
    # The chosen viewing direction projects to zero; it is not a physical model frame.
    assert projected([1, -1, 1], "isometric") == [0, 0]


def test_render_budgets_fail_atomically_even_when_every_segment_would_be_clipped(
    users,
    project,
    mec_board,  # noqa: F811
    monkeypatch,
):
    from specmate.shared_scene import drawing_render

    _, frozen = repeated(users["owner"], project, mec_board)
    before = IdempotencyRecord.objects.count()
    monkeypatch.setattr(drawing_render, "MAX_SEGMENTS", 3)
    with pytest.raises(ValidationFailed, match="segment limit"):
        drawing(
            users["viewer"],
            project,
            frozen,
            options={"section": {"enabled": True, "axis": "x", "offset_mm": 1000}},
        )
    monkeypatch.setattr(drawing_render, "MAX_SEGMENTS", 20000)
    monkeypatch.setattr(drawing_render, "MAX_BYTES", 1)
    with pytest.raises(ValidationFailed, match="output byte limit"):
        drawing(users["viewer"], project, frozen)
    assert SceneDrawing.objects.count() == 0 and IdempotencyRecord.objects.count() == before


def test_retained_record_workspace_matches_its_root_and_rejects_foreign_rows(
    users, project, other_workspace
):
    owner = users["owner"]
    frozen = freeze(owner, create(owner, project))
    created = drawing(owner, project, frozen)
    expected = read(owner, created)
    assert expected["workspace_id"] == workspace_of(project)
    record = SceneDrawing.objects.get(id=created["drawing_id"])
    base = {
        field.name: getattr(record, field.name)
        for field in record._meta.fields
        if field.name not in {"id", "created_at"}
    }
    # The database guard keeps a drawing in its root's workspace.
    with pytest.raises(DatabaseError), transaction.atomic():
        SceneDrawing.objects.create(**(base | {"workspace_id": other_workspace}))
    # An administrator of a foreign workspace cannot read it.
    with pytest.raises(NotFound):
        read(users["outsider"], created)
    assert read(owner, created) == expected
