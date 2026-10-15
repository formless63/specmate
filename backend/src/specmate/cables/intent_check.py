"""Check one exact cable (draft or frozen) against one exact cable intent.

Each intent row gets the declared path chain (port pin -> mated cable contact -> board
landing/pads/paths -> inline parts -> conductor -> ... -> far contact -> mated far pin)
and separate dimensions, each ``pass``, ``fail``, ``unknown``, ``not_evaluated`` or
``flagged`` with a reason and the evidence it used. Unknown is never pass. Paths are the
cable's declared topology (terminations, stack joins, board paths, inline parts); they
are not measured continuity and never physical qualification. Conventions only flag.
"""

import json
from itertools import pairwise

from specmate.cables.queries import Closure
from specmate.interfaces.contracts import ConnectorBody, Pinout, Port
from specmate.interfaces.intent_contracts import CableIntent
from specmate.interfaces.intents import RETURN_LIKE, end_view
from specmate.operations import NotFound, PermissionDenied, ValidationFailed
from specmate.pcb.component_values import parse_capacitance, parse_resistance

ALGORITHM = "cable_intent_check/0.1"
MAX_DEPTH = 24
MAX_PATHS = 64
LIMIT_REASON = f"search limit reached ({MAX_DEPTH} steps / {MAX_PATHS} paths)"
DIMENSIONS = (
    "connection",
    "signal_match",
    "conductor",
    "level",
    "required_parts",
    "return",
    "isolation",
    "shield",
    "convention",
    "mating",
)
# Dimensions that only flag; they never change a row's outcome.
FLAG_ONLY = {"convention"}


def dim(status, reason, *evidence):
    return {"status": status, "reason": reason, "evidence": [e for e in evidence if e]}


def outcome(dimensions, *, wired=True):
    statuses = [d["status"] for k, d in dimensions.items() if k not in FLAG_ONLY]
    if "fail" in statuses:
        return "fail"
    if "unknown" in statuses:
        return "unknown"
    if "flagged" in statuses:
        return "flagged"
    if not wired or "pass" not in statuses:
        return "not_evaluated"
    return "pass"


# ---------------------------------------------------------------- mating


def mating_map(end_layer, end_body, intent_pinout, closure):
    """Port contact -> cable end contact, with a status; None when nothing mates."""
    port_body_id = intent_pinout.body_revision_id
    port_body = closure.values.get(port_body_id)
    if end_layer.body_revision_id == port_body_id:
        ids = {c.contact_id for c in end_body.contacts if c.physical_role != "key"}
        return {c: c for c in ids}, "pass", "The intent end is a pinout of this exact body."
    candidates = [(m, False) for m in end_body.mates_with if m.body_revision_id == port_body_id]
    if isinstance(port_body, ConnectorBody):
        candidates += [
            (m, True)
            for m in port_body.mates_with
            if m.body_revision_id == end_layer.body_revision_id
        ]
    if not candidates:
        return None, "fail", "Neither connector body declares mating with the other."
    mate, reverse = candidates[0]
    theirs = port_body if not reverse else end_body
    if mate.correspondence == "same_contact_id":
        ids = {c.contact_id for c in theirs.contacts if c.physical_role != "key"}
        mapping = {c: c for c in ids}
    else:
        pairs = [(p.this, p.other) for p in mate.pairs]
        # Declared on the cable body: this=cable contact; on the port body: this=port contact.
        mapping = {o: t for t, o in pairs} if not reverse else dict(pairs)
    if mate.review == "reviewed":
        return mapping, "pass", f"Reviewed mating declaration: {mate.basis}"
    return mapping, "unknown", "The mating declaration is unreviewed."


# ---------------------------------------------------------------- graph


