"""Independent arithmetic oracles for the planar proposal generators (no database)."""

from uuid import UUID

import pytest

from specmate.mechanical_proposals.contracts import Parameters
from specmate.mechanical_proposals.generators import UnknownReference, generate
from specmate.pcb.report import Report

HOLES = {
    "a": (UUID(int=0xA1), (13.0, 13.0)),
    "b": (UUID(int=0xB1), (57.0, 13.0)),
    "c": (UUID(int=0xC1), (57.0, 37.0)),
    "d": (UUID(int=0xD1), (13.0, 37.0)),
}
J1 = UUID(int=0x11)
U1 = UUID(int=0x12)


def board_report(outline=True, cutouts=()):
    components, pads, holes = [], [], []
    for name, (pad_id, pos) in HOLES.items():
        component = UUID(int=pad_id.int + 0x1000)
        components.append(
            {
                "id": str(component),
                "reference": f"H{name}",
                "value": "Hole",
                "footprint": "Mount",
                "position": list(pos),
                "rotation_deg": 0,
                "side": "front",
                "dnp": False,
                "exclude_from_bom": True,
            }
        )
        pads.append(
            {
                "id": str(pad_id),
                "component_id": str(component),
                "number": "1",
                "terminal": f"H{name}.1",
                "position": list(pos),
                "size": [3.2, 3.2],
                "drill": [3.2, 3.2],
                "rotation_deg": 0,
                "type": "npth",
                "shape": "circle",
                "net": "",
                "layers": [],
            }
        )
        holes.append(
            {
                "pad_id": str(pad_id),
                "position": list(pos),
                "drill": [3.2, 3.2],
                "mounting_status": "candidate-not-reviewed",
            }
        )
    for ident, ref, pos, side in (
        (J1, "J1", (59.0, 25.0), "front"),
        (U1, "U1", (30.0, 25.0), "back"),
    ):
        components.append(
            {
                "id": str(ident),
                "reference": ref,
                "value": "Synthetic",
                "footprint": "Synthetic",
                "position": list(pos),
                "rotation_deg": 0,
                "side": side,
                "dnp": False,
                "exclude_from_bom": False,
            }
        )
    return Report.model_validate(
        {
            "format_version": 1,
            "adapter": "kicad-intake-v1",
            "tool_version": "10.0.6",
            "native_format_version": 20260206,
            "source_sha256": "0" * 64,
            "units": "mm",
            "coordinate_frame": "KiCad absolute: x right, y down; angles native degrees",
            "components": components,
            "pads": pads,
            "copper_nets": {},
            "outline": [[[10, 10], [60, 10], [60, 40], [10, 40]]] if outline else [],
            "cutouts": list(cutouts),
            "mounting_holes": holes,
            "component_passages": [],
            "coverage": {
                "components": "identity-reference-value-footprint-and-flags",
                "pads": "identity-and-basic-geometry",
                "nets": "pad-membership-not-connectivity-proof",
                "outline": "closed-line-polygons" if outline else "unsupported",
                "holes": "nonplated-pad-drills-not-reviewed-mounts",
                "placements": "native-absolute",
            },
            "unsupported": ["a", "b", "c", "d"],
            "physical_qualification": False,
        }
    )


FULL = {
    "shell": {
        "board_clearance_mm": 0.5,
        "wall_mm": 2,
        "corner_radius_mm": 3,
        "interior_height_mm": 20,
        "board_thickness_mm": 1.6,
    },
    "boss": {
        "outer_diameter_mm": 6,
        "pilot_diameter_mm": 2.5,
        "height_mm": 4,
        "lid_clearance_diameter_mm": 3.4,
    },
    "mounts": [{"pad_id": str(pad), "use": True} for pad, _ in HOLES.values()],
    "connectors": [
        {
            "component_id": str(J1),
            "side": "east",
            "lateral_offset_mm": 0,
            "width_mm": 9,
            "height_mm": 4,
            "center_above_board_mm": 3,
            "clearance_mm": 0.25,
        }
    ],
    "vents": [
        {
            "local_id": "lid-vent",
            "face": "lid",
            "slot_width_mm": 1.5,
            "slot_length_mm": 10,
            "pitch_x_mm": 14,
            "pitch_y_mm": 4,
            "edge_margin_mm": 5,
            "keepout_margin_mm": 2,
        }
    ],
    "cable_guides": [
        {
            "local_id": "guide-1",
            "side": "north",
            "offset_along_wall_mm": 20,
            "cable_diameter_mm": 3,
            "clearance_mm": 1,
            "post_width_mm": 2,
            "post_depth_mm": 3,
        }
    ],
}


