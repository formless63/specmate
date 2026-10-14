"""Exact arc and circle board outlines: independent expected values, no DB required."""

import json
import math
import os
import re
import shutil
import subprocess
from itertools import pairwise
from pathlib import Path

import pytest
from pydantic import ValidationError

from specmate.pcb import outline_geometry as g
from specmate.pcb.authority import projected_value, summary
from specmate.pcb.native_script import SCRIPT
from specmate.pcb.pack import IMAGE
from specmate.pcb.report import Report

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "tests/fixtures/native/kicad/rounded-board.kicad_pcb"
TOL = g.TOLERANCE_MM


def rounded_rectangle(w=40.0, h=25.0, r=4.0, reverse=False):
    """Edges of a w x h rectangle with corner radius r, authored independently by angle."""
    k = r * (1 - math.sqrt(0.5))
    edges = [
        g.line((r, 0), (w - r, 0)),
        g.arc((w - r, 0), (w - k, k), (w, r)),
        g.line((w, r), (w, h - r)),
        g.arc((w, h - r), (w - k, h - k), (w - r, h)),
        g.line((w - r, h), (r, h)),
        g.arc((r, h), (k, h - k), (0, h - r)),
        g.line((0, h - r), (0, r)),
        g.arc((0, r), (k, k), (r, 0)),
    ]
    return list(reversed(edges)) if reverse else edges


def expected_rounded_area(w=40.0, h=25.0, r=4.0):
    return w * h - 4 * (r * r - math.pi * r * r / 4)


def test_arc_parameters_are_exact_for_both_winding_directions():
    # Quarter circle about (10, 20), radius 5, from angle 0 to 90 degrees (y down).
    s, m, e = (15, 20), (10 + 5 * math.cos(math.pi / 4), 20 + 5 * math.sin(math.pi / 4)), (10, 25)
    forward = g.arc(s, m, e)
    assert forward["center"] == pytest.approx([10, 20])
    assert forward["radius"] == pytest.approx(5)
    assert forward["sweep_deg"] == pytest.approx(90)
    backward = g.arc(e, m, s)
    assert backward["sweep_deg"] == pytest.approx(-90)
    # A 270 degree arc keeps its long sweep, determined by the mid point.
    long = g.arc((15, 20), (10, 15), (10, 25))
    assert long["sweep_deg"] == pytest.approx(-270)


def test_collinear_arc_is_rejected():
    with pytest.raises(ValueError, match="collinear"):
        g.arc((0, 0), (1, 1), (2, 2))


@pytest.mark.parametrize("reverse", [False, True])
def test_rounded_rectangle_exact_area_bbox_and_tessellation_bound(reverse):
    edges = rounded_rectangle(reverse=reverse)
    result = g.build(edges)
    assert result and len(result["outline_exact"]) == 1 and not result["cutouts_exact"]
    measured = g.metrics(result["outline_exact"], result["cutouts_exact"])
    assert measured["net_area_mm2"] == pytest.approx(expected_rounded_area(), abs=1e-4)
    assert measured["bbox_mm"] == pytest.approx([0, 0, 40, 25], abs=1e-4)
    # Tessellation is inscribed: every vertex is on a fitted corner circle or edge, the
    # polygon area is below the exact area by no more than perimeter * tolerance.
    polygon = result["outline"][0]
    shoelace = (
        abs(
            sum(
                a[0] * b[1] - b[0] * a[1]
                for a, b in zip(polygon, [*polygon[1:], polygon[0]], strict=True)
            )
        )
        / 2
    )
    exact = expected_rounded_area()
    perimeter = 2 * (32 + 17) + 2 * math.pi * 4
    assert 0 < exact - shoelace <= perimeter * TOL
    assert result["tolerance_mm"] == TOL


def test_tessellated_arc_vertices_lie_on_the_circle_and_chords_respect_tolerance():
    radius, centre = 12.5, (3.0, -2.0)
    start = (centre[0] + radius, centre[1])
    mid = (centre[0], centre[1] + radius)
    end = (centre[0] - radius, centre[1])
    edge = g.arc(start, mid, end)
    points = [start, *g._arc_points(edge, TOL)]
    for p in points:
        assert math.dist(p, centre) == pytest.approx(radius, abs=1e-9)
    for a, b in pairwise(points):
        sagitta = radius - math.sqrt(radius**2 - (math.dist(a, b) / 2) ** 2)
        assert sagitta <= TOL + 1e-12
    coarse = g._arc_points(edge, 0.5)
    assert len(coarse) < len(points) - 1


