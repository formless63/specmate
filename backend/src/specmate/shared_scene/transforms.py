"""Canonical parent-from-local transforms; row-major matrices, column vectors."""

from specmate.assemblies.contracts import Placement

IDENTITY = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]


def placement_matrix(placement: Placement):
    if placement.status == "unknown":
        return None
    x, y, z, w = placement.rotation_xyzw
    tx, ty, tz = placement.translation
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), tx],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), ty],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), tz],
        [0, 0, 0, 1],
    ]


def compose(parent, local):
    """An unknown ancestor makes world placement unknown, including at the origin."""
    if parent is None or local is None:
        return None
    return [[sum(parent[i][k] * local[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def millimetre_factor(unit):
    # Explicit declared units only. Dimensions/mesh extents cannot infer units.
    return {"mm": 1, "m": 1000, "in": 25.4}.get(unit)
