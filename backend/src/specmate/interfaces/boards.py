"""Board terminals and declared paths: closure checks, inspection, interpretation, proposal.

Board paths are interpreted by the existing passive-passage interpreter over a small
board-local graph; nothing here re-implements electrical arithmetic. A KiCad proposal is
returned for review and never stored or accepted by this module.
"""

import json
import re
from decimal import Decimal

from pydantic import ValidationError

from specmate.catalog_matching.queries import current_actor
from specmate.design.models import Revision
from specmate.design.pins import check_pin
from specmate.interfaces.board_contracts import (
    Board,
    InlineComponent,
    ProposeBoard,
    TraceBoard,
    component_passage,
)
from specmate.operations import NotFound, ValidationFailed
from specmate.passive_passages.interpretation import interpret

DECLARED_COPPER = "declared_copper"
REPORTED_NET = "reported_net_membership"


# ---------------------------------------------------------------- closure checks


def board_references(board):
    refs = [c.body_revision_id for c in board.carried_connectors]
    if board.derived_from is not None:
        refs.append(board.derived_from.population_revision_id)
    return refs


def population_report(user, revision, content):
    from specmate.pcb.population import review_payload

    return review_payload(user, revision.definition, content)


def validate_board(closure, board):
    from specmate.interfaces.contracts import ConnectorBody

    for connector in board.carried_connectors:
        body = closure.values.get(connector.body_revision_id)
        if not isinstance(body, ConnectorBody):
            raise ValidationFailed("A carried connector must be an exact connector body revision.")
        contacts = {c.contact_id for c in body.contacts if c.physical_role != "key"}
        for pair in connector.correspondence:
            if pair.contact_id not in contacts:
                raise ValidationFailed(
                    "A correspondence must name a contact of the carried connector."
                )
    origin = board.derived_from
    if origin is not None:
        revision = closure.revisions.get(origin.population_revision_id)
        if revision is None or revision.definition.kind != "pcb_population":
            raise ValidationFailed("A KiCad-derived board pins an exact PCB population revision.")
        review = population_report(
            closure.user, revision, closure.contents[origin.population_revision_id]
        )
        interpretation = review["interpretation"]
        if (
            interpretation["interpretation_id"] != str(origin.interpretation_id)
            or interpretation["sha256"] != origin.interpretation_sha256
        ):
            raise ValidationFailed("The board origin does not match the population's exact report.")
        pads = {pad["id"] for pad in review["report"]["pads"]}
        for terminal in board.terminals:
            if any(str(pad) not in pads for pad in terminal.native_pad_ids):
                raise ValidationFailed("A native pad does not exist in the pinned interpretation.")


# ---------------------------------------------------------------- inspection


def component_text(component):
    parts = [component.reference, component.value]
    if component.kind != "unknown":
        parts.append(component.kind)
    return " ".join(p for p in parts if p) or "component, unknown"


def path_summary(path, board):
    if path.via == "copper":
        return "Straight copper" if path.provenance == "declared" else "Same native net"
    if path.via == "component":
        return component_text(path.component)
    if path.via == "switch":
        condition = next(c for c in board.conditions if c.key == path.switch.condition_key)
        choice = next(x for x in condition.choices if x.key == path.switch.closed_when)
        return f"{condition.name}: closed in {choice.name}"
    return "Unknown"