def test_circle_loop_cutout_nesting_and_area():
    outer = rounded_rectangle()
    hole = g.circle((20, 12.5), 3)
    result = g.build([*outer, hole])
    assert len(result["outline_exact"]) == 1 and len(result["cutouts_exact"]) == 1
    measured = g.metrics(result["outline_exact"], result["cutouts_exact"])
    assert measured["net_area_mm2"] == pytest.approx(
        expected_rounded_area() - math.pi * 9, abs=1e-4
    )
    assert all(math.dist(p, (20, 12.5)) == pytest.approx(3, abs=1e-6) for p in result["cutouts"][0])


def test_circle_only_outline_bbox_and_area():
    result = g.build([g.circle((5, -3), 10)])
    measured = g.metrics(result["outline_exact"], result["cutouts_exact"])
    assert measured["bbox_mm"] == pytest.approx([-5, -13, 15, 7])
    assert measured["net_area_mm2"] == pytest.approx(math.pi * 100)


def test_arc_bbox_includes_axis_extrema_not_just_endpoints():
    # Half disc: semicircle from (10,0) via (0,10) to (-10,0) closed by its diameter.
    loop = [g.arc((10, 0), (0, 10), (-10, 0)), g.line((-10, 0), (10, 0))]
    assert g.bbox(loop) == pytest.approx([-10, 0, 10, 10])
    assert g.area(loop) == pytest.approx(math.pi * 100 / 2)
    # Sweep through the negative-x extreme only.
    loop = [g.arc((0, -10), (-10, 0), (0, 10)), g.line((0, 10), (0, -10))]
    assert g.bbox(loop) == pytest.approx([-10, -10, 0, 10])


def test_open_or_unsupported_loops_are_not_an_outline():
    assert g.build(rounded_rectangle()[:-1]) is None
    assert g.build([]) is None


def exact_report(result=None):
    result = result or g.build([*rounded_rectangle(), g.circle((20, 12.5), 3)])
    return {
        "format_version": 1,
        "adapter": "kicad-intake-v1",
        "tool_version": "10.0.6",
        "native_format_version": 20260206,
        "source_sha256": "0" * 64,
        "units": "mm",
        "coordinate_frame": "KiCad absolute: x right, y down; angles native degrees",
        "components": [],
        "pads": [],
        "copper_nets": {},
        "outline": result["outline"],
        "cutouts": result["cutouts"],
        "outline_exact": result["outline_exact"],
        "cutouts_exact": result["cutouts_exact"],
        "outline_tolerance_mm": result["tolerance_mm"],
        "outline_bridged_gaps": result["bridged_gaps"],
        "chaining_tolerance_mm": result["chaining_tolerance_mm"],
        "mounting_holes": [],
        "component_passages": [],
        "coverage": {
            "components": "identity-reference-value-footprint-and-flags",
            "pads": "identity-and-basic-geometry",
            "nets": "pad-membership-not-connectivity-proof",
            "outline": "closed-polygons-bridged"
            if result["bridged_gaps"]
            else "closed-polygons-with-arcs",
            "holes": "nonplated-pad-drills-not-reviewed-mounts",
            "placements": "native-absolute",
        },
        "unsupported": ["a", "b", "c", "d"],
        "physical_qualification": False,
    }


def test_report_accepts_exact_outline_and_projection_summarises_exact_values():
    payload = json.loads(json.dumps(exact_report()))
    report = Report.model_validate(payload)
    status, value = projected_value(payload)
    assert status == "known" and value["tolerance_mm"] == TOL
    shown = summary(status, value)
    assert shown["arcs"] == 4 and shown["circles"] == 1 and shown["geometry"] == "exact-arcs"
    assert shown["net_area_mm2"] == pytest.approx(expected_rounded_area() - 9 * math.pi, abs=1e-5)
    assert shown["bbox_mm"] == pytest.approx([0, 0, 40, 25], abs=1e-4)
    assert report.outline_metrics()["net_area_mm2"] == pytest.approx(shown["net_area_mm2"])


def mutate(payload, change):
    payload = json.loads(json.dumps(payload))
    change(payload)
    return payload


@pytest.mark.parametrize(
    "change",
    [
        lambda p: p["outline"][0].pop(5),  # polygon is not the tessellation of the arcs
        lambda p: p["outline_exact"][0][1].update(radius=4.5),  # inconsistent arc parameters
        lambda p: p["outline_exact"][0][1].update(end=[41, 4]),  # discontinuous loop
        lambda p: p.update(outline_exact=None),  # coverage claims exact arcs without them
        lambda p: p.update(outline_tolerance_mm=0.5),  # polygons no longer match the tolerance
        lambda p: p["coverage"].update(outline="closed-line-polygons"),
    ],
)
def test_report_rejects_inconsistent_exact_geometry(change):
    with pytest.raises(ValidationError):
        Report.model_validate(mutate(exact_report(), change))


def test_native_program_embeds_the_shared_geometry_and_is_bounded():
    assert "def circle_through" in SCRIPT and "import pcbnew" in SCRIPT
    assert len(SCRIPT) < 60_000
    compile(SCRIPT, "native", "exec")