def run(declared=FULL, **report_kwargs):
    return generate(board_report(**report_kwargs), Parameters.model_validate(declared))


def feature(doc, feature_id):
    return next(f for f in doc["features"] if f["feature_id"] == feature_id)


def test_complete_declarations_match_independent_arithmetic():
    doc = run()
    assert doc["status"] == "declared_inputs_complete" and doc["unresolved"] == []
    shell = feature(doc, "enclosure_outline")["geometry"]
    assert shell["cavity"] == {"x0": 9.5, "y0": 9.5, "x1": 60.5, "y1": 40.5}
    assert shell["outer"] == {"x0": 7.5, "y0": 7.5, "x1": 62.5, "y1": 42.5}
    boss = feature(doc, f"boss:{HOLES['b'][0]}")
    assert boss["geometry"]["center"] == [57.0, 13.0]
    assert {c["code"]: c["status"] for c in boss["checks"]} == {
        "center_inside_outline": "pass",
        "pilot_smaller_than_boss": "pass",
        "boss_within_cavity": "pass",
    }
    opening = feature(doc, f"connector_opening:{J1}")["geometry"]
    assert opening["lateral_center_mm"] == 25.0
    assert (opening["width_mm"], opening["height_mm"]) == (9.5, 4.5)
    assert opening["center_z_above_floor_mm"] == 8.6
    assert opening["origin_to_wall_mm"] == 1.5
    vent = feature(doc, "vent:lid-vent")["geometry"]
    assert vent["region"] == {"x0": 14.5, "y0": 14.5, "x1": 55.5, "y1": 35.5}
    # 3 columns x 5 rows; each corner slot is within 3 + 2 mm of a corner boss.
    assert len(vent["slots"]) == 11 and vent["removed_for_bosses"] == 4
    assert vent["geometric_open_area_mm2"] == 165.0
    for removed in ([21.0, 17.0], [49.0, 17.0], [49.0, 33.0], [21.0, 33.0]):
        assert removed not in vent["slots"]
    guide = feature(doc, "cable_guide:guide-1")["geometry"]
    assert guide["slot_width_mm"] == 4.0 and guide["slot_center_mm"] == 29.5
    assert guide["posts"] == [
        {"x0": 25.5, "y0": 9.5, "x1": 27.5, "y1": 12.5},
        {"x0": 31.5, "y0": 9.5, "x1": 33.5, "y1": 12.5},
    ]
    assert doc["qualification"] == {
        "physical": False,
        "fit": "not_evaluated",
        "clearance": "not_evaluated",
        "printability": "not_evaluated",
        "manufacturing": "not_evaluated",
    }
    assert doc["remaining_physical_checks"]
    assert doc["checks_summary"]["fail"] == 0


def test_empty_declarations_stay_explicitly_incomplete_and_never_default():
    doc = run({})
    assert doc["status"] == "incomplete"
    shell = feature(doc, "enclosure_outline")
    assert shell["geometry"]["cavity"] is None and shell["geometry"]["outer"] is None
    assert {
        "shell.board_clearance_mm",
        "shell.wall_mm",
        "shell.interior_height_mm",
    } <= set(shell["unresolved"])
    # Candidate holes are not mounts until explicitly chosen.
    assert {f["kind"] for f in doc["features"] if f["feature_id"].startswith("boss:")} == {
        "mount_candidate"
    }
    assert {u["code"] for u in doc["unresolved"]} >= {"unknown_input", "unreviewed_mount_candidate"}


