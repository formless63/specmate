"""Exact passive component value notation (IEC 60062 RKM plus plain forms).

Pure module, embedded verbatim in the trusted native program, so it imports only the
standard library. A string that is not unambiguously a value returns ``None``; nothing is
guessed. Lowercase ``m`` is refused for resistance (milli versus mega is ambiguous).
"""

import re
from decimal import Decimal

_RESISTANCE = {"R": "1", "k": "1e3", "K": "1e3", "M": "1e6", "G": "1e9"}
_CAPACITANCE = {"p": "1e-12", "n": "1e-9", "u": "1e-6", "µ": "1e-6", "μ": "1e-6", "m": "1e-3"}
_NUM = r"[0-9]+(?:\.[0-9]+)?"


def _parse(text, letters, unit):
    if not isinstance(text, str):
        return None
    s = re.sub(r"\s+", "", text)
    if unit:
        s = re.sub(unit + r"$", "", s)
    chars = "".join(re.escape(c) for c in letters)
    # Letter replaces the decimal point: 2k2, 4R7, R47, 1M5, 4n7.
    m = re.fullmatch(rf"([0-9]*)([{chars}])([0-9]+)", s)
    if m and (m[1] or m[3]):
        return Decimal(f"{m[1] or '0'}.{m[3]}") * Decimal(letters[m[2]])
    # Plain number with optional multiplier: 47, 4.7k, 100p, 0R.
    m = re.fullmatch(rf"({_NUM})([{chars}]?)", s)
    if m:
        return Decimal(m[1]) * Decimal(letters[m[2]] if m[2] else "1")
    return None


def parse_resistance(text):
    """Ohms as an exact Decimal, or None when not an unambiguous resistance."""
    return _parse(text, _RESISTANCE, r"(?:[Oo]hms?|Ω|Ω)")


def parse_capacitance(text):
    """Farads as an exact Decimal, or None; a bare number is not assumed to be farads."""
    value = _parse(text, _CAPACITANCE, r"F")
    if value is None or not re.search(r"[pnuµμm]", re.sub(r"\s+", "", text)):
        return None
    return value