def image_cached():
    docker = shutil.which("docker")
    if not docker:
        return False
    probe = subprocess.run(  # noqa: S603
        [docker, "image", "inspect", IMAGE], capture_output=True, check=False
    )
    return probe.returncode == 0


def run_native(tmp_path, board_text):
    inputs, outputs = tmp_path / "in", tmp_path / "out"
    inputs.mkdir()
    outputs.mkdir()
    outputs.chmod(0o777)
    (inputs / "board.kicad_pcb").write_text(board_text)
    script = tmp_path / "script.py"
    script.write_text(SCRIPT)
    run = subprocess.run(  # noqa: S603
        [
            shutil.which("docker"),
            "run",
            "--rm",
            "--network",
            "none",
            "--tmpfs",
            "/tmp",  # noqa: S108
            "--user",
            f"{os.getuid()}:{os.getgid()}",
            "-v",
            f"{inputs}:/inputs:ro",
            "-v",
            f"{outputs}:/outputs",
            "-v",
            f"{script}:/script.py:ro",
            IMAGE,
            "/usr/bin/python3",
            "/script.py",
            "/inputs/board.kicad_pcb",
            "/outputs/r.json",
        ],
        capture_output=True,
        check=False,
    )
    assert run.returncode == 0, run.stderr
    return json.loads((outputs / "r.json").read_text())


@pytest.mark.skipif(not image_cached(), reason="pinned KiCad image is not cached")
def test_real_kicad_extracts_exact_arcs_and_circle_from_original_board(tmp_path):
    payload = run_native(tmp_path, FIXTURE.read_text())
    report = Report.model_validate(payload)
    assert report.coverage.outline == "closed-polygons-with-arcs"
    kinds = [e.kind for loop in report.outline_exact for e in loop]
    assert kinds.count("arc") == 4 and kinds.count("line") == 4
    assert [e.kind for e in report.cutouts_exact[0]] == ["circle"]
    measured = report.outline_metrics()
    assert measured["bbox_mm"] == pytest.approx([0, 0, 40, 25], abs=1e-4)
    assert measured["net_area_mm2"] == pytest.approx(
        expected_rounded_area() - math.pi * 9, abs=1e-3
    )
    # KiCad's own chain of the same edges reproduces the exact bounds.
    xs = [p[0] for p in report.outline[0]]
    assert min(xs) == pytest.approx(0, abs=1e-6) and max(xs) == pytest.approx(40, abs=1e-6)


def parabola_lobe():
    """Cubic Bezier for x = 10t, y = 40t(1-t) closed by its chord.

    Independent expectations: chord-to-parabola area is 2/3 * base * height = 200/3 and the
    only y extremum is 10 at t = 1/2, which no control point or endpoint attains.
    """
    return [
        g.bezier((0, 0), (10 / 3, 40 / 3), (20 / 3, 40 / 3), (10, 0)),
        g.line((10, 0), (0, 0)),
    ]


@pytest.mark.parametrize("reverse", [False, True])
def test_bezier_bbox_from_extrema_and_area_approximate_within_tolerance(reverse):
    edges = parabola_lobe()
    result = g.build(list(reversed(edges)) if reverse else edges)
    assert result and result["outline_exact"]
    measured = g.metrics(result["outline_exact"], [])
    assert measured["bbox_mm"] == pytest.approx([0, 0, 10, 10], abs=1e-9)
    assert measured["area_approximate"] is True
    chord_error = 10 * TOL  # inscribed polygon: area error <= length * tolerance
    assert 0 <= 200 / 3 - measured["net_area_mm2"] <= chord_error
    assert (
        g.metrics([g.build(rounded_rectangle())["outline_exact"][0]], [])["area_approximate"]
        is False
    )


def test_bezier_tessellation_is_adaptive_and_within_tolerance():
    edge = parabola_lobe()[0]
    fine = [(0.0, 0.0), *g._bezier_points(edge, TOL)]
    coarse = g._bezier_points(edge, 0.5)
    assert len(coarse) < len(fine) - 1
    for a, b in pairwise(fine):
        # The curve is y = 0.4x(10 - x): the vertical gap to a chord of horizontal width w
        # is 0.1 w^2, and the perpendicular gap is that scaled by w / chord length.
        w = b[0] - a[0]
        assert 0.1 * w**2 * w / math.dist(a, b) <= TOL + 1e-12
    assert all(p[1] == pytest.approx(0.4 * p[0] * (10 - p[0]), abs=1e-9) for p in fine)


def test_report_accepts_bezier_outline_and_labels_area():
    result = g.build(parabola_lobe())
    payload = exact_report(result)
    Report.model_validate(payload)
    status, value = projected_value(payload)
    shown = summary(status, value)
    assert shown["beziers"] == 1 and shown["area_basis"] == "approximate-within-tolerance"
    payload["outline_exact"][0][0]["c1"] = [3, 4]
    with pytest.raises(ValidationError):
        Report.model_validate(payload)


