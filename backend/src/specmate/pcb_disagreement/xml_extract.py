"""Bounded KiCad XML E normalization; never executes source content.

This module is also copied verbatim into the trusted, isolated pack program.
It accepts the standalone/root-sheet subset demonstrated by the native fixture.
"""

import hashlib
import json
import re
import xml.etree.ElementTree as ET
from collections import Counter
from uuid import UUID

MAX_XML_BYTES = 2 * 1024**2
MAX_TERMINALS = 2000
ADAPTER = "kicad-net-assertions-v1"

# Unknown metadata is retained in the original XML and reported as unsupported.
ATTRIBUTES = {
    "export": {"version"},
    "design": set(),
    "source": set(),
    "date": set(),
    "tool": set(),
    "sheet": {"number", "name", "tstamps"},
    "title_block": set(),
    "title": set(),
    "company": set(),
    "rev": set(),
    "comment": {"number", "value"},
    "components": set(),
    "comp": {"ref"},
    "value": set(),
    "footprint": set(),
    "datasheet": set(),
    "description": set(),
    "fields": set(),
    "field": {"name"},
    "libsource": {"lib", "part", "description"},
    "property": {"name", "value"},
    "sheetpath": {"names", "tstamps"},
    "tstamps": set(),
    "units": set(),
    "unit": {"name"},
    "pins": set(),
    "pin": {"num", "name", "type"},
    "libparts": set(),
    "libpart": {"lib", "part"},
    "libraries": set(),
    "library": {"logical"},
    "uri": set(),
    "nets": set(),
    "net": {"code", "name", "class"},
    "node": {"ref", "pin", "pinfunction", "pintype"},
}


class ExtractionError(ValueError):
    """A named, bounded diagnostic; the code prefix is stable for display and tests."""

    def __init__(self, code, message):
        super().__init__(f"[{code}] {message}")
        self.code = code


def unit_identities(ref, native_text, unit_names):
    """Map KiCad's space-separated per-unit tstamps onto units, in unit order.

    One UUID is shared by every unit; otherwise there must be exactly one per unit.
    """
    tokens = (native_text or "").split()
    if len(tokens) > 200:
        raise ExtractionError(
            "component-uuid-unit-mismatch", f"Component {ref} lists too many UUIDs."
        )
    if not tokens:
        raise ExtractionError("component-uuid-missing", f"Component {ref} has no UUID.")
    for token in tokens:
        try:
            canonical = str(UUID(token)) == token
        except ValueError:
            canonical = False
        if not canonical:
            raise ExtractionError(
                "component-uuid-invalid",
                f"Component {ref} has a UUID that is not canonical: {token[:60]!r}.",
            )
    if len(tokens) == 1:
        return {name: tokens[0] for name in unit_names}
    if len(tokens) != len(unit_names):
        raise ExtractionError(
            "component-uuid-unit-mismatch",
            f"Component {ref} lists {len(tokens)} UUIDs for {len(unit_names)} units.",
        )
    return dict(zip(unit_names, tokens, strict=True))


def exact_one(parent, name):
    matches = parent.findall(name)
    if len(matches) != 1:
        raise ValueError(f"Expected one {name} element")
    return matches[0]


