"""ACC-DOC-001 PCB/mechanical sections: registered outputs must match pinned board sources.

Fabrication outputs are registered contract fixtures (no native tool runs here); a
coherent package is neither manufacturing approval nor physical qualification.
"""

import hashlib

import pytest

from specmate.export_packages import operations  # noqa: F401
from specmate.operations import ValidationFailed
from specmate.pcb_fabrication.pack import output_media

from .conftest import op
from .test_assemblies import create, freeze, occ, part
from .test_export_packages import download, review
from .test_pcb_fabrication import (  # noqa: F401 -- pytest fixtures
    accepted,
    attempt,
    fabrication_recipe,
    intake,
    recipe,
    register_test_outputs,
    requested,
    source,
)
from .test_scene_drawings import drawing


@pytest.fixture
def population(users, accepted):  # noqa: F811
    created = op(
        users["editor"],
        "pcb.population_create",
        {"interpretation_id": accepted["interpretation_id"], "name": "Synthetic board options"},
    )
    return op(
        users["owner"],
        "pcb.population_freeze",
        {"draft_id": created["draft_id"]},
        expected_state=created["state"],
    )


def test_fabrication_outputs_cite_the_pinned_board_and_count_repeated_boards(
    users,
    project,
    intake,  # noqa: F811
    requested,  # noqa: F811
    population,
):
    owner = users["owner"]
    register_test_outputs(requested)
    root = freeze(owner, create(owner, project, [occ("a", population), occ("b", population)]))
    scene = drawing(users["editor"], project, root, key="export-scene")
    payload = {
        "root_revision_id": root["revision_id"],
        "quantity": 5,
        "pcb_fabrication_builds": [
            {"intake_id": intake["intake_id"], "build_id": requested["build_id"]}
        ],
        "scene_drawing_ids": [scene["drawing_id"]],
    }
    listed = op(
        users["viewer"], "export_package.candidates", {"root_revision_id": root["revision_id"]}
    )
    assert listed["pcb_fabrication_builds"] == payload["pcb_fabrication_builds"]
    assert [row["drawing_id"] for row in listed["scene_drawings"]] == [scene["drawing_id"]]
    reviewed = review(users["viewer"], payload)
    manifest = reviewed["manifest"]
    assert manifest["coherence"] == "coherent", manifest["outputs"]
    board, picture = sorted(manifest["outputs"], key=lambda o: o["section"])[::-1]
    assert board["kind"] == "pcb_fabrication_build"
    # Independent oracle: two board occurrences per root times five roots.
    assert board["scope_quantity"] == {"status": "known", "amount": 10, "per_root": 2}
    assert [c["revision_id"] for c in board["cited_revisions"]] == [population["revision_id"]]
    assert board["manufacturing_approval"] is False
    assert board["reproducibility"]["level"] == "provenance"
    assert picture["kind"] == "scene_drawing" and picture["scale"] == "not_established"
    assert picture["cited_revisions"][0]["revision_id"] == root["revision_id"]
    _, files = download(users["viewer"], payload, reviewed)
    outputs = {p for p in files if p.startswith(f"pcb/{requested['build_id']}/")}
    assert outputs == {f"pcb/{requested['build_id']}/{name}" for name in output_media(2)}
    for row in manifest["files"]:
        assert hashlib.sha256(files[row["path"]]).hexdigest() == row["sha256"]
    assert files[f"mechanical/{scene['drawing_id']}/drawing.svg"].startswith(b"<")


def test_build_for_an_unpinned_board_or_foreign_scene_blocks_the_package(
    users,
    project,
    intake,  # noqa: F811
    requested,  # noqa: F811
    population,
):
    owner = users["owner"]
    register_test_outputs(requested)
    _, board = part(owner, project, name="Different board")
    root = freeze(owner, create(owner, project, [occ("a", board)]))
    other = freeze(owner, create(owner, project, [occ("a", population)]))
    scene = drawing(users["editor"], project, other, key="other-scene")
    payload = {
        "root_revision_id": root["revision_id"],
        "quantity": 1,
        "pcb_fabrication_builds": [
            {"intake_id": intake["intake_id"], "build_id": requested["build_id"]}
        ],
        "scene_drawing_ids": [scene["drawing_id"]],
    }
    listed = op(
        users["viewer"], "export_package.candidates", {"root_revision_id": root["revision_id"]}
    )
    # Neither the unpinned board's build nor another root's drawing is offered.
    assert listed["pcb_fabrication_builds"] == [] and listed["scene_drawings"] == []
    reviewed = review(users["viewer"], payload)
    manifest = reviewed["manifest"]
    assert manifest["coherence"] == "incoherent"
    assert {f["reason"] for o in manifest["outputs"] for f in o["findings"]} == {
        "board_source_not_pinned",
        "drawing_scene_not_in_package",
    }
    with pytest.raises(ValidationFailed):
        download(users["viewer"], payload, reviewed)