def board_view(board, closure):
    """Labels with exact identities: carried contacts, paths and terminals without a path."""
    labels = {t.terminal_id: t.label for t in board.terminals}
    landings = {}
    connectors = []
    for connector in board.carried_connectors:
        body = closure.values[connector.body_revision_id]
        revision = closure.revisions[connector.body_revision_id]
        contacts = {c.contact_id: c for c in body.contacts if c.physical_role != "key"}
        # Unreviewed correspondence is a proposal: unknown, never an established landing.
        status = "reviewed" if connector.review == "reviewed" else "unknown"
        for pair in connector.correspondence:
            contact = contacts[pair.contact_id]
            landings.setdefault(pair.terminal_id, []).append(
                {
                    "connector_id": connector.local_id,
                    "body_name": revision.definition.name,
                    "contact_id": contact.contact_id,
                    "number": contact.number,
                    "label": contact.label,
                    "status": status,
                }
            )
        landed = {p.contact_id for p in connector.correspondence}
        connectors.append(
            {
                **connector.model_dump(mode="json"),
                "body_name": revision.definition.name,
                "body_revision_number": revision.number,
                "mating_role": body.mating_role,
                "status": status,
                "contacts_without_terminal": [c for c in contacts if c not in landed],
            }
        )
    by_terminal = {}
    paths = []
    for path in board.paths:
        by_terminal.setdefault(path.from_terminal, []).append(path.local_id)
        by_terminal.setdefault(path.to_terminal, []).append(path.local_id)
        paths.append(
            {
                **path.model_dump(mode="json"),
                "from_label": labels[path.from_terminal],
                "to_label": labels[path.to_terminal],
                "summary": path_summary(path, board),
                "evidence": REPORTED_NET
                if path.provenance == "reported_net_membership"
                else "declared",
            }
        )
    terminals = [
        {
            **t.model_dump(mode="json"),
            "landings": landings.get(t.terminal_id, []),
            "path_ids": by_terminal.get(t.terminal_id, []),
            # No declared path is not "unconnected": it is simply not known.
            "connection": "declared" if t.terminal_id in by_terminal else "unknown",
        }
        for t in board.terminals
    ]
    return {
        "origin": board.origin,
        "derived_from": board.derived_from.model_dump(mode="json") if board.derived_from else None,
        "review": board.review,
        "terminals": terminals,
        "connectors": connectors,
        "paths": paths,
        "continuity": "not_evaluated",
        "physical_qualification": "not_evaluated",
    }


# ---------------------------------------------------------------- interpretation


def board_model(board):
    """The board as a passive-interpreter graph and declared model (terminal IDs as nodes)."""
    nodes = [{"id": t.terminal_id} for t in board.terminals]
    edges, passages = [], []
    for path in board.paths:
        evidence = REPORTED_NET if path.provenance == "reported_net_membership" else DECLARED_COPPER
        provenance = {"path_id": path.local_id, "provenance": path.provenance}
        if path.via == "copper":
            edges.append(
                {
                    "id": f"copper:{path.local_id}",
                    "kind": "board_copper",
                    "members": [path.from_terminal, path.to_terminal],
                    "basis": path.basis,
                    "evidence": evidence,
                    "provenance": provenance,
                }
            )
            continue
        if path.via == "component":
            record = component_passage(
                path.component,
                path.local_id,
                path.from_terminal,
                path.to_terminal,
                path.basis,
                path.provenance,
            )
        else:
            record = component_passage(
                InlineComponent(),
                path.local_id,
                path.from_terminal,
                path.to_terminal,
                path.basis,
                path.provenance,
            )
            if path.via == "switch":
                record["kind"] = "conditional"
                record["conditional_contact"] = {
                    "condition_id": path.switch.condition_key,
                    "state": path.switch.closed_when,
                    "behavior": "ideal_contact",
                }
        record["provenance"] = provenance
        passages.append(record)
    graph = {"nodes": nodes, "edges": edges, "boundaries": []}
    model = {
        "assumptions": "ideal_lumped_components",
        "model_basis": "Declared board paths; values are declarations, not measurements.",
        "conditions": [
            {"local_id": c.key, "states": [x.key for x in c.choices]} for c in board.conditions
        ],
        "passages": passages,
    }
    return graph, model


def trace_board(user, query: TraceBoard):
    from specmate.interfaces.queries import read_revision

    revision, closure = read_revision(user, query.revision_id)
    board = closure.root
    if not isinstance(board, Board):
        raise ValidationFailed("Board paths require a board revision.")
    terminals = {t.terminal_id: t for t in board.terminals}
    if query.from_terminal_id not in terminals or query.to_terminal_id not in terminals:
        raise NotFound("Board terminal not found.")
    graph, model = board_model(board)
    try:
        result = interpret(graph, model, query)
    except ValueError as exc:
        raise ValidationFailed(str(exc)) from None
    labels = {k: t.label for k, t in terminals.items()}
    for path in result["paths"]:
        path["terminal_labels"] = [labels[t] for t in path["terminal_ids"]]
    return {
        "revision_id": str(revision.id),
        "from_terminal_id": query.from_terminal_id,
        "to_terminal_id": query.to_terminal_id,
        **result,
    }


