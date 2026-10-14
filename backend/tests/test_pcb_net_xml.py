"""Synthetic parser oracles; these tests do not claim native execution."""

import hashlib
import json
from uuid import UUID

import pytest

from specmate.pcb_disagreement.pack import recipe_for
from specmate.pcb_disagreement.xml_extract import MAX_XML_BYTES, ExtractionError, normalize_xml

SOURCE_SHA = "a" * 64


def component(ref, identity, pins=("1",), unit="A"):
    return f'''<comp ref="{ref}"><tstamps>{UUID(int=identity)}</tstamps>
      <sheetpath names="/" tstamps="/"/><units><unit name="{unit}"><pins>
      {"".join(f'<pin num="{pin}"/>' for pin in pins)}</pins></unit></units></comp>'''


def document(components=None, nodes=None):
    if components is None:
        components = component("J1", 1) + component("R1", 2, ("1", "2")) + component("J2", 3)
    if nodes is None:
        nodes = """<net code="1" name="SENSE"><node ref="J1" pin="1"/><node ref="R1" pin="1"/></net>
        <net code="2" name="RETURN"><node ref="R1" pin="2"/><node ref="J2" pin="1"/></net>"""
    return f"""<?xml version="1.0" encoding="UTF-8"?><export version="E">
      <design><tool>Eeschema 10.0.6</tool><sheet number="1" name="/" tstamps="/"/></design>
      <components>{components}</components><nets>{nodes}</nets></export>""".encode()


def test_independent_net_oracle_and_source_scoped_identity_without_terminal_uuid():
    raw = document()
    report = normalize_xml(raw, SOURCE_SHA)
    assert report["xml_sha256"] == hashlib.sha256(raw).hexdigest()
    assert {(t["component_ref"], t["pin"], t["net_name"]) for t in report["terminals"]} == {
        ("J1", "1", "SENSE"),
        ("R1", "1", "SENSE"),
        ("R1", "2", "RETURN"),
        ("J2", "1", "RETURN"),
    }
    assert all(t["native_terminal_id"] is None for t in report["terminals"])
    assert all(t["unit"] == "A" and t["sheet_path"] == "/" for t in report["terminals"])
    old = {t["local_id"] for t in report["terminals"]}
    changed_source = {t["local_id"] for t in normalize_xml(raw, "b" * 64)["terminals"]}
    assert not old.intersection(changed_source)


def test_omitted_membership_unknown_and_uninterpreted_metadata_retained_as_coverage():
    raw = document(nodes="").replace(b"</export>", b"<future semantic='unknown'/></export>")
    report = normalize_xml(raw, SOURCE_SHA)
    assert all(t["net_state"] == "unknown" and t["net_name"] is None for t in report["terminals"])
    assert "Uninterpreted XML element: future" in report["unsupported"]


def test_duplicate_labels_and_multiunit_pin_numbers_never_guess_node_assignment():
    for components in (
        component("J1", 1) + component("J1", 2),
        component("J1", 1).replace(
            "</units>", '<unit name="B"><pins><pin num="1"/></pins></unit></units>'
        ),
    ):
        report = normalize_xml(
            document(components, '<net code="1" name="N"><node ref="J1" pin="1"/></net>'),
            SOURCE_SHA,
        )
        assert len(report["terminals"]) == 2
        assert len({t["local_id"] for t in report["terminals"]}) == 2
        assert all(t["net_state"] == "unknown" for t in report["terminals"])
        assert "Ambiguous or missing net node: J1.1" in report["unsupported"]


def multiunit(ref, uuids, units=("A", "B", "C")):
    body = "".join(
        f'<unit name="{u}"><pins><pin num="{n}"/></pins></unit>'
        for u, n in zip(units, "123", strict=False)
    )
    return (
        f'<comp ref="{ref}"><tstamps>{" ".join(uuids)}</tstamps>'
        f'<sheetpath names="/" tstamps="/"/><units>{body}</units></comp>'
    )


