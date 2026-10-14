from decimal import Decimal

import pytest

from specmate.pcb.component_values import parse_capacitance, parse_resistance
from specmate.pcb.native_script import PROGRAM, VALUES


@pytest.mark.parametrize(
    ("text", "ohms"),
    [
        ("2k2", "2200"),
        ("4R7", "4.7"),
        ("R47", "0.47"),
        ("1M5", "1500000"),
        ("0R", "0"),
        ("10", "10"),
        ("4.7", "4.7"),
        ("10k", "10000"),
        ("4.7K", "4700"),
        ("1M", "1000000"),
        ("220R", "220"),
        ("2k2 ohm", "2200"),
        ("100Ω", "100"),
        ("4K7", "4700"),
        ("0R1", "0.1"),
    ],
)
def test_resistance_is_exact(text, ohms):
    assert parse_resistance(text) == Decimal(ohms)


@pytest.mark.parametrize(
    "text",
    ["", "R", "k", "1m5", "10m", "2k2k", "1k2k3", "abc", "1,5k", "-5", "1e3", "4.7R7", None, 5],
)
def test_ambiguous_or_malformed_resistance_stays_unknown(text):
    assert parse_resistance(text) is None


@pytest.mark.parametrize(
    ("text", "farads"),
    [
        ("4n7", "4.7e-9"),
        ("2u2", "2.2e-6"),
        ("100p", "1e-10"),
        ("100nF", "1e-7"),
        ("1µ", "1e-6"),
        ("p47", "4.7e-13"),
    ],
)
def test_capacitance_is_exact(text, farads):
    assert parse_capacitance(text) == Decimal(farads)


@pytest.mark.parametrize("text", ["100", "1k", "n", "4n7n", ""])
def test_capacitance_requires_a_unit_prefix(text):
    assert parse_capacitance(text) is None


def test_embedded_program_uses_the_same_parser():
    assert VALUES in PROGRAM
    assert "parse_resistance(value)" in PROGRAM
    scope = {}
    exec(VALUES, scope)  # noqa: S102 - the trusted pack source under test
    assert scope["parse_resistance"]("2k2") == Decimal(2200)
