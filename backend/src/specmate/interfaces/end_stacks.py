"""Resolve an end stack against exact pinned revisions: layers, labeled terminals, joins.

Resolution never invents a connection. Explicit joins are declarations with a basis; a
board's carried-connector correspondence is traversable only when reviewed (otherwise it
reads unknown); board paths come from the board revision; an inline part's two terminals
are separated by the part itself. "Reaches" lists the connector contacts a terminal is
declared to lead to, with every step named, for display and checks. It is declared
topology, never measured continuity.
"""

from specmate.interfaces.board_contracts import Board
from specmate.interfaces.boards import component_text, path_summary
from specmate.interfaces.end_assembly_contracts import INLINE_PINS, SHELL_BODY, EndStack
from specmate.operations import ValidationFailed

MAX_REACH_STEPS = 6
MAX_REACHES = 8


def switch_contact_state(layer, path):
    """Ideal declared switch contact for this occurrence, never a measured state."""
    selected = layer.condition_states.get(path.switch.condition_key)
    return (
        "unknown"
        if selected is None
        else "declared"
        if selected == path.switch.closed_when
        else "open"
    )


def stack_references(stack: EndStack):
    refs = []
    for layer in stack.layers:
        if layer.kind == "connector":
            refs += [layer.body_revision_id, layer.pinout_revision_id]
        elif layer.kind == "board":
            refs.append(layer.board_revision_id)
        elif layer.kind == "shell" and layer.part_revision_id:
            refs.append(layer.part_revision_id)
        elif layer.kind == "inline":
            refs.extend(part.part_revision_id for part in layer.parts if part.part_revision_id)
    return refs


def contact_label(contact):
    number = contact.number or contact.contact_id
    return f"{number} {contact.label}" if contact.label and contact.label != number else number


