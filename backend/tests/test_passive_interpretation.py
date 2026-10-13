"""Independent synthetic ideal circuit arithmetic and conservative unsupported behavior."""

from decimal import Decimal, localcontext

import pytest
from pydantic import ValidationError

from specmate.passive_passages.contracts import InterpretModel, PassageModel
from specmate.passive_passages.interpretation import interpret

NODES = ["terminal-" + str(index) * 64 for index in range(1, 5)]
REVISION = "00000000-0000-0000-0000-000000000001"


def graph(edges=()):
    return {"nodes": [{"id": node} for node in NODES], "edges": list(edges), "boundaries": []}


def passage(local_id, kind, a=0, b=1, **parameters):
    return {
        "local_id": local_id,
        "kind": kind,
        "from_terminal_id": NODES[a],
        "to_terminal_id": NODES[b],
        "basis": "Original synthetic ideal component declaration.",
        **parameters,
    }


def model(passages):
    return PassageModel(
        root_revision_id=REVISION,
        assumptions="ideal_lumped_components",
        model_basis="Declared ideal components; no measured circuit claim.",
        passages=passages,
    ).model_dump(mode="json")


def query(kind="dc_continuity", a=0, b=1, **extra):
    return InterpretModel(
        revision_id=REVISION,
        from_terminal_id=NODES[a],
        to_terminal_id=NODES[b],
        query=kind,
        copper_assumption="ideal_zero_resistance",
        **extra,
    )


def test_resistor_path_is_resistive_with_exact_series_sum_and_no_physical_claim():
    circuit = model(
        [
            passage("r1", "resistor", 0, 1, resistance_ohm="330"),
            passage("r2", "resistor", 1, 2, resistance_ohm="470"),
        ]
    )
    result = interpret(graph(), circuit, query(a=0, b=2))
    assert result["status"] == "modeled_dc_path"
    assert [s["status"] for s in result["paths"][0]["steps"]] == ["resistive", "resistive"]
    assert result["paths"][0]["series_resistance_ohm"] == "800"
    resistance = interpret(graph(), circuit, query("resistance", 0, 2))
    assert resistance["series_resistance_ohm"] == "800"
    assert (
        interpret(graph(), circuit, query("shortness", 0, 2))["status"] == "modeled_no_ideal_short"
    )
    assert result["physical_continuity"] == result["physical_qualification"] == "not_evaluated"


def test_capacitor_blocks_ideal_steady_state_dc_but_signal_requires_frequency_and_c():
    circuit = model([passage("c1", "capacitor", capacitance_f="0.000001")])
    assert interpret(graph(), circuit, query())["status"] == "modeled_blocked"
    assert interpret(graph(), circuit, query("signal"))["status"] == "unknown"
    signal = interpret(graph(), circuit, query("signal", frequency_hz="1000"))
    assert signal["status"] == "modeled_signal_candidate"
    impedance = signal["paths"][0]["series_impedance_ohm"]
    assert impedance["real"] == "0"
    assert abs(Decimal(impedance["imaginary"]) - Decimal("-159.154943091895")) < Decimal(
        "0.000000000001"
    )
    assert impedance["precision"] == "derived_approximation"
    assert signal["signal_transfer"] == "not_evaluated"
    assert signal["paths"][0]["shortness"] == "not_evaluated"
    assert interpret(graph(), circuit, query("shortness"))["paths"][0]["shortness"] == "blocked"
    missing = model([passage("c1", "capacitor")])
    assert interpret(graph(), missing, query("signal", frequency_hz="1000"))["status"] == "unknown"


@pytest.mark.parametrize("kind", ["diode", "transformer", "inductor", "active", "unknown"])
def test_unsupported_behavior_never_becomes_continuity_and_diode_direction_is_preserved(kind):
    circuit = model([passage("p1", kind)])
    for request in [
        query(),
        query("resistance"),
        query("signal", frequency_hz="1000"),
        query(a=1, b=0),
    ]:
        result = interpret(graph(), circuit, request)
        assert result["status"] == "unknown"
        assert result["paths"][0]["steps"][0]["direction"] == (
            "reverse" if request.from_terminal_id == NODES[1] else "forward"
        )