def test_multiunit_space_separated_uuids_map_one_per_unit_with_stable_identities():
    ids = [str(UUID(int=0x100 + i)) for i in range(3)]
    raw = document(
        component("J1", 1) + multiunit("RN1", ids),
        '<net code="1" name="N1"><node ref="RN1" pin="2"/><node ref="J1" pin="1"/></net>',
    )
    report = normalize_xml(raw, SOURCE_SHA)
    rn = {t["unit"]: t for t in report["terminals"] if t["component_ref"] == "RN1"}
    assert {u: t["native_component_id"] for u, t in rn.items()} == dict(
        zip("ABC", ids, strict=True)
    )
    # Independently derived: identity is sha256 of the JSON tuple of exact source facts.
    for unit, number in zip("ABC", "123", strict=True):
        tup = [SOURCE_SHA, ids["ABC".index(unit)], "/", unit, number]
        assert (
            rn[unit]["local_id"]
            == "terminal-" + hashlib.sha256(json.dumps(tup).encode()).hexdigest()
        )
    assert rn["B"]["net_name"] == "N1" and rn["A"]["net_state"] == "unknown"
    again = normalize_xml(raw.replace(b"<tstamps>", b"<tstamps> "), SOURCE_SHA)
    assert {t["local_id"] for t in again["terminals"]} == {
        t["local_id"] for t in report["terminals"]
    }


@pytest.mark.parametrize(
    ("uuids", "code"),
    [
        ([str(UUID(int=5)), str(UUID(int=6))], "component-uuid-unit-mismatch"),
        ([str(UUID(int=5)), "not-a-uuid", str(UUID(int=7))], "component-uuid-invalid"),
        ([], "component-uuid-missing"),
    ],
)
def test_malformed_multiunit_uuid_lists_fail_with_named_diagnostic(uuids, code):
    with pytest.raises(ExtractionError, match=rf"^\[{code}\]") as caught:
        normalize_xml(document(multiunit("RN1", uuids)), SOURCE_SHA)
    assert caught.value.code == code


def test_uuid_shared_between_components_is_a_named_duplicate():
    ids = [str(UUID(int=0x200 + i)) for i in range(3)]
    with pytest.raises(ExtractionError, match="component-uuid-duplicated"):
        normalize_xml(document(multiunit("RN1", ids) + multiunit("RN2", ids)), SOURCE_SHA)


@pytest.mark.parametrize(
    "raw",
    [
        b'<!DOCTYPE export [<!ENTITY bad SYSTEM "file:///etc/passwd">]>'
        b'<export version="E">&bad;</export>',
        document().replace(b'<export version="E">', b'<export xmlns="urn:untrusted" version="E">'),
        document().replace(b'version="E"', b'version="D"'),
        document().replace(
            b'<net code="1"', b'<net xmlns:x="urn:untrusted" x:meaning="net" code="1"'
        ),
        document().decode().encode("utf-16"),
        document().replace(b'<unit name="A">', b"<unit>"),
        document().replace(b'tstamps="/"', b'tstamps="/unknown/"'),
        document().replace(
            b"<tstamps>00000000-0000-0000-0000-000000000001</tstamps>", b"<tstamps/>"
        ),
        document().replace(b"<units>", b"<missing>").replace(b"</units>", b"</missing>"),
        document(component("J1", 1) + component("J2", 1)),
        document(component("J1", 1, ("1", "1"))),
        document(
            nodes='<net code="1" name="N"><node ref="J1" pin="1"/><node ref="J1" pin="1"/></net>'
        ),
        document().replace(b'<net code="2" name="RETURN">', b'<net code="1" name="RETURN">'),
        document().replace(b'<net code="2" name="RETURN">', b'<net code="2" name="SENSE">'),
        b"x" * (MAX_XML_BYTES + 1),
        document().replace(b"</export>", b"<nested>" * 22 + b"</nested>" * 22 + b"</export>"),
        document().replace(b"</export>", b"<field/>" * 20000 + b"</export>"),
        document(component("J1", 1, tuple(str(i) for i in range(2001)))),
    ],
)
def test_unsafe_unsupported_ambiguous_and_bounded_inputs_fail(raw):
    with pytest.raises((ValueError, UnicodeError)):
        normalize_xml(raw, SOURCE_SHA)


def test_recipe_pins_program_outputs_source_role_and_no_network():
    recipe = recipe_for("original.kicad_sch", "test-only", "schematic")
    from specmate.builds.recipes import Recipe

    Recipe.model_validate(recipe)
    compile(recipe["argv"][2], "<trusted-loader>", "exec")
    assert recipe["network"] == "none"
    assert "@sha256:" in recipe["image"]
    assert recipe["argv"][-4:] == [
        "schematic",
        "/inputs/original.kicad_sch",
        "/outputs/source-net-assertions.json",
        "/outputs/source-nets.xml",
    ]
    assert len(recipe["outputs"]) == 2
    assert recipe["id"] != recipe_for("original.kicad_sch", "test-only", "netlist")["id"]
    for path, role in (
        ("../escape", "netlist"),
        ("board.kicad_pcb", "schematic"),
        ("a.xml", "unknown"),
    ):
        with pytest.raises(ValueError):
            recipe_for(path, "test-only", role)