class Graph:
    """Declared steps over every cable end stack plus terminations and conductors."""

    def __init__(self, closure):
        self.closure = closure
        self.adjacent = {}
        self.labels = {}
        self.connector = {}
        for endpoint_id, (_, resolved) in closure.endpoints.items():
            if resolved.connector:
                self.connector[endpoint_id] = resolved.connector[0].layer_id
            for (layer_id, terminal_id), terminal in resolved.terminals.items():
                kind = resolved.layer(layer_id).kind
                self.labels[("t", endpoint_id, layer_id, terminal_id)] = (
                    kind,
                    f"{kind} {terminal['label']}",
                )
            for a, b, status, text, detail in resolved.edges:
                self.edge(("t", endpoint_id, *a), ("t", endpoint_id, *b), status, text, detail)
        for path, element in closure.elements.items():
            ends = [e.local_id for e in closure.cable.endpoints]
            for e in ends:
                self.labels[("c", e, path)] = ("conductor", f"{path} at end {e}")
            for a, b in pairwise(ends):
                self.edge(
                    ("c", a, path),
                    ("c", b, path),
                    "declared",
                    element.label,
                    {"kind": "conductor", "element_path": path},
                )
        for t in closure.cable.assignments:
            self.edge(
                ("c", t.endpoint_id, t.element_path),
                ("t", t.endpoint_id, t.layer_id, t.terminal_id),
                "declared",
                "termination",
                {"kind": "termination", "basis": t.basis},
            )

    def edge(self, a, b, status, text, detail):
        self.adjacent.setdefault(a, []).append((b, status, text, detail))
        self.adjacent.setdefault(b, []).append((a, status, text, detail))

    def is_contact(self, node):
        return node[0] == "t" and self.connector.get(node[1]) == node[2]

    def paths(self, start):
        """Simple paths from ``start`` to every other connector contact, bounded."""
        found, touched = [], set()
        stack = [(start, [], {start})]
        self.limited = False
        while stack and len(found) < MAX_PATHS:
            node, steps, seen = stack.pop()
            if node[0] == "c":
                touched.add(node)
            if node != start and self.is_contact(node):
                found.append((node, steps))
                continue
            if len(steps) >= MAX_DEPTH:
                self.limited = True
                continue
            for neighbor, status, text, detail in self.adjacent.get(node, ()):
                if neighbor not in seen:
                    stack.append(
                        (
                            neighbor,
                            [*steps, (node, neighbor, status, text, detail)],
                            seen | {neighbor},
                        )
                    )
        if stack:
            self.limited = True
        found.sort(key=lambda f: (any(s[2] == "unknown" for s in f[1]), len(f[1])))
        return found, touched


def path_status(steps):
    return "unknown" if any(s[2] == "unknown" for s in steps) else "declared"


# ---------------------------------------------------------------- check