class ResolvedStack:
    """One stack resolved against a lookup with ``values``, ``revisions`` and ``describe``."""

    def __init__(self, stack: EndStack, lookup):
        from specmate.interfaces.contracts import ConnectorBody, Pinout
        from specmate.interfaces.queries import pin_signals

        self.stack = stack
        self.lookup = lookup
        self.terminals = {}
        self.layers = []
        self.connectors = {}
        self.boards = {}
        self.edges = []
        for layer in stack.layers:
            view = {"layer_id": layer.layer_id, "kind": layer.kind}
            if layer.kind == "connector":
                body = lookup.values.get(layer.body_revision_id)
                pinout = lookup.values.get(layer.pinout_revision_id)
                if not isinstance(body, ConnectorBody) or not isinstance(pinout, Pinout):
                    raise ValidationFailed(
                        "A connector layer requires exact body and pinout revisions."
                    )
                if pinout.body_revision_id != layer.body_revision_id:
                    raise ValidationFailed(
                        "A connector layer's pinout must pin its exact body revision."
                    )
                self.connectors[layer.layer_id] = (layer, body, pinout)
                signals = pin_signals(pinout, lookup)
                notes = {a.contact_id: a.electrical for a in pinout.assignments}
                terminals = []
                for contact in body.contacts:
                    if contact.physical_role == "key":
                        continue
                    electrical = notes.get(contact.contact_id)
                    signal = signals.get(contact.contact_id)
                    terminals.append(
                        {
                            "terminal_id": contact.contact_id,
                            "label": contact_label(contact),
                            "kind": contact.physical_role,
                            "signal": signal["signal"] if signal else None,
                            "signal_status": signal["status"] if signal else "unknown",
                            "alternatives": signal["alternatives"] if signal else [],
                            "signal_note": electrical.signal if electrical else None,
                            "role": electrical.role if electrical else "unknown",
                        }
                    )
                view.update(
                    {
                        "body_revision_id": str(layer.body_revision_id),
                        "pinout_revision_id": str(layer.pinout_revision_id),
                        "name": self._name(layer.body_revision_id),
                        "pinout_name": self._name(layer.pinout_revision_id),
                        "variant_label": pinout.variant_label,
                        "mating_role": body.mating_role,
                    }
                )
            elif layer.kind == "board":
                board = lookup.values.get(layer.board_revision_id)
                if not isinstance(board, Board):
                    raise ValidationFailed(
                        "A board layer requires an exact board revision with declared pads."
                    )
                conditions = {c.key: {choice.key for choice in c.choices} for c in board.conditions}
                if any(
                    key not in conditions or state not in conditions[key]
                    for key, state in layer.condition_states.items()
                ):
                    raise ValidationFailed(
                        "Board condition selection requires an exact declared condition and choice."
                    )
                self.boards[layer.layer_id] = (layer, board)
                terminals = [
                    {
                        "terminal_id": t.terminal_id,
                        "label": t.label,
                        "group": t.group,
                        "kind": t.kind,
                    }
                    for t in board.terminals
                ]
                carried = None
                if layer.carried_connector_id:
                    carried = next(
                        (
                            c
                            for c in board.carried_connectors
                            if c.local_id == layer.carried_connector_id
                        ),
                        None,
                    )
                    if carried is None:
                        raise ValidationFailed("The board does not declare that carried connector.")
                view.update(
                    {
                        "board_revision_id": str(layer.board_revision_id),
                        "conditions": [c.model_dump(mode="json") for c in board.conditions],
                        "condition_states": layer.condition_states,
                        "name": self._name(layer.board_revision_id),
                        "carried_connector_id": layer.carried_connector_id,
                        "carried_connector_layer_id": layer.carried_connector_layer_id,
                        "carried_status": None
                        if carried is None
                        else "reviewed"
                        if carried.review == "reviewed"
                        else "unknown",
                        "internal_nodes": [n.model_dump(mode="json") for n in board.internal_nodes],
                        "paths": [
                            {
                                "local_id": p.local_id,
                                "from_terminal": p.from_terminal,
                                "to_terminal": p.to_terminal,
                                "via": p.via,
                                "summary": path_summary(p, board),
                                **(
                                    {"contact_state": switch_contact_state(layer, p)}
                                    if p.switch
                                    else {}
                                ),
                            }
                            for p in board.paths
                        ],
                    }
                )
            elif layer.kind == "inline":
                terminals = []
                parts = []
                for part in layer.parts:
                    name = part.label or part.component.reference or part.local_id
                    identity = {}
                    if part.part_revision_id:
                        revision = lookup.revisions.get(part.part_revision_id)
                        if revision is None or revision.definition.kind != "part":
                            raise ValidationFailed(
                                "An inline catalog pin requires an exact Part revision."
                            )
                        identity["part_identity"] = {
                            "revision_id": str(revision.id),
                            "definition_id": str(revision.definition_id),
                            "name": revision.definition.name,
                            "number": revision.number,
                            "package_pinout": "not_evaluated",
                            "declared_use": "two_lead_inline",
                            "behavior_source": "separate_authored_component",
                        }
                    parts.append(
                        {
                            "local_id": part.local_id,
                            "name": name,
                            "summary": component_text(part.component),
                            "component": part.component.model_dump(mode="json"),
                            **identity,
                        }
                    )
                    for pin in INLINE_PINS:
                        terminals.append(
                            {
                                "terminal_id": f"{part.local_id}.{pin}",
                                "label": f"{name} · {pin}",
                                "kind": "component_lead",
                                "part": part.local_id,
                            }
                        )
                view["parts"] = parts
                view["name"] = ", ".join(p["name"] for p in parts)
            else:
                terminals = [{"terminal_id": SHELL_BODY, "label": "Shell body", "kind": "shell"}]
                if layer.part_revision_id and layer.part_revision_id not in lookup.revisions:
                    raise ValidationFailed("A shell layer pins an exact part revision.")
                view.update(
                    {
                        "part_revision_id": str(layer.part_revision_id)
                        if layer.part_revision_id
                        else None,
                        "name": layer.label
                        or (self._name(layer.part_revision_id) if layer.part_revision_id else None),
                        "electrical": "none_unless_bonded",
                    }
                )
            for terminal in terminals:
                self.terminals[layer.layer_id, terminal["terminal_id"]] = terminal
            view["terminals"] = terminals
            self.layers.append(view)
        self.connector = next(iter(self.connectors.values())) if len(self.connectors) == 1 else None
        self.board = next(iter(self.boards.values())) if len(self.boards) == 1 else None
        for layer, board in self.boards.values():
            if not layer.carried_connector_id:
                continue
            connector_layer, _, _ = self.carried_target(layer)
            carried = next(
                c for c in board.carried_connectors if c.local_id == layer.carried_connector_id
            )
            if carried.body_revision_id != connector_layer.body_revision_id:
                raise ValidationFailed(
                    "The board's carried connector must be the stack's exact connector body."
                )
        self.joins = self._joins()
        self._edges()

    def carried_target(self, layer):
        if layer.carried_connector_layer_id:
            return self.connectors[layer.carried_connector_layer_id]
        # Contract validation permits implicit selection only for a singleton.
        return next(iter(self.connectors.values()))

    def _name(self, revision_id):
        revision = self.lookup.revisions.get(revision_id)
        if revision is None:
            return None
        return f"{revision.definition.name} r{revision.number}"

    def label(self, layer_id, terminal_id):
        return self.terminals[layer_id, terminal_id]["label"]

    def layer(self, layer_id):
        return next(layer for layer in self.stack.layers if layer.layer_id == layer_id)

    def require(self, layer_id, terminal_id, what="A join"):
        if (layer_id, terminal_id) not in self.terminals:
            raise ValidationFailed(f"{what} names a terminal its layer does not have.")

    def _joins(self):
        rows = []
        for join in self.stack.joins:
            for end in (join.a, join.b, *([join.through] if join.through else [])):
                self.require(end.layer_id, end.terminal_id)
            rows.append(
                {
                    "local_id": join.local_id,
                    "a": {**join.a.model_dump(mode="json"), "label": self.label(**dict(join.a))},
                    "b": {**join.b.model_dump(mode="json"), "label": self.label(**dict(join.b))},
                    **(
                        {
                            "through": {
                                **join.through.model_dump(mode="json"),
                                "label": self.label(**dict(join.through)),
                            }
                        }
                        if join.through
                        else {}
                    ),
                    "kind": join.kind,
                    "basis": join.basis,
                    "origin": "declared",
                    "status": "declared",
                }
            )
        for layer, board in self.boards.values():
            if not layer.carried_connector_id:
                continue
            connector_layer = self.carried_target(layer)[0]
            carried = next(
                c for c in board.carried_connectors if c.local_id == layer.carried_connector_id
            )
            status = "reviewed" if carried.review == "reviewed" else "unknown"
            for pair in carried.correspondence:
                rows.append(
                    {
                        "local_id": (
                            f"{layer.layer_id}:carried:{pair.terminal_id}"
                            if self.stack.graph_version == "0.2"
                            else f"carried:{pair.terminal_id}"
                        ),
                        "a": {
                            "layer_id": layer.layer_id,
                            "terminal_id": pair.terminal_id,
                            "label": self.label(layer.layer_id, pair.terminal_id),
                        },
                        "b": {
                            "layer_id": connector_layer.layer_id,
                            "terminal_id": pair.contact_id,
                            "label": self.label(connector_layer.layer_id, pair.contact_id),
                        },
                        "kind": "carried",
                        "basis": carried.basis
                        or "Board carried-connector correspondence (unreviewed).",
                        "origin": "board_carried_connector",
                        "status": status,
                    }
                )
        return rows

    def _edges(self):
        """Undirected declared steps between stack terminals, each with a status and text."""
        edges = []
        for join in self.joins:
            edges.append(
                (
                    (join["a"]["layer_id"], join["a"]["terminal_id"]),
                    (join["b"]["layer_id"], join["b"]["terminal_id"]),
                    "unknown" if join["status"] == "unknown" else "declared",
                    "landing (unreviewed)"
                    if join["status"] == "unknown"
                    else "landing"
                    if join["kind"] == "carried"
                    else join["kind"],
                    {"kind": "landing" if join["kind"] == "carried" else "join", "join": join},
                )
            )
        for join in self.joins:
            if join.get("through"):
                ends = join["a"], join["through"]
                edges.append(
                    (
                        (ends[0]["layer_id"], ends[0]["terminal_id"]),
                        (ends[1]["layer_id"], ends[1]["terminal_id"]),
                        "declared",
                        "solder",
                        {"kind": "join", "join": join},
                    )
                )
        for layer, board in self.boards.values():
            for path in board.paths:
                edges.append(
                    (
                        (layer.layer_id, path.from_terminal),
                        (layer.layer_id, path.to_terminal),
                        switch_contact_state(layer, path)
                        if path.switch
                        else "declared"
                        if path.via in ("copper", "component")
                        else "unknown",
                        path_summary(path, board),
                        {
                            "kind": "board_path",
                            "local_id": path.local_id,
                            "via": path.via,
                            "component": path.component,
                            **(
                                {
                                    "condition_key": path.switch.condition_key,
                                    "selected_state": layer.condition_states.get(
                                        path.switch.condition_key
                                    ),
                                    "closed_when": path.switch.closed_when,
                                }
                                if path.switch
                                else {}
                            ),
                        },
                    )
                )
        for layer in self.stack.layers:
            if layer.kind == "inline":
                for part in layer.parts:
                    edges.append(
                        (
                            (layer.layer_id, f"{part.local_id}.1"),
                            (layer.layer_id, f"{part.local_id}.2"),
                            "declared",
                            component_text(part.component),
                            {
                                "kind": "inline_part",
                                "local_id": part.local_id,
                                "via": "component",
                                "component": part.component,
                            },
                        )
                    )
        self.edges = edges

    def reaches(self, layer_id, terminal_id):
        """Connector contacts this terminal is declared to lead to, with each step named."""
        if not self.connectors:
            return []
        targets = set(self.connectors)
        adjacency = {}
        for a, b, status, text, _ in self.edges:
            if status == "open":
                continue
            adjacency.setdefault(a, []).append((b, status, text))
            adjacency.setdefault(b, []).append((a, status, text))
        start = (layer_id, terminal_id)
        found = []
        stack = [(start, [], "declared", {start})]
        while stack and len(found) < MAX_REACHES:
            node, steps, status, seen = stack.pop()
            if node[0] in targets and node != start:
                found.append((node, steps, status))
                continue
            if len(steps) >= MAX_REACH_STEPS:
                continue
            for neighbor, edge_status, text in adjacency.get(node, ()):
                if neighbor in seen:
                    continue
                stack.append(
                    (
                        neighbor,
                        [*steps, text],
                        "unknown" if "unknown" in (status, edge_status) else "declared",
                        seen | {neighbor},
                    )
                )
        found.sort(key=lambda row: (len(row[1]), row[0][1]))
        return [
            {
                **({"layer_id": node[0]} if self.stack.graph_version == "0.2" else {}),
                "contact_id": node[1],
                "label": self.terminals[node]["label"],
                "signal": self.terminals[node].get("signal"),
                "status": status,
                "via": steps,
            }
            for node, steps, status in found
        ]

    def evaluation(self):
        """What downstream evaluations understand of this stack; nothing silently passes."""
        notes = []
        for layer in self.stack.layers:
            if layer.kind == "board":
                notes.append(
                    {
                        "layer_id": layer.layer_id,
                        "status": "not_evaluated",
                        "reason": "Board paths are declared topology; component behavior is "
                        "interpreted only by the passive path query.",
                    }
                )
            elif layer.kind == "inline":
                notes.append(
                    {
                        "layer_id": layer.layer_id,
                        "status": "not_evaluated",
                        "reason": "Inline parts separate copper; their behavior is not "
                        "evaluated here.",
                    }
                )
            elif layer.kind == "shell":
                notes.append(
                    {
                        "layer_id": layer.layer_id,
                        "status": "not_evaluated",
                        "reason": "A shell is mechanical; it is joined electrically only by a "
                        "declared bond.",
                    }
                )
        return notes

    def view(self):
        layers = []
        for layer in self.layers:
            layers.append(
                {
                    **layer,
                    "terminals": [
                        {
                            **t,
                            "reaches": []
                            if layer["kind"] == "connector"
                            else self.reaches(layer["layer_id"], t["terminal_id"]),
                        }
                        for t in layer["terminals"]
                    ],
                }
            )
        connector = self.connector
        return {
            **(
                {"graph_version": "0.2", "connector_layer_ids": list(self.connectors)}
                if self.stack.graph_version == "0.2"
                else {}
            ),
            "layers": layers,
            "joins": self.joins,
            "connector_layer_id": connector[0].layer_id if connector else None,
            "body_revision_id": str(connector[0].body_revision_id) if connector else None,
            "pinout_revision_id": str(connector[0].pinout_revision_id) if connector else None,
            "evaluation": self.evaluation(),
            "continuity": "not_evaluated",
        }