def test_unknown_connector_envelope_and_tolerance_keep_opening_incomplete():
    declared = {
        **FULL,
        "connectors": [
            {"component_id": str(J1), "side": "east", "lateral_offset_mm": 0, "width_mm": 9}
        ],
    }
    doc = run(declared)
    opening = feature(doc, f"connector_opening:{J1}")
    assert opening["status"] == "incomplete"
    assert {"connector.height_mm", "connector.clearance_mm"} <= set(opening["unresolved"])
    assert opening["geometry"]["width_mm"] is None  # width without clearance is not resized
    assert opening["geometry"]["center_z_above_floor_mm"] is None
    assert doc["status"] == "incomplete"


def test_zero_is_a_declaration_and_none_is_unknown():
    zero = {**FULL, "shell": {**FULL["shell"], "board_clearance_mm": 0}}
    cavity = feature(run(zero), "enclosure_outline")["geometry"]["cavity"]
    assert cavity == {"x0": 10.0, "y0": 10.0, "x1": 60.0, "y1": 40.0}
    unknown = {**FULL, "shell": {**FULL["shell"], "board_clearance_mm": None}}
    assert feature(run(unknown), "enclosure_outline")["geometry"]["cavity"] is None


def test_back_side_component_has_no_invented_vertical_reference():
    declared = {
        **FULL,
        "connectors": [
            {
                "component_id": str(U1),
                "side": "north",
                "lateral_offset_mm": 0,
                "width_mm": 5,
                "height_mm": 3,
                "center_above_board_mm": 1,
                "clearance_mm": 0.2,
            }
        ],
    }
    opening = feature(run(declared), f"connector_opening:{U1}")
    assert opening["geometry"]["center_z_above_floor_mm"] is None
    assert "connector.center_above_board_mm" in opening["unresolved"]


def test_missing_outline_leaves_the_enclosure_unresolved():
    doc = run(outline=False)
    assert doc["status"] == "incomplete"
    shell = feature(doc, "enclosure_outline")
    assert shell["geometry"]["cavity"] is None
    assert any(u["code"] == "board_outline_unavailable" for u in doc["unresolved"])


def test_conflicting_geometry_is_reported_as_failed_checks_not_hidden():
    crowded = {
        **FULL,
        "boss": {**FULL["boss"], "outer_diameter_mm": 50},
        "connectors": [
            {
                "component_id": str(J1),
                "side": "east",
                "lateral_offset_mm": 10,
                "width_mm": 20,
                "height_mm": 4,
                "center_above_board_mm": 3,
                "clearance_mm": 0,
            }
        ],
    }
    doc = run(crowded)
    assert doc["checks_summary"]["fail"] > 0
    assert any(c["status"] == "fail" for f in doc["features"] for c in f["checks"])
    overlap = feature(doc, f"connector_opening:{J1}")
    assert {c["code"]: c["status"] for c in overlap["checks"]}["opening_within_wall_span"] == "fail"
    assert doc["status"] == "declared_inputs_complete"  # completeness is not correctness


def test_cutout_clearance_uses_boundary_distance():
    cutout = [[[14, 11], [18, 11], [18, 15], [14, 15]]]
    doc = run(cutouts=cutout)
    boss = feature(doc, f"boss:{HOLES['a'][0]}")
    clear = next(c for c in boss["checks"] if c["code"] == "boss_clear_of_cutout")
    # Hole a at (13, 13): nearest cutout edge x=14 is 1 mm away; the boss radius is 3 mm.
    assert clear["status"] == "fail" and "1.0 mm" in clear["detail"]
    other = feature(doc, f"boss:{HOLES['c'][0]}")
    assert (
        next(c for c in other["checks"] if c["code"] == "boss_clear_of_cutout")["status"] == "pass"
    )


def test_unknown_native_identity_is_rejected_not_ignored():
    with pytest.raises(UnknownReference):
        run({"mounts": [{"pad_id": str(UUID(int=0xDEAD)), "use": True}]})
    with pytest.raises(UnknownReference):
        run({"connectors": [{"component_id": str(UUID(int=0xDEAD)), "side": "east"}]})


def test_duplicate_identities_are_invalid():
    with pytest.raises(ValueError, match="unique"):
        Parameters.model_validate({"mounts": [{"pad_id": str(HOLES["a"][0]), "use": True}] * 2})


def test_output_is_deterministic_and_input_not_mutated():
    first, second = run(), run()
    assert first == second
