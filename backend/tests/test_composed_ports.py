"""INT-001/003: logical ports comprise exact physical member occurrences."""

import pytest
from pydantic import ValidationError

from specmate.interfaces import examples
from specmate.interfaces.contracts import Port
from specmate.interfaces.queries import end_expectations
from specmate.operations import NotFound, ValidationFailed

from .test_interface_ports import create, frozen


def composed(member):
    return {
        "kind": "port",
        "schema_version": "0.3",
        "device_label": "Synthetic monitor",
        "role": "sink",
        "members": [
            {"local_id": "red", "revision_id": member},
            {"local_id": "green", "revision_id": member},
        ],
        "contacts": [
            {
                "contact_id": "red-tip",
                "member_id": "red",
                "member_contact_id": "1",
                "basis": "Independent red input requirement",
            },
            {
                "contact_id": "green-tip",
                "member_id": "green",
                "member_contact_id": "1",
                "basis": "Independent green input requirement",
            },
        ],
        "composition_basis": "Independent requirements; two real connector occurrences",
    }


@pytest.fixture
def member(users, project):
    owner = users["owner"]
    signals = frozen(owner, project, examples.av_signal_set(), "Synthetic signals")
    body = frozen(owner, project, examples.round_din_10_socket(), "Synthetic body")
    variant = examples.console_pinout(signals, body, "Console A AV")
    variant["role"] = "sink"
    return frozen(owner, project, variant, "Synthetic member pinout")


def test_composed_contact_validation_is_distinct_from_fictional_body():
    member = "00000000-0000-0000-0000-000000000001"
    port = Port.model_validate(composed(member))
    assert port.pinout_revision_id is None
    for update in [
        {"schema_version": "0.2"},
        {"pinout_revision_id": member},
        {"selected_conditions": {"region": "one"}},
    ]:
        with pytest.raises(ValidationError):
            Port.model_validate({**composed(member), **update})
    bad = composed(member)
    bad["contacts"][0]["member_id"] = "missing"
    with pytest.raises(ValidationError):
        Port.model_validate(bad)


def test_individual_port_serializer_does_not_add_composition_fields():
    port = Port.model_validate(
        {
            "kind": "port",
            "device_label": "Synthetic",
            "pinout_revision_id": "00000000-0000-0000-0000-000000000001",
        }
    )
    assert not {"members", "contacts", "composition_basis"} & set(port.model_dump(mode="json"))


def test_repeated_exact_members_retain_logical_identity_closure_and_authority(
    users, project, member
):
    revision = frozen(users["owner"], project, composed(member), "Synthetic composed sink")
    end = end_expectations(users["viewer"], revision)
    assert end["body_revision_id"] is None and end["pinout_revision_id"] is None
    assert [r["contact_id"] for r in end["rows"]] == ["red-tip", "green-tip"]
    assert [r["member"]["local_id"] for r in end["rows"]] == ["red", "green"]
    assert end["rows"][0]["signal"] == end["rows"][1]["signal"]
    assert end["composition"]["members"][0]["revision_id"] == member
    with pytest.raises(NotFound):
        end_expectations(users["outsider"], revision)
    broken = composed(member)
    broken["contacts"][0]["member_contact_id"] = "missing"
    with pytest.raises(ValidationFailed):
        create(users["owner"], project, broken)
    # A nested composition cannot silently flatten member identity.
    with pytest.raises(ValidationFailed):
        create(users["owner"], project, composed(revision))