class Check:
    def __init__(self, user, closure, intent_revision_id):
        self.user = user
        self.closure = closure
        self.intent_revision = closure.revisions[intent_revision_id]
        self.intent = closure.values.get(intent_revision_id)
        if not isinstance(self.intent, CableIntent):
            raise ValidationFailed("Checks need an exact cable intent revision.")
        self.graph = Graph(closure)
        self.views = {
            "from": end_view(closure, self.intent.from_revision_id),
            "to": end_view(closure, self.intent.to_revision_id),
        }
        self.pins = {
            side: {r["contact_id"]: r for r in v["rows"]} for side, v in self.views.items()
        }
        self.parents = {}
        self._parents(closure.stock.structure, "")
        self.ends = self._map_ends()
        self.conventions = self._conventions()

    # -- set-up

    def _parents(self, node, prefix):
        path = f"{prefix}.{node.id}" if prefix else node.id
        for child in getattr(node, "children", []):
            self.parents[f"{path}.{child.id}"] = node
            self._parents(child, path)

    def _pinout(self, revision_id):
        value = self.closure.values[revision_id]
        return self.closure.values[value.pinout_revision_id] if isinstance(value, Port) else value

    def _map_ends(self):
        """Which cable end plugs into the intent's from end and which into its to end."""
        sides = {"from": self.intent.from_revision_id, "to": self.intent.to_revision_id}
        options = {}
        for side, revision_id in sides.items():
            pinout = self._pinout(revision_id)
            if not isinstance(pinout, Pinout):
                raise ValidationFailed("An intent end is a device port or a pinout variant.")
            for endpoint_id, (_, resolved) in self.closure.endpoints.items():
                if resolved.connector is None:
                    options[side, endpoint_id] = (None, "fail", "This end has no connector layer.")
                    continue
                layer, body, _ = resolved.connector
                options[side, endpoint_id] = mating_map(layer, body, pinout, self.closure)
        ids = list(self.closure.endpoints)
        best = None
        for order in (ids, ids[::-1]):
            score = sum(
                options["from" if i == 0 else "to", e][0] is not None for i, e in enumerate(order)
            )
            if best is None or score > best[0]:
                best = (score, order)
        order = best[1]
        ends = {}
        for side, endpoint_id in zip(("from", "to"), order, strict=True):
            mapping, status, reason = options[side, endpoint_id]
            endpoint = self.closure.endpoints[endpoint_id][0]
            ends[side] = {
                "endpoint_id": endpoint_id,
                "label": endpoint.label or f"End {endpoint_id.upper()}",
                "mapping": mapping or {},
                "reverse": {v: k for k, v in (mapping or {}).items()},
                "mating": dim(status, reason),
            }
        return ends

    def _conventions(self):
        from specmate.interfaces.conventions import stock_conventions

        rules = {}
        try:
            found = stock_conventions(self.user, self.closure.cable.stock_revision_id)
        except (NotFound, PermissionDenied):
            # A convention never changes an outcome; an unreadable one is simply absent.
            return rules
        for entry in found["conventions"]:
            if not entry.get("exact") or "convention" not in entry:
                continue
            for row in entry["convention"]["rows"]:
                if row.get("element_path"):
                    rules.setdefault(row["element_path"], (entry, row))
        return rules

    # -- helpers

    def near(self, side, contact_id):
        end = self.ends[side]
        mapped = end["mapping"].get(contact_id)
        layer = self.graph.connector.get(end["endpoint_id"])
        if mapped is None or layer is None:
            return None
        return ("t", end["endpoint_id"], layer, mapped)

    def port_contact(self, node):
        for side, end in self.ends.items():
            if node[1] == end["endpoint_id"]:
                return side, end["reverse"].get(node[3])
        return None, None

    def pin_label(self, side, contact_id):
        row = self.pins[side].get(contact_id)
        number = (row or {}).get("number") or contact_id
        signal = ((row or {}).get("signal") or {}).get("name")
        return f"{number} · {signal}" if signal else number

    def chips(self, side, contact_id, start, steps, far_side, far_contact):
        name = self.views[side]["name"]
        chips = [{"kind": "port_pin", "label": f"{name} {self.pin_label(side, contact_id)}"}]
        chips.append(
            {"kind": "mated", "label": "mated", "status": self.ends[side]["mating"]["status"]}
        )
        chips.append({"kind": "contact", "label": self.graph.labels[start][1]})
        for _, to, status, text, detail in steps:
            chips.append({"kind": detail["kind"], "label": text, "status": status})
            chips.append({"kind": self.graph.labels[to][0], "label": self.graph.labels[to][1]})
        if far_side:
            chips.append(
                {
                    "kind": "mated",
                    "label": "mated",
                    "status": self.ends[far_side]["mating"]["status"],
                }
            )
            chips.append(
                {
                    "kind": "port_pin",
                    "label": f"{self.views[far_side]['name']} "
                    f"{self.pin_label(far_side, far_contact)}",
                }
            )
        return chips

    def signal_key(self, ref):
        return (str(ref.signal_set_revision_id), ref.key) if ref else None

    def pin_signal(self, side, contact):
        signal = (self.pins[side].get(contact) or {}).get("signal")
        return (str(signal["signal_set_revision_id"]), signal["key"]) if signal else None

    # -- dimensions

    def conductor_dim(self, row, centers):
        need = row.conductor
        if need.kind in ("unknown", "any"):
            return dim("not_evaluated", "The intent states no conductor requirement.")
        if not centers:
            return dim("not_evaluated", "No conductor is on the path.")
        for path in centers:
            parent = self.parents.get(path)
            role = getattr(parent, "role", None)
            kind = {"coax": "coax", "pair": "pair"}.get(role, "single")
            if kind != need.kind:
                return dim("fail", f"{path} is a {kind} conductor; the intent needs {need.kind}.")
        if need.impedance_ohm is None:
            return dim("pass", f"Conductor kind {need.kind} as required.", "stock structure")
        fact = self.closure.stock.facts.get("impedance")
        if fact is None or fact.status == "unknown" or not isinstance(fact.value, float | int):
            return dim("unknown", "The stock declares no characteristic impedance.", "stock facts")
        if abs(float(fact.value) - need.impedance_ohm) > 1e-9:
            return dim(
                "fail",
                f"Stock impedance {fact.value:g} ohm; the intent needs {need.impedance_ohm:g} ohm.",
            )
        return dim(
            "pass",
            f"{need.kind} at {fact.value:g} ohm ({fact.status}).",
            f"stock fact: {fact.source}",
        )

    def level_dim(self, row, far_side, far_contacts, components):
        if row.signal_ref is None:
            return dim("not_evaluated", "The row names no signal.")
        signal = self.closure.signal(row.signal_ref)
        if signal.type in RETURN_LIKE:
            return dim("not_evaluated", "A return or chassis carries no signal level.")
        source = ((self.pins["from"].get(row.from_contact_id) or {}).get("device") or {}).get(
            "level"
        )
        if not source or source.get("status") != "known":
            return dim("unknown", "The from end declares no level for this pin.")
        if row.required_parts or components:
            return dim("unknown", "The level after declared parts on the path is not evaluated.")
        results = []
        for contact in far_contacts:
            accepted = ((self.pins[far_side].get(contact) or {}).get("device") or {}).get("level")
            if not accepted or accepted.get("status") != "known":
                return dim("unknown", f"The to end declares no accepted level at {contact}.")
            if accepted.get("unit") != source.get("unit"):
                return dim("unknown", "The two levels use different units; no conversion is made.")
            low, high = accepted.get("minimum"), accepted.get("maximum")
            value = source.get("nominal")
            if value is None:
                return dim("unknown", "The from level has no nominal value.")
            if low is not None or high is not None:
                ok = (low is None or value >= low) and (high is None or value <= high)
            else:
                ok = accepted.get("nominal") == value
            results.append(ok)
        if not results:
            return dim("not_evaluated", "No destination is reached.")
        unit = source.get("unit")
        if all(results):
            return dim(
                "pass", f"Driven {source['nominal']:g} {unit} is accepted.", "port pin facts"
            )
        return dim(
            "fail",
            f"Driven {source['nominal']:g} {unit} is outside the accepted level.",
            "port pin facts",
        )

    def parts_dim(self, row, components):
        if not row.required_parts:
            return dim("not_evaluated", "The intent requires no part on this row.")
        found = []
        for part in row.required_parts:
            kind = {"series_resistor": "resistor", "series_capacitor": "capacitor"}.get(
                part.conditioning
            )
            if kind is None:
                return dim("unknown", f"A required {part.conditioning} is not evaluated.")
            candidates = [c for c in components if c.kind == kind]
            if not candidates:
                return dim(
                    "fail",
                    f"No declared {kind} on the path; the intent needs {part.value or kind}.",
                )
            if part.value is None:
                found.append(f"{kind} present")
                continue
            parse = parse_resistance if kind == "resistor" else parse_capacitance
            wanted = parse(part.value)
            match = None
            for c in candidates:
                have = c.resistance_ohm if kind == "resistor" else c.capacitance_f
                if have is None and c.value:
                    have = parse(c.value)
                if have is None:
                    match = match or "unknown"
                elif wanted is not None and have == wanted:
                    match = "pass"
                    found.append(f"{c.reference or kind} {c.value or have}")
                    break
            if match is None:
                return dim("fail", f"The {kind} on the path is not {part.value}.")
            if match == "unknown":
                return dim("unknown", f"The {kind} on the path has no stated value.")
        return dim(
            "pass",
            "Required parts are declared on the path: " + ", ".join(found) + ".",
            "end stack",
        )

    def return_dim(self, row, centers):
        if row.return_policy in ("not_applicable",):
            return dim("not_evaluated", "This row is itself a return.")
        if row.return_policy != "dedicated_screen":
            return dim("not_evaluated", "The intent states no specific return for this row.")
        if not centers:
            return dim("not_evaluated", "No conductor is on the path.")
        key = row.signal_ref.key if row.signal_ref else None
        parent_path = centers[0].rsplit(".", 1)[0]
        parent = self.parents.get(centers[0])
        screens = [
            f"{parent_path}.{c.id}" for c in getattr(parent, "children", []) if c.kind == "shield"
        ]
        if not screens:
            return dim("fail", f"{centers[0]} has no screen of its own.")
        screen = screens[0]
        status = "pass"
        for side in ("from", "to"):
            start = ("c", self.ends[side]["endpoint_id"], screen)
            found, _ = self.graph.paths(start)
            here = [n for n, steps in found if n[1] == self.ends[side]["endpoint_id"]]
            if not here:
                return dim("fail", f"The screen {screen} is not landed at the {side} end.")
            ok = False
            for node in here:
                _, contact = self.port_contact(node)
                signal = (self.pins[side].get(contact) or {}).get("signal")
                if signal and signal["type"] == "ground_return":
                    from specmate.interfaces.signal_contracts import SignalRef

                    returned = self.closure.signal(
                        SignalRef(
                            signal_set_revision_id=signal["signal_set_revision_id"],
                            key=signal["key"],
                        )
                    )
                    ok = ok or key in returned.return_for
            if not ok:
                status = "unknown" if status == "pass" else status
                if any(self.port_contact(n)[1] for n in here):
                    return dim(
                        "fail", f"The screen lands at the {side} end on no return for this signal."
                    )
        if status == "unknown":
            return dim("unknown", "The screen's landing signal is unknown.")
        return dim(
            "pass",
            f"Own screen {screen} lands on this signal's return at both ends.",
            "pin signals",
        )

    def convention_dim(self, row, centers):
        if not centers or row.signal_ref is None:
            return dim("not_evaluated", "No conductor or signal to compare.")
        rule = self.conventions.get(centers[0])
        if rule is None:
            return dim("not_evaluated", f"No exact stock convention mentions {centers[0]}.")
        entry, found = rule
        use = found["use"]
        evidence = f"{entry['name']} r{entry['number']}"
        if use["kind"] == "signal" and use.get("signal_key") == row.signal_ref.key:
            return dim("pass", "Follows the stock convention.", evidence)
        what = (use.get("signal") or {}).get("name") or use["kind"]
        return dim("flagged", f"The convention uses {centers[0]} for {what}.", evidence)

    # -- rows

    def row(self, row):
        base = {
            "row_id": row.row_id,
            "requirement": row.requirement,
            "from_label": self.pin_label("from", row.from_contact_id)
            if row.from_contact_id
            else None,
            "to_labels": [self.pin_label("to", c) for c in row.to_contact_ids],
            "signal": self.closure.describe(row.signal_ref) if row.signal_ref else None,
        }
        mating = self.ends["from"]["mating"], self.ends["to"]["mating"]
        mating_status = (
            "fail"
            if "fail" in (m["status"] for m in mating)
            else "unknown"
            if "unknown" in (m["status"] for m in mating)
            else "pass"
        )
        dims = {k: dim("not_evaluated", "Not evaluated for this row.") for k in DIMENSIONS}
        dims["shield"] = dim("not_evaluated", "Shielding is checked for the whole cable.")
        dims["mating"] = dim(mating_status, "; ".join(m["reason"] for m in mating))
        if row.question is not None:
            dims["connection"] = dim("unknown", "The intent row has an open question.")
            return {**base, "outcome": "unknown", "dimensions": dims, "path": [], "reached": []}
        side, contact = (
            ("from", row.from_contact_id) if row.from_contact_id else ("to", row.to_contact_ids[0])
        )
        far_side = "to" if side == "from" else "from"
        start = self.near(side, contact)
        if start is None:
            dims["connection"] = dim("unknown", f"The {side} pin does not map to a cable contact.")
            return {**base, "outcome": outcome(dims), "dimensions": dims, "path": [], "reached": []}
        found, touched = self.graph.paths(start)
        limited = self.graph.limited
        far_id = self.ends[far_side]["endpoint_id"]
        far = {}
        near_others = []
        for node, steps in found:
            _, port_contact = self.port_contact(node)
            if node[1] == far_id:
                far.setdefault(port_contact or node[3], steps)
            else:
                near_others.append(port_contact or node[3])
        if row.requirement == "must_not_connect":
            if touched:
                where = ", ".join(sorted(self.pin_label(far_side, c) for c in far)) or "a conductor"
                dims["connection"] = dim(
                    "fail", f"Must not connect, but the pin reaches {where}.", "declared path"
                )
            else:
                dims["connection"] = dim(
                    "pass", "The pin reaches no conductor.", "declared topology"
                )
            best = next(iter(far.items()), None)
            path = self.chips(side, contact, start, best[1], far_side, best[0]) if best else []
            return {
                **base,
                "outcome": outcome(dims),
                "dimensions": dims,
                "path": path,
                "reached": [self.pin_label(far_side, c) for c in far],
            }
        if not touched:
            if row.requirement == "optional":
                return {
                    **base,
                    "outcome": "not_evaluated",
                    "dimensions": dims,
                    "path": [],
                    "reached": [],
                    "note": "Optional row; not wired.",
                }
            dims["connection"] = dim("fail", "The pin reaches no conductor.", "declared topology")
            return {**base, "outcome": "fail", "dimensions": dims, "path": [], "reached": []}
        if side == "to":
            dims["connection"] = dim("flagged", "wired outside the intent", "declared topology")
            sources = {r.from_contact_id: r.row_id for r in self.intent.rows if r.from_contact_id}
            shorted = [sources[c] for c in far if c in sources]
            dims["isolation"] = (
                dim("fail", "Shorts to the net of " + ", ".join(sorted(shorted)) + ".")
                if shorted
                else dim("pass", "Joins no row's net.", "declared path")
            )
            return {
                **base,
                "outcome": outcome(dims),
                "dimensions": dims,
                "path": [],
                "reached": [self.pin_label(far_side, c) for c in far],
            }
        wanted = set(row.to_contact_ids)
        missing = [c for c in row.to_contact_ids if c not in far]
        statuses = {c: path_status(far[c]) for c in far}
        if missing:
            dims["connection"] = dim(
                "fail",
                "No declared path to " + ", ".join(self.pin_label("to", c) for c in missing) + ".",
                "declared path",
            )
        elif any(statuses[c] == "unknown" for c in wanted):
            dims["connection"] = dim(
                "unknown", "The path passes an unreviewed or unknown step.", "declared path"
            )
        else:
            dims["connection"] = dim(
                "pass",
                "Declared path to "
                + ", ".join(self.pin_label("to", c) for c in row.to_contact_ids)
                + ".",
                "declared path",
            )
        expected = self.signal_key(row.signal_ref)
        wrong = [
            c
            for c in far
            if self.pin_signal("to", c) is not None and self.pin_signal("to", c) != expected
        ]
        unknown = [c for c in far if self.pin_signal("to", c) is None]
        if wrong:
            dims["signal_match"] = dim(
                "fail",
                "Reaches " + ", ".join(self.pin_label("to", c) for c in wrong) + ".",
                "pin signals",
            )
        elif unknown:
            dims["signal_match"] = dim(
                "unknown", "A reached pin has no typed signal.", "pin signals"
            )
        elif far:
            dims["signal_match"] = dim(
                "pass", "Every reached pin carries this signal.", "pin signals"
            )
        extra = [c for c in far if c not in wanted]
        if extra or near_others:
            names = [self.pin_label("to", c) for c in extra] + [
                f"{self.pin_label('from', c)} (same end)" for c in near_others
            ]
            dims["isolation"] = dim(
                "fail", "Also reaches " + ", ".join(names) + ".", "declared path"
            )
        elif any(s == "unknown" for s in statuses.values()):
            dims["isolation"] = dim("unknown", "A path passes an unknown step.")
        else:
            dims["isolation"] = dim("pass", "Reaches no other pin.", "declared path")
        if limited:
            dims["connection"] = dim("unknown", LIMIT_REASON, "declared path")
        chosen = next((c for c in row.to_contact_ids if c in far), next(iter(far), None))
        steps = far.get(chosen, [])
        centers = [
            d["element_path"]
            for *_, d in steps
            if d["kind"] == "conductor"
            and self.closure.elements[d["element_path"]].kind == "conductor"
        ]
        components = [d["component"] for *_, d in steps if d.get("component") is not None]
        dims["conductor"] = self.conductor_dim(row, centers)
        dims["level"] = self.level_dim(
            row, "to", [c for c in row.to_contact_ids if c in far], components
        )
        dims["required_parts"] = self.parts_dim(row, components)
        dims["return"] = self.return_dim(row, centers)
        dims["convention"] = self.convention_dim(row, centers)
        path = self.chips(side, contact, start, steps, far_side, chosen) if chosen else []
        return {
            **base,
            "outcome": outcome(dims),
            "dimensions": dims,
            "path": path,
            "reached": [self.pin_label("to", c) for c in far],
        }

    def cable_rows(self):
        listed = {r.from_contact_id for r in self.intent.rows if r.from_contact_id}
        if self.intent.isolation != "no_unlisted_connections":
            isolation = dim("not_evaluated", "The intent does not forbid unlisted connections.")
        else:
            offenders = []
            for contact in self.pins["from"]:
                if contact in listed:
                    continue
                start = self.near("from", contact)
                if start and self.graph.paths(start)[1]:
                    offenders.append(self.pin_label("from", contact))
            isolation = (
                dim(
                    "fail",
                    "Unlisted pins are wired: " + ", ".join(offenders) + ".",
                    "declared topology",
                )
                if offenders
                else dim("pass", "No pin outside the intent rows is wired.", "declared topology")
            )
        listed_to = {c for r in self.intent.rows for c in r.to_contact_ids}
        listed_to |= {
            o.contact_id for r in self.intent.rows if r.question for o in r.question.options
        }
        listed_to |= {r.to_contact_ids[0] for r in self.intent.rows if r.to_contact_ids}
        outside = []
        for contact in self.pins["to"]:
            if contact in listed_to:
                continue
            start = self.near("to", contact)
            if start and self.graph.paths(start)[1]:
                outside.append(self.pin_label("to", contact))
        if outside and isolation["status"] in ("pass", "not_evaluated"):
            isolation = dim(
                "flagged",
                "wired outside the intent: " + ", ".join(outside) + ".",
                "declared topology",
            )
        policy = self.intent.shield.policy
        overall = [
            c for c in self.closure.stock.structure.children if c.kind in ("shield", "drain")
        ]
        if policy == "unknown":
            shield = dim("not_evaluated", "The intent states no shield policy.")
        elif not overall:
            shield = dim("not_evaluated", "The stock has no overall shield or drain.")
        else:
            bonded = {}
            for side in ("from", "to"):
                endpoint = self.ends[side]["endpoint_id"]
                bonded[side] = False
                for element in overall:
                    found, _ = self.graph.paths(
                        ("c", endpoint, f"{self.closure.stock.structure.id}.{element.id}")
                    )
                    bonded[side] = bonded[side] or any(n[1] == endpoint for n, _ in found)
            want = {
                "bond_from": (True, False),
                "bond_to": (False, True),
                "bond_both": (True, True),
                "isolated": (False, False),
            }[policy]
            got = (bonded["from"], bonded["to"])
            shield = (
                dim("pass", f"Overall shield bonding matches {policy}.", "declared topology")
                if got == want
                else dim(
                    "fail",
                    f"Overall shield bonded at from={got[0]}, to={got[1]}; "
                    f"the intent needs {policy}.",
                    "declared topology",
                )
            )
        return {"isolation": isolation, "shield": shield}

    def result(self):
        rows = [self.row(r) for r in self.intent.rows]
        counts = {}
        for r in rows:
            counts[r["outcome"]] = counts.get(r["outcome"], 0) + 1
        return {
            "algorithm_version": ALGORITHM,
            "intent_revision_id": str(self.intent_revision.id),
            "intent_name": self.intent_revision.definition.name,
            "intent_number": self.intent_revision.number,
            "ends": {
                side: {k: v for k, v in end.items() if k not in ("mapping", "reverse")}
                | {"intent_end": self.views[side]["name"]}
                for side, end in self.ends.items()
            },
            "rows": rows,
            "cable": self.cable_rows(),
            "counts": counts,
            "continuity": "not_evaluated",
            "physical_qualification": "not_evaluated",
            "meaning": "declared_topology_against_declared_intent",
        }


