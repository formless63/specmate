"""A deliberately finite dimension-aware registry; no guessed or dynamically fetched units."""

from decimal import Decimal

# dimension, canonical unit, factor, offset (offset is excluded for tolerance deltas)
UNITS = {
    "mm": ("length", "mm", "1", "0"),
    "cm": ("length", "mm", "10", "0"),
    "m": ("length", "mm", "1000", "0"),
    "in": ("length", "mm", "25.4", "0"),
    "mg": ("mass", "g", "0.001", "0"),
    "g": ("mass", "g", "1", "0"),
    "kg": ("mass", "g", "1000", "0"),
    "ms": ("time", "s", "0.001", "0"),
    "s": ("time", "s", "1", "0"),
    "min": ("time", "s", "60", "0"),
    "V": ("voltage", "V", "1", "0"),
    "mV": ("voltage", "V", "0.001", "0"),
    "A": ("current", "A", "1", "0"),
    "mA": ("current", "A", "0.001", "0"),
    "ohm": ("resistance", "ohm", "1", "0"),
    "kohm": ("resistance", "ohm", "1000", "0"),
    "F": ("capacitance", "F", "1", "0"),
    "uF": ("capacitance", "F", "0.000001", "0"),
    "nF": ("capacitance", "F", "0.000000001", "0"),
    "pF": ("capacitance", "F", "0.000000000001", "0"),
    "H": ("inductance", "H", "1", "0"),
    "mH": ("inductance", "H", "0.001", "0"),
    "Hz": ("frequency", "Hz", "1", "0"),
    "kHz": ("frequency", "Hz", "1000", "0"),
    "MHz": ("frequency", "Hz", "1000000", "0"),
    "K": ("temperature", "K", "1", "0"),
    "degC": ("temperature", "K", "1", "273.15"),
    "deg": ("angle", "deg", "1", "0"),
    "ea": ("count", "ea", "1", "0"),
    "1": ("dimensionless", "1", "1", "0"),
    "%": ("dimensionless", "1", "0.01", "0"),
}


def convert(value, unit, *, delta=False):
    _, canonical_unit, factor, offset = UNITS[unit]
    magnitude = value * Decimal(factor) + (Decimal(0) if delta else Decimal(offset))
    # Fixed-point output avoids decimal exponent spelling creating false conflicts.
    encoded = format(magnitude, "f")
    if "." in encoded:
        encoded = encoded.rstrip("0").rstrip(".")
    return canonical_unit, "0" if magnitude == 0 else encoded
