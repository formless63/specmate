"""Declared physical and electrical construction are distinct."""

import pytest
from pydantic import ValidationError

from specmate.wire_stock.schemas import StockSpecification

from .test_wire_stock import fixture


def test_intrinsic_stock_bonds_validate_exact_conductive_paths_and_keep_unknown():
    original = fixture()
    assert "bonded_sets" not in StockSpecification.model_validate(original).model_dump(mode="json")
    original["bonded_sets"] = []
    assert StockSpecification.model_validate(original).model_dump(mode="json")["bonded_sets"] == []
    original["bonded_sets"] = [
        {
            "local_id": "common",
            "element_paths": ["stock.center", "stock.screen"],
            "basis": "Original synthetic construction",
        }
    ]
    StockSpecification.model_validate(original)
    original["bonded_sets"][0]["element_paths"][1] = "stock.dielectric"
    with pytest.raises(ValidationError):
        StockSpecification.model_validate(original)


def test_bare_copper_and_insulation_keep_one_terminal_without_invalid_dimensions():
    original = fixture()
    original["structure"]["children"][0]["insulated_diameter_mm"] = 1.5
    model = StockSpecification.model_validate(original)
    assert model.structure.children[0].id == "center"
    assert model.structure.children[0].outer_diameter_mm == 1
    assert model.structure.children[0].insulated_diameter_mm == 1.5
    original["structure"]["children"][0]["insulated_diameter_mm"] = 0.9
    with pytest.raises(ValidationError):
        StockSpecification.model_validate(original)