def check(user, content, kind, intent_revision_id=None, dependencies=()):
    """The check result for cable content; the intent defaults to the cable's pinned one."""
    from specmate.cables.queries import parse_content

    cable = parse_content(content, kind)
    intent_id = intent_revision_id or (cable.intent_revision_id if cable else None)
    if intent_id is None:
        raise ValidationFailed("Pin a cable intent on the cable or name one to check against.")
    closure = Closure(user, content, kind, [*dependencies, intent_id])
    return Check(user, closure, intent_id).result()


def check_revision(user, revision_id, intent_revision_id=None):
    from specmate.access.permissions import Perm, authorize
    from specmate.design.models import Revision
    from specmate.operations import NotFound

    revision = (
        Revision.objects.select_related("definition", "snapshot").filter(id=revision_id).first()
    )
    if revision is None or revision.definition.kind != "cable":
        raise NotFound("Cable revision unavailable.")
    authorize(user, revision.definition.workspace_id, Perm.WORKSPACE_READ)
    content = json.loads(bytes(revision.snapshot.canonical))["content"]
    deps = list(revision.snapshot.dependencies.values_list("revision_id", flat=True))
    result = check(user, content, "cable", intent_revision_id, deps)
    return revision, {"cable_revision_id": str(revision.id), "draft_id": None, **result}