def test_zero_length_edges_are_degenerate_and_real_edges_are_not():
    assert g.is_degenerate(g.bezier((1, 2), (1, 2), (1, 2), (1, 2)))
    assert g.is_degenerate(g.line((3, 3), (3, 3)))
    assert not g.is_degenerate(g.bezier((0, 0), (0, 0), (0, 0), (5, 0)))
    assert not g.is_degenerate(g.arc((15, 20), (10, 15), (10, 25)))


@pytest.mark.skipif(not image_cached(), reason="pinned KiCad image is not cached")
def test_real_kicad_extracts_bezier_edge_with_exact_control_points(tmp_path):
    text = FIXTURE.read_text()
    straight = re.search(r"\t\(gr_line\n\t\t\(start 4 0\)\n\t\t\(end 36 0\)\n", text)
    assert straight, "fixture top edge not found"
    # Replace the straight top edge by a collinear cubic: geometry and area are unchanged.
    curve = "\t(gr_curve\n\t\t(pts (xy 4 0) (xy 14.5 0) (xy 25.5 0) (xy 36 0))\n"
    payload = run_native(tmp_path, text[: straight.start()] + curve + text[straight.end() :])
    report = Report.model_validate(payload)
    beziers = [e for loop in report.outline_exact for e in loop if e.kind == "bezier"]
    assert len(beziers) == 1
    assert (beziers[0].c1, beziers[0].c2) == ((14.5, 0), (25.5, 0))
    measured = report.outline_metrics()
    assert measured["area_approximate"] is True
    assert measured["net_area_mm2"] == pytest.approx(
        expected_rounded_area() - math.pi * 9, abs=1e-3
    )
    assert measured["bbox_mm"] == pytest.approx([0, 0, 40, 25], abs=1e-4)


def gapped_rectangle(gap):
    """Rounded rectangle whose top edge stops `gap` mm short of the top-right arc."""
    edges = rounded_rectangle()
    edges[0] = g.line((4, 0), (36 - gap, 0))
    return edges


def test_small_gap_is_bridged_listed_and_does_not_change_exact_values():
    result = g.build(gapped_rectangle(0.03))
    assert result and result["chaining_tolerance_mm"] == g.BRIDGE_MM == 0.05
    assert result["bridged_gaps"] == [{"at": [35.97, 0], "to": [36, 0], "size_mm": 0.03}]
    measured = g.metrics(result["outline_exact"], [])
    # The gap lies on the top edge's own line, so the straight chord adds no area.
    assert measured["net_area_mm2"] == pytest.approx(expected_rounded_area(), abs=1e-4)
    assert [35.97, 0] in result["outline"][0] and [36, 0] in result["outline"][0]
    payload = exact_report(result)
    Report.model_validate(payload)
    status, value = projected_value(payload)
    shown = summary(status, value)
    assert shown["bridged_gaps"] == 1 and shown["max_bridged_gap_mm"] == pytest.approx(0.03)


def test_off_line_gap_area_includes_the_bridging_chord():
    edges = rounded_rectangle()
    # Move the top-right corner arc's start 0.04 mm down: the chord is a slanted bridge.
    k = 4 * (1 - math.sqrt(0.5))
    edges[1] = g.arc((36, 0.04), (40 - k, k), (40, 4))
    result = g.build(edges)
    assert [gap["size_mm"] for gap in result["bridged_gaps"]] == [0.04]
    polygon_area = (
        abs(
            sum(
                a[0] * b[1] - b[0] * a[1]
                for a, b in pairwise([*result["outline"][0], result["outline"][0][0]])
            )
        )
        / 2
    )
    exact = g.metrics(result["outline_exact"], [])["net_area_mm2"]
    assert 0 <= exact - polygon_area <= 100 * TOL


def test_gap_above_the_chaining_tolerance_is_refused():
    assert g.build(gapped_rectangle(0.06)) is None
    result = g.build(gapped_rectangle(0.05))
    assert result and result["bridged_gaps"][0]["size_mm"] == pytest.approx(0.05)


@pytest.mark.parametrize(
    "change",
    [
        lambda p: p.update(outline_bridged_gaps=[]),  # silently dropped gap
        lambda p: p["outline_bridged_gaps"][0].update(size_mm=0.02),
        lambda p: p["coverage"].update(outline="closed-polygons-with-arcs"),
        lambda p: p.update(outline_bridged_gaps=None),
    ],
)
def test_report_never_accepts_unlisted_or_misdescribed_bridges(change):
    payload = exact_report(g.build(gapped_rectangle(0.03)))
    Report.model_validate(payload)
    with pytest.raises(ValidationError):
        Report.model_validate(mutate(payload, change))