# ---------------------------------------------------------------- KiCad proposal


def _slug(text):
    slug = re.sub(r"[^a-z0-9_.-]+", "-", text.casefold()).strip("-.")
    return (slug or "pad")[:56]


def _label(pad):
    net = (pad["net"] or "").lstrip("/")
    # Generated net names describe a pad, not a board label.
    if net and not net.startswith(("Net-(", "unconnected-")) and len(net) <= 200:
        return net
    return pad["terminal"]


def _side(layers):
    if "*.Cu" in layers or ("F.Cu" in layers and "B.Cu" in layers):
        return "both"
    if "F.Cu" in layers:
        return "top"
    if "B.Cu" in layers:
        return "bottom"
    return "unknown"


def _natural(text):
    return [(0, int(x), "") if x.isdigit() else (1, 0, x) for x in re.split(r"(\d+)", text) if x]


PAD_KINDS = {"smd": "solder_pad", "pth": "through_hole", "connector": "connector_contact"}


def propose_board(user, p: ProposeBoard):
    """Terminals and paths proposed from one frozen population revision, for explicit review."""
    from specmate.interfaces.contracts import Pinout
    from specmate.interfaces.queries import parse_content

    user = current_actor(user)
    revision = (
        Revision.objects.select_related("definition", "snapshot")
        .filter(id=p.population_revision_id)
        .first()
    )
    scope = check_pin(user, revision)
    if revision.definition.kind != "pcb_population":
        raise ValidationFailed("A board proposal starts from a frozen PCB population revision.")
    content = json.loads(bytes(revision.snapshot.canonical))["content"]
    review = population_report(user, revision, content)
    report = review["report"]
    components = {c["id"]: c for c in report["components"]}
    pads = [pad for pad in report["pads"] if pad["type"] != "npth"]
    ports = {}
    for row in review["population"]["associations"]:
        association = row["association"]
        if association["kind"] == "port" and association["review"] != "rejected":
            ports[association["pad_id"]] = association
    associated = {pad["component_id"] for pad in pads if pad["id"] in ports}
    if p.component_ids is None:
        selected = {
            pad["component_id"]
            for pad in pads
            if pad["id"] in ports and ports[pad["id"]]["review"] == "accepted"
        }
    else:
        selected = {str(c) for c in p.component_ids}
        if not selected <= set(components):
            raise ValidationFailed("A selected component is not in the pinned interpretation.")
    chosen = sorted(
        (pad for pad in pads if pad["component_id"] in selected),
        key=lambda pad: (
            _natural(components[pad["component_id"]]["reference"]),
            _natural(pad["number"]),
        ),
    )
    terminals, terminal_of, used = [], {}, set()
    for pad in chosen:
        component = components[pad["component_id"]]
        base = _slug(f"{component['reference']}-{pad['number']}")
        key, n = base, 2
        while key in used:
            key, n = f"{base}-{n}", n + 1
        used.add(key)
        terminal_of[pad["id"]] = key
        terminals.append(
            {
                "terminal_id": key,
                "label": _label(pad),
                "group": component["reference"] or None,
                "kind": PAD_KINDS.get(pad["type"], "unknown"),
                "side": _side(pad["layers"]),
                "native_pad_ids": [pad["id"]],
                "note": f"Pad {pad['terminal']}"[:200],
            }
        )
    # Carried connectors from port associations: the association pins a pinout variant;
    # the board carries that variant's body. Correspondence stays unreviewed.
    connectors = {}
    for pad in chosen:
        association = ports.get(pad["id"])
        if association is None:
            continue
        target = (
            Revision.objects.select_related("definition", "snapshot")
            .filter(id=association["target_revision_id"])
            .first()
        )
        check_pin(user, target, scope)
        pinout = parse_content(json.loads(bytes(target.snapshot.canonical))["content"])
        if not isinstance(pinout, Pinout):
            continue
        body = str(pinout.body_revision_id)
        connector = connectors.setdefault(
            body,
            {
                "local_id": f"connector-{len(connectors) + 1}",
                "body_revision_id": body,
                "correspondence": [],
                "review": "unreviewed",
            },
        )
        if all(
            c["contact_id"] != association["target_contact_id"] for c in connector["correspondence"]
        ):
            connector["correspondence"].append(
                {
                    "terminal_id": terminal_of[pad["id"]],
                    "contact_id": association["target_contact_id"],
                }
            )
    # Copper paths from reported net membership among the chosen terminals.
    on_net = {}
    for pad in chosen:
        if pad["net"]:
            on_net.setdefault(pad["net"], []).append(terminal_of[pad["id"]])
    paths = []
    for net in sorted(on_net):
        first, *others = on_net[net]
        for other in others:
            paths.append(
                {
                    "local_id": f"net-{len(paths) + 1}",
                    "from_terminal": first,
                    "to_terminal": other,
                    "via": "copper",
                    "provenance": "reported_net_membership",
                    "basis": f"Proposed: native net {net} lists both pads; routed copper is "
                    "not proven.",
                }
            )
    # Component paths from native passages whose two nets reach chosen terminals.
    pad_by_terminal = {pad["terminal"]: pad for pad in report["pads"]}
    unmapped = []
    for index, passage in enumerate(report["component_passages"]):
        ends = [pad_by_terminal.get(passage["from"]), pad_by_terminal.get(passage["to"])]
        component = components.get(ends[0]["component_id"]) if ends[0] else None
        reached = [
            on_net.get(pad["net"], [None])[0] if pad and pad["net"] else None for pad in ends
        ]
        if None in reached or reached[0] == reached[1]:
            unmapped.append(
                {
                    "passage": passage,
                    "reference": component["reference"] if component else None,
                    "reason": "Both sides must reach different chosen terminals through "
                    "their native nets.",
                }
            )
            continue
        resistance = Decimal(str(passage["resistance_ohm"]))
        value = component["value"] if component else None
        try:
            part = InlineComponent(
                kind="resistor",
                value=value or None,
                reference=component["reference"] if component else None,
                resistance_ohm=resistance,
            )
        except ValidationError:
            part = InlineComponent(kind="resistor", resistance_ohm=resistance)
        paths.append(
            {
                "local_id": f"passage-{index + 1}",
                "from_terminal": reached[0],
                "to_terminal": reached[1],
                "via": "component",
                "component": part.model_dump(mode="json"),
                "provenance": "native_component_passage",
                "basis": f"Proposed: native component passage {passage['from']} to "
                f"{passage['to']}; review before use.",
            }
        )
    interpretation = review["interpretation"]
    board = Board.model_validate(
        {
            "origin": "kicad_derived",
            "derived_from": {
                "population_revision_id": str(revision.id),
                "interpretation_id": interpretation["interpretation_id"],
                "interpretation_sha256": interpretation["sha256"],
            },
            "terminals": terminals,
            "carried_connectors": list(connectors.values()),
            "paths": paths,
            "review": "unreviewed",
        }
    )
    return {
        "status": "proposed",
        "review": "required",
        "population_revision_id": str(revision.id),
        "population_name": revision.definition.name,
        "population_revision_number": revision.number,
        "board": board.model_dump(mode="json"),
        "components": sorted(
            (
                {
                    "component_id": c["id"],
                    "reference": c["reference"],
                    "value": c["value"],
                    "footprint": c["footprint"],
                    "pad_count": sum(1 for pad in pads if pad["component_id"] == c["id"]),
                    "port_association": c["id"] in associated,
                    "selected": c["id"] in selected,
                }
                for c in components.values()
            ),
            key=lambda c: _natural(c["reference"]),
        ),
        "unmapped_passages": unmapped,
        "limitations": [
            "Native net membership is reported, not proven routed copper.",
            "Only resistor passages are proposed; other components need declared paths.",
            "Connector correspondence and every path stay unreviewed until a person reviews them.",
        ],
    }
