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


def conditional_model(passages, conditions=None):
    return PassageModel(
        root_revision_id=REVISION,
        assumptions="ideal_lumped_components",
        model_basis="Synthetic ideal contacts under one exclusive declared state per variable.",
        conditions=conditions
        if conditions is not None
        else [
            {"local_id": "selector", "states": ["left", "right"], "basis": "Exclusive positions."}
        ],
        passages=passages,
    ).model_dump(mode="json")


def contact(local_id, state, a=0, b=1, condition_id="selector", **extra):
    return passage(
        local_id,
        "conditional",
        a,
        b,
        conditional_contact={
            "condition_id": condition_id,
            "state": state,
            "behavior": "ideal_contact",
        },
        **extra,
    )


def assignment(state, condition_id="selector"):
    return [{"condition_id": condition_id, "state": state}]


@pytest.mark.parametrize("meaning", ["dc_continuity", "shortness", "resistance", "signal"])
def test_explicit_ideal_contact_assignment_opens_or_closes_only_the_declared_model(meaning):
    circuit = conditional_model([contact("contact-left", "left")])
    missing = interpret(graph(), circuit, query(meaning))
    assert missing["status"] == "unknown"
    assert missing["paths"][0]["reasons"] == ["condition_assignment_required"]
    closed = interpret(graph(), circuit, query(meaning, condition_assignments=assignment("left")))
    assert (
        closed["status"]
        == {
            "dc_continuity": "modeled_dc_path",
            "shortness": "modeled_ideal_short",
            "resistance": "modeled_series_resistance",
            "signal": "modeled_signal_candidate",
        }[meaning]
    )
    assert closed["assumptions"]["condition_assignments"] == assignment("left")
    assert closed["paths"][0]["steps"][0]["assigned_state"] == "left"
    assert closed["physical_continuity"] == closed["signal_transfer"] == "not_evaluated"
    opened = interpret(graph(), circuit, query(meaning, condition_assignments=assignment("right")))
    assert opened["status"] == "modeled_blocked"
    assert opened["paths"][0]["series_resistance_ohm"] is None
    assert opened["paths"][0]["series_impedance_ohm"] is None
    assert opened["paths"][0]["steps"][0]["status"] == "ideal_contact_open_under_assignment"


@pytest.mark.parametrize("state", [None, "left", "right"])
def test_two_positions_of_same_condition_never_form_a_satisfied_proof(state):
    circuit = conditional_model(
        [contact("left-leg", "left", 0, 1), contact("right-leg", "right", 1, 2)]
    )
    for meaning in ["dc_continuity", "shortness", "resistance", "signal"]:
        assignments = assignment(state) if state else []
        result = interpret(
            graph(), circuit, query(meaning, 0, 2, condition_assignments=assignments)
        )
        assert result["status"] == "unknown"
        path = result["paths"][0]
        assert path["reasons"] == ["mutually_exclusive_condition_states"]
        assert path["conflicting_condition_ids"] == ["selector"]
        assert path["condition_requirements"] == [
            {"condition_id": "selector", "states": ["left", "right"]}
        ]
        assert path["series_resistance_ohm"] is path["series_impedance_ohm"] is None
        assert path["shortness"] == "not_evaluated"


def test_repeated_same_state_is_valid_and_independent_conditions_are_not_conflated():
    declarations = [
        {"local_id": key, "states": ["left", "right"], "basis": "Independent switch."}
        for key in ["selector", "other-selector"]
    ]
    circuit = conditional_model(
        [
            contact("one", "left", 0, 1),
            contact("two", "left", 1, 2),
            contact("three", "right", 2, 3, "other-selector"),
        ],
        declarations,
    )
    assigned = assignment("left") + assignment("right", "other-selector")
    result = interpret(graph(), circuit, query(a=0, b=3, condition_assignments=assigned))
    assert result["status"] == "modeled_dc_path"
    assert result["paths"][0]["conflicting_condition_ids"] == []
    assert (
        interpret(graph(), circuit, query(a=3, b=0, condition_assignments=assigned))["status"]
        == "modeled_dc_path"
    )


@pytest.mark.parametrize("kind", ["active", "diode", "unknown"])
def test_supported_condition_assignment_never_resolves_active_nonlinear_or_missing_behavior(kind):
    circuit = conditional_model(
        [contact("closed", "left", 0, 1), passage("unresolved", kind, 1, 2)]
    )
    result = interpret(graph(), circuit, query(a=0, b=2, condition_assignments=assignment("left")))
    assert result["status"] == "unknown"
    assert result["paths"][0]["steps"][1]["status"] == "unknown"
    # An open contact in series also cannot turn active behavior into a disconnection proof.
    opened = interpret(graph(), circuit, query(a=0, b=2, condition_assignments=assignment("right")))
    assert opened["status"] == "unknown"
    assert opened["paths"][0]["series_resistance_ohm"] is None


def test_extra_free_text_conditions_and_untyped_contacts_remain_unknown():
    circuit = conditional_model([contact("one", "left", condition="Unmodeled supply state")])
    assert (
        interpret(graph(), circuit, query(condition_assignments=assignment("left")))["status"]
        == "unknown"
    )
    assert (
        interpret(graph(), model([passage("one", "conditional")]), query())["status"] == "unknown"
    )


@pytest.mark.parametrize("states", [["left", "left"], ["left"], []])
def test_conditions_reject_duplicate_or_insufficient_states(states):
    with pytest.raises(ValidationError):
        conditional_model([], [{"local_id": "selector", "states": states, "basis": "Synthetic."}])


def test_condition_contracts_reject_undeclared_references_duplicate_assignments_and_noncontacts():
    with pytest.raises(ValidationError):
        conditional_model([contact("one", "undeclared")])
    with pytest.raises(ValidationError):
        conditional_model([contact("one", "left", condition_id="missing")])
    with pytest.raises(ValidationError):
        conditional_model([{**contact("one", "left"), "kind": "active"}])
    with pytest.raises(ValidationError):
        query(condition_assignments=assignment("left") + assignment("right"))
    with pytest.raises(ValidationError):
        conditional_model(
            [], [{"local_id": "selector", "states": ["left", "right"], "basis": "Synthetic."}] * 2
        )
    for assigned in [assignment("missing"), assignment("left", "missing")]:
        with pytest.raises(ValueError, match="frozen model"):
            interpret(graph(), conditional_model([]), query(condition_assignments=assigned))
