"""Generate original synthetic slicer fixtures (ASCII STL, millimetres).

The shapes are defined here from first principles; no external model is copied.

- ``cube-20mm.stl``: a 20 x 20 x 20 mm calibration cube, 12 triangles.
- ``overhang-tee.stl``: a 30 mm wide T profile extruded 10 mm along Y. A 10 x 10 mm
  stem carries a 30 x 3 mm top bar, so each side of the bar overhangs 10 mm with no
  material below it (needs supports or bridging).
- ``malformed.stl``: a binary STL header that declares 1000 facets but carries one.

Usage: python3 generate_fixture.py <output-directory>
"""

import pathlib
import struct
import sys

# Each STL facet is three vertices ordered counter-clockwise seen from outside.
Vertex = tuple[float, float, float]
Facet = tuple[Vertex, Vertex, Vertex]


def box(x0: float, y0: float, z0: float, x1: float, y1: float, z1: float) -> list[Facet]:
    p = {
        (i, j, k): (x1 if i else x0, y1 if j else y0, z1 if k else z0)
        for i in (0, 1)
        for j in (0, 1)
        for k in (0, 1)
    }
    quads = [
        ((0, 0, 0), (0, 1, 0), (1, 1, 0), (1, 0, 0)),  # bottom, -Z
        ((0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)),  # top, +Z
        ((0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1)),  # front, -Y
        ((0, 1, 0), (0, 1, 1), (1, 1, 1), (1, 1, 0)),  # back, +Y
        ((0, 0, 0), (0, 0, 1), (0, 1, 1), (0, 1, 0)),  # left, -X
        ((1, 0, 0), (1, 1, 0), (1, 1, 1), (1, 0, 1)),  # right, +X
    ]
    facets: list[Facet] = []
    for a, b, c, d in quads:
        facets.append((p[a], p[b], p[c]))
        facets.append((p[a], p[c], p[d]))
    return facets


# T profile in the XZ plane, counter-clockwise seen from -Y (the front).
TEE = [(10, 0), (20, 0), (20, 10), (30, 10), (30, 13), (0, 13), (0, 10), (10, 10)]
# Cap triangles over TEE vertex indices, counter-clockwise in (x, z).
TEE_CAP = [(0, 1, 2), (0, 2, 7), (6, 7, 5), (7, 4, 5), (7, 2, 4), (2, 3, 4)]


def tee(depth: float = 10.0) -> list[Facet]:
    def at(index: int, y: float) -> Vertex:
        x, z = TEE[index]
        return (float(x), y, float(z))

    facets: list[Facet] = []
    for a, b, c in TEE_CAP:
        # Front cap faces -Y: (x, z) counter-clockwise seen from -Y.
        facets.append((at(a, 0.0), at(b, 0.0), at(c, 0.0)))
        facets.append((at(a, depth), at(c, depth), at(b, depth)))
    for i in range(len(TEE)):
        j = (i + 1) % len(TEE)
        facets.append((at(i, 0.0), at(i, depth), at(j, depth)))
        facets.append((at(i, 0.0), at(j, depth), at(j, 0.0)))
    return facets


def normal(facet: Facet) -> Vertex:
    (ax, ay, az), (bx, by, bz), (cx, cy, cz) = facet
    ux, uy, uz = bx - ax, by - ay, bz - az
    vx, vy, vz = cx - ax, cy - ay, cz - az
    n = (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
    length = sum(c * c for c in n) ** 0.5
    return (n[0] / length, n[1] / length, n[2] / length)


def ascii_stl(name: str, facets: list[Facet]) -> bytes:
    def fmt(v: Vertex) -> str:
        return " ".join(format(c + 0.0, ".6e") for c in v)

    lines = [f"solid {name}"]
    for facet in facets:
        lines.append(f"  facet normal {fmt(normal(facet))}")
        lines.append("    outer loop")
        lines.extend(f"      vertex {fmt(v)}" for v in facet)
        lines.append("    endloop")
        lines.append("  endfacet")
    lines.append(f"endsolid {name}")
    return ("\n".join(lines) + "\n").encode("ascii")


def volume(facets: list[Facet]) -> float:
    """Signed volume of a closed outward-oriented mesh (divergence theorem)."""
    total = 0.0
    for (ax, ay, az), (bx, by, bz), (cx, cy, cz) in facets:
        total += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
    return total / 6.0


def malformed() -> bytes:
    header = b"specmate synthetic truncated binary STL".ljust(80, b" ")
    one = struct.pack("<12fH", 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0)
    return header + struct.pack("<I", 1000) + one


FIXTURES = {
    "cube-20mm.stl": lambda: ascii_stl("specmate_cube_20mm", box(0, 0, 0, 20, 20, 20)),
    "overhang-tee.stl": lambda: ascii_stl("specmate_overhang_tee", tee()),
    "malformed.stl": malformed,
}


def main(directory: str) -> None:
    out = pathlib.Path(directory)
    out.mkdir(parents=True, exist_ok=True)
    for name, build in FIXTURES.items():
        (out / name).write_bytes(build())


if __name__ == "__main__":
    main(sys.argv[1])