def bounded(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 500:
        raise ValueError("Missing or oversized native identity/name")
    return value


def normalize_xml(raw, source_sha256):
    if not isinstance(source_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", source_sha256):
        raise ValueError("Exact source SHA-256 is required")
    if not raw or len(raw) > MAX_XML_BYTES:
        raise ValueError("XML is empty or exceeds the byte bound")
    text = raw.decode("utf-8", errors="strict")
    if "<!" in text or "\x00" in text:
        raise ValueError("DTD, entities, declarations and non-UTF-8 XML are unsupported")
    root = ET.fromstring(text)  # noqa: S314 — UTF-8, DTD/entity rejection and byte bound above
    if root.tag != "export" or root.attrib != {"version": "E"}:
        raise ValueError("Only KiCad XML export version E is supported")
    unsupported = set()
    stack = [(root, 0)]
    count = 0
    while stack:
        node, depth = stack.pop()
        count += 1
        if count > 20000 or depth > 20:
            raise ValueError("XML structural bound exceeded")
        if not isinstance(node.tag, str) or "{" in node.tag or ":" in node.tag:
            raise ValueError("XML namespaces are unsupported")
        if any("{" in key or ":" in key for key in node.attrib):
            raise ValueError("XML attribute namespaces are unsupported")
        if len(node.tag) > 100 or len(node.attrib) > 30:
            raise ValueError("XML name/attribute bound exceeded")
        if any(len(k) > 100 or len(v) > 2000 for k, v in node.attrib.items()):
            raise ValueError("XML attribute bound exceeded")
        if node.text and len(node.text) > 2000:
            raise ValueError("XML text bound exceeded")
        if node.tag not in ATTRIBUTES:
            unsupported.add("Uninterpreted XML element: " + node.tag)
        else:
            for key in node.attrib.keys() - ATTRIBUTES[node.tag]:
                unsupported.add("Uninterpreted XML attribute: " + node.tag + "/" + key)
        if len(unsupported) > 100:
            raise ValueError("Unsupported XML metadata bound exceeded")
        stack.extend((child, depth + 1) for child in node)
    design = exact_one(root, "design")
    sheets = design.findall("sheet")
    if len(sheets) != 1 or sheets[0].get("name") != "/" or sheets[0].get("tstamps") != "/":
        raise ValueError("Only the qualified standalone root sheet is supported")
    components = exact_one(root, "components")
    nets = exact_one(root, "nets")
    terminals = []
    component_ids = set()
    refs = Counter(c.get("ref") for c in components.findall("comp"))
    identities = set()
    for component in components.findall("comp"):
        ref = bounded(component.get("ref"))
        raw_ids = exact_one(component, "tstamps").text
        path = exact_one(component, "sheetpath")
        if path.get("names") != "/" or path.get("tstamps") != "/":
            raise ValueError("Hierarchical component occurrence is unsupported")
        units = exact_one(component, "units")
        if not units.findall("unit"):
            raise ValueError("Component unit pin inventory is absent")
        unit_names = [bounded(u.get("name")) for u in units.findall("unit")]
        if len(set(unit_names)) != len(unit_names):
            raise ExtractionError(
                "component-unit-duplicated", f"Component {ref} repeats a unit name."
            )
        unit_ids = unit_identities(ref, raw_ids, unit_names)
        for native_id in set(unit_ids.values()):
            if native_id in component_ids:
                raise ExtractionError(
                    "component-uuid-duplicated", f"Component UUID is duplicated: {native_id}."
                )
            component_ids.add(native_id)
        for unit in units.findall("unit"):
            unit_name = bounded(unit.get("name"))
            native_id = unit_ids[unit_name]
            for pin in exact_one(unit, "pins").findall("pin"):
                number = bounded(pin.get("num"))
                identity = (source_sha256, native_id, path.get("tstamps"), unit_name, number)
                if identity in identities:
                    raise ValueError("Duplicated component/unit/pin occurrence")
                identities.add(identity)
                digest = hashlib.sha256(json.dumps(identity).encode()).hexdigest()
                terminals.append(
                    {
                        "local_id": "terminal-" + digest,
                        "component_ref": ref,
                        "pin": number,
                        "native_component_id": native_id,
                        "native_terminal_id": None,
                        "sheet_path": "/",
                        "unit": unit_name,
                        "net_state": "unknown",
                        "net_name": None,
                        "basis": "KiCad XML unit pin inventory; terminal UUID is not exported",
                    }
                )
                if len(terminals) > MAX_TERMINALS:
                    raise ValueError("Terminal inventory bound exceeded")
    by_label = {}
    for terminal in terminals:
        by_label.setdefault((terminal["component_ref"], terminal["pin"]), []).append(terminal)
    assigned = set()
    net_codes = set()
    net_names = set()
    for net in nets.findall("net"):
        code, name = bounded(net.get("code")), bounded(net.get("name"))
        if code in net_codes or name in net_names:
            raise ValueError("Repeated net code/name is ambiguous")
        net_codes.add(code)
        net_names.add(name)
        for node in net.findall("node"):
            key = (bounded(node.get("ref")), bounded(node.get("pin")))
            candidates = by_label.get(key, [])
            if len(candidates) != 1 or refs[key[0]] != 1:
                unsupported.add("Ambiguous or missing net node: " + ".".join(key))
                continue
            terminal = candidates[0]
            if terminal["local_id"] in assigned:
                raise ValueError("A terminal is assigned more than once")
            assigned.add(terminal["local_id"])
            # KiCad auto-generated unconnected names are not explicit NC proof.
            terminal.update(
                net_state="assigned",
                net_name=name,
                basis="Reported KiCad XML net membership; not routed copper or continuity proof",
            )
    unsupported.update(
        [
            "Terminal UUIDs are not exported; component UUID, sheet, unit and pin "
            "identify inventory occurrences",
            "Omitted net membership remains unknown, not an explicit no-connect assertion",
            "Component behavior, ERC, routed copper, manufacturing and physical "
            "qualification are not evaluated",
            "Hierarchical sheets, variants and alternative XML versions are unsupported",
            "Library metadata, symbol geometry and electrical pin types are retained "
            "but not interpreted",
        ]
    )
    if len(unsupported) > 200:
        raise ValueError("Unsupported semantics bound exceeded")
    return {
        "xml_sha256": hashlib.sha256(raw).hexdigest(),
        "xml_version": "E",
        "reported_source_tool": design.findtext("tool"),
        "coverage": "root_unit_pin_inventory",
        "terminals": sorted(terminals, key=lambda t: t["local_id"]),
        "unsupported": sorted(unsupported),
    }
