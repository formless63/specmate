"""Rendered bench addresses retain exact independently authored test endpoints."""

import pytest

from specmate.cable_test_intent.contracts import Terminal
from specmate.preparation_documents.projection import test_address_generator as generator_for
from specmate.preparation_documents.rendering import test_tables as render_tables


@pytest.mark.parametrize(
    "terminal,label,modern",
    [
        ({"kind": "contact", "endpoint_id": "left", "contact_id": "7"}, "left · 7", False),
        (
            {"kind": "stock_feature", "endpoint_id": "right", "element_path": "core.center"},
            "right · core.center",
            False,
        ),
        (
            {
                "kind": "stack_terminal",
                "endpoint_id": "left",
                "layer_id": "plug",
                "terminal_id": "pin<7>",
            },
            "left · plug · pin&lt;7&gt;",
            True,
        ),
        (
            {"kind": "segment", "segment_id": "trunk", "end": "a", "element_path": "coax.center"},
            "trunk · a · coax.center",
            True,
        ),
        (
            {"kind": "pigtail", "segment_id": "branch", "end": "b", "pigtail_id": "drain"},
            "branch · b · drain",
            True,
        ),
    ],
)
def test_exact_addresses_are_readable_escaped_and_versioned(terminal, label, modern):
    target = Terminal.model_validate(terminal).model_dump(mode="json")
    other = {"kind": "contact", "endpoint_id": "other", "contact_id": "1"}
    context = {
        "address": {"path": ["wiring"]},
        "declarations": {
            "test_plan": {
                "pairs": [
                    {"local_id": "check", "first": target, "second": other, "intent": "continuity"}
                ],
                "labels": [{"terminal": target, "text": "Independent expected endpoint"}],
            }
        },
    }
    result = render_tables([context])
    assert result.count(label) == 2
    assert "None" not in result and "pin<7>" not in result
    assert "no physical test performed" in result
    for legacy in ("specmate.preparation-documents/2", "specmate.preparation-documents/4"):
        assert generator_for([context], legacy) == (
            "specmate.preparation-documents/5" if modern else legacy
        )
    context["declarations"]["test_plan"]["pairs"] = []
    assert generator_for([context], "legacy") == (
        "specmate.preparation-documents/5" if modern else "legacy"
    )