def test_unrelated_conditions_cannot_combine_into_a_continuity_proof():
    circuit = model(
        [
            passage("switch-a", "conditional", 0, 1, condition="Switch X selects A"),
            passage("switch-b", "conditional", 1, 2, condition="Switch X selects B"),
        ]
    )
    result = interpret(graph(), circuit, query(a=0, b=2))
    assert result["status"] == "unknown"
    assert [s["condition"] for s in result["paths"][0]["steps"]] == [
        "Switch X selects A",
        "Switch X selects B",
    ]


def test_parallel_resistors_report_each_series_path_and_require_network_solver():
    circuit = model(
        [
            passage("r1", "resistor", resistance_ohm="100"),
            passage("r2", "resistor", resistance_ohm="200"),
        ]
    )
    result = interpret(graph(), circuit, query("resistance"))
    assert result["status"] == "unknown" and result["series_resistance_ohm"] is None
    assert result["reason"] == "multiple_paths_require_network_solver"
    assert sorted(p["series_resistance_ohm"] for p in result["paths"]) == ["100", "200"]


def test_copper_zero_is_explicit_model_assumption_not_measured_resistance():
    edge = {
        "id": "wire-one",
        "members": NODES[:2],
        "kind": "wire",
        "evidence": "declared_copper",
        "basis": "Declared synthetic wire",
        "provenance": {},
    }
    request = query("resistance")
    assert interpret(graph([edge]), model([]), request)["series_resistance_ohm"] == "0"
    unspecified = request.model_copy(update={"copper_assumption": "unspecified"})
    result = interpret(graph([edge]), model([]), unspecified)
    assert result["status"] == "unknown"
    assert result["paths"][0]["steps"][0]["evidence"] == "declared_copper"


def test_tiny_positive_resistance_never_underflows_to_an_ideal_short_and_ignores_global_context():
    with localcontext() as context:
        context.prec = 2
        circuit = model(
            [passage("r1", "resistor", resistance_ohm="0.000000000000000000000000000001")]
        )
        result = interpret(graph(), circuit, query("shortness"))
    assert result["status"] == "modeled_no_ideal_short"
    assert Decimal(result["paths"][0]["series_resistance_ohm"]) == Decimal("1e-30")
    zero = interpret(
        graph(), model([passage("r0", "resistor", resistance_ohm=0)]), query("shortness")
    )
    assert zero["status"] == "modeled_ideal_short"


@pytest.mark.parametrize(
    "value",
    [
        True,
        False,
        0.0,
        1e-30,
        "1e-31",
        "NaN",
        "Infinity",
        "1e31",
        "1e-300",
        "1.00000000000000000000000000000000000000001",
    ],
)
def test_electrical_inputs_reject_floats_nonfinite_underflow_or_precision_overflow(value):
    with pytest.raises(ValidationError):
        model([passage("r1", "resistor", resistance_ohm=value)])


def test_search_bounds_and_cycles_never_return_a_partial_definitive_answer():
    circuit = model(
        [
            passage("r1", "resistor", 0, 1, resistance_ohm="100"),
            passage("r2", "resistor", 0, 2, resistance_ohm="100"),
            passage("r3", "resistor", 2, 1, resistance_ohm="100"),
            passage("r4", "resistor", 2, 3, resistance_ohm="100"),
            passage("r5", "resistor", 3, 0, resistance_ohm="100"),
        ]
    )
    result = interpret(graph(), circuit, query(max_paths=1))
    assert result["limited"] and result["status"] == "unknown"
    hops = interpret(graph(), circuit, query(max_hops=1))
    assert hops["limited"] and hops["status"] == "unknown"
    assert (
        interpret(graph(), model([]), query())["reason"]
        == "no_modeled_path_is_not_physical_disconnection"
    )
