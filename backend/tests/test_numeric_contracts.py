"""Python bool is an int subclass; JSON engineering numbers must remain numbers."""

import pytest
from pydantic import ValidationError

from specmate.assemblies.contracts import Placement
from specmate.interfaces.contracts import Contact, ElectricalContract, Orientation
from specmate.pcb.report import Passage


@pytest.mark.parametrize("value", [True, False, "1", float("inf"), float("nan")])
@pytest.mark.parametrize(
    "contract,payload,field",
    [
        (ElectricalContract, {}, "current_max_a"),
        (Orientation, {"viewing_side": "mating", "datum": "Declared zero"}, "rotation_degrees"),
        (Passage, {"kind": "resistor", "from": "a", "to": "b"}, "resistance_ohm"),
    ],
)
def test_engineering_limits_and_angles_reject_non_json_numbers(contract, payload, field, value):
    with pytest.raises(ValidationError):
        contract.model_validate({**payload, field: value})


def test_known_coordinate_and_quaternion_fields_reject_boolean_coordinates():
    with pytest.raises(ValidationError):
        Contact(contact_id="a", position_mm=(True, 0))
    with pytest.raises(ValidationError):
        Placement(status="known", translation=(True, 0, 0), rotation_xyzw=(0, 0, 0, 1))
    with pytest.raises(ValidationError):
        Placement(status="known", translation=(0, 0, 0), rotation_xyzw=(0, 0, 0, True))
    assert Placement(
        status="known", translation=(0, 10, 20), rotation_xyzw=(0, 0, 0, 1)
    ).translation == (0, 10, 20)
    assert ElectricalContract(current_max_a=1).current_max_a == 1


@pytest.mark.parametrize("position", [(True, 0), (0, True), (False, 0), (0, "1")])
def test_native_report_coordinates_reject_booleans_and_strings(position):
    from uuid import UUID

    from specmate.pcb.report import Component

    with pytest.raises(ValidationError):
        Component(
            id=UUID(int=1),
            reference="J1",
            value="Synthetic contact",
            footprint="Synthetic footprint",
            position=position,
            rotation_deg=0,
            side="front",
            dnp=False,
            exclude_from_bom=False,
        )
