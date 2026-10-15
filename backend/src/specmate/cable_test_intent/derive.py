"""Propose cable test expectations from a frozen cable and its cable intent.

The proposal is a reviewable draft body, never stored or frozen here:

- **continuity** for each intent row (required, or optional and wired) from the cable
  contact at the from end to each destination contact, only where the cable declares a
  path. A path through an unreviewed landing or unknown board path, or through a part a
  continuity test cannot pass straight through (a series capacitor, an unknown part),
  is proposed as ``unknown`` with the reason. A path with declared resistors carries their
  series sum as the expected resistance; a resistor without a stated value leaves it unknown;
- **isolation** between every two rows the intent keeps apart (rows that share no
  intended contact), at the from end;
- **must-not-connect** rows become isolation from every other intended net and from the
  row's destination contacts.

A row the cable cannot carry (no declared path, open question, unmapped pin) proposes no
expectation and is listed with its reason. Labels name each tested contact's signal.
Nothing here is a test result or physical qualification.
"""

import json

from specmate.cable_test_intent.contracts import TestPlan
from specmate.cables.intent_check import Check, path_status
from specmate.cables.queries import Closure
from specmate.operations import ValidationFailed
from specmate.pcb.component_values import parse_resistance

ALGORITHM = "cable_test_plan_from_intent/0.1"
MAX_PAIRS = 2048


def _series(components):
    """(status, ohms, reason) for the parts a continuity test passes through in series."""
    if not components:
        return "continuity", None, None
    total = 0.0
    names = []
    for c in components:
        name = c.reference or c.value or c.kind
        if c.kind != "resistor":
            return (
                "unknown",
                None,
                f"The path passes a {c.kind} ({name}); a continuity test is not evaluated "
                "through it.",
            )
        ohms = c.resistance_ohm
        if ohms is None and c.value:
            ohms = parse_resistance(c.value)
        if ohms is None:
            return "continuity", None, f"The resistor {name} on the path has no stated value."
        total += float(ohms)
        names.append(f"{name} {c.value or f'{float(ohms):g} ohm'}")
    return "continuity", total, "Declared in series: " + ", ".join(names) + "."


class Derivation:
    def __init__(self, user, plan_scope, cable_revision, intent_revision_id):
        content = json.loads(bytes(cable_revision.snapshot.canonical))["content"]
        dependencies = list(
            cable_revision.snapshot.dependencies.values_list("revision_id", flat=True)
        )
        closure = Closure(user, content, "cable", [*dependencies, intent_revision_id])
        self.check = Check(user, closure, intent_revision_id)
        self.closure = closure
        self.scope = plan_scope
        self.intent_revision_id = intent_revision_id
        self.pairs = []
        self.labels = {}
        self.rows = []
        self.limited = False

    # -- helpers

    def contact(self, side, port_contact):
        node = self.check.near(side, port_contact)
        return None if node is None else (node[1], node[3])

    def terminal(self, end):
        endpoint_id, contact_id = end
        return {"endpoint_id": endpoint_id, "kind": "contact", "contact_id": contact_id}

    def signal_text(self, row):
        if row.signal_ref is None:
            return None
        described = self.closure.describe(row.signal_ref)
        return f"{described['name']} ({described['type'].replace('_', ' ')})"

    def label(self, side, port_contact, end, row):
        if end in self.labels:
            return
        pin = self.check.pin_label(side, port_contact)
        self.labels[end] = {
            "text": pin,
            "basis": f"Pin and signal named by intent row {row.row_id}.",
        }

    def add(self, kind, first, second, row_ids, basis, *, signal=None, ohms=None):
        if len(self.pairs) >= MAX_PAIRS:
            self.limited = True
            return None
        key = tuple(sorted([first, second]))
        if first == second or any(tuple(sorted([p[1], p[2]])) == key for p in self.pairs):
            return None
        local_id = f"{kind[0]}{len(self.pairs) + 1}"
        self.pairs.append((local_id, first, second, kind, basis, signal, ohms, row_ids))
        return local_id

    # -- rows

    def derive(self):
        intent = self.check.intent
        nets = {}
        for row in intent.rows:
            entry = {
                "row_id": row.row_id,
                "requirement": row.requirement,
                "signal": self.signal_text(row),
                "pairs": [],
                "reasons": [],
            }
            self.rows.append(entry)
            if row.question is not None:
                entry["reasons"].append("The intent row has an open question.")
                continue
            if row.from_contact_id is None:
                entry["reasons"].append(
                    "The row names no source pin; there is nothing to test from."
                )
                continue
            near = self.contact("from", row.from_contact_id)
            if near is None:
                entry["reasons"].append("The from pin does not map to a cable contact.")
                continue
            if row.requirement == "must_not_connect":
                nets[row.row_id] = ("mnc", near, row)
                continue
            found, touched = self.check.graph.paths(self.check.near("from", row.from_contact_id))
            if self.check.graph.limited:
                entry["reasons"].append("The path search reached its limit; proposed unknown.")
            far_id = self.check.ends["to"]["endpoint_id"]
            far = {}
            for node, steps in found:
                if node[1] == far_id:
                    _, port_contact = self.check.port_contact(node)
                    far.setdefault(port_contact or node[3], steps)
            if not touched and row.requirement == "optional":
                entry["reasons"].append("Optional row; the cable does not wire it.")
                continue
            derived = False
            for to_contact in row.to_contact_ids:
                far_end = self.contact("to", to_contact)
                if far_end is None:
                    entry["reasons"].append(
                        f"Destination {self.check.pin_label('to', to_contact)} does not map "
                        "to a cable contact."
                    )
                    continue
                steps = far.get(to_contact)
                if steps is None:
                    entry["reasons"].append(
                        "No declared path to "
                        f"{self.check.pin_label('to', to_contact)}; the cable does not meet "
                        "this row, so no expectation is proposed."
                    )
                    continue
                components = [d["component"] for *_, d in steps if d.get("component") is not None]
                kind, ohms, note = _series(components)
                basis = (
                    f"Proposed from intent row {row.row_id}: "
                    f"{self.check.pin_label('from', row.from_contact_id)} to "
                    f"{self.check.pin_label('to', to_contact)} through the declared path."
                )
                if path_status(steps) == "unknown" or self.check.graph.limited:
                    kind, ohms = "unknown", None
                    note = "The declared path passes an unreviewed or unknown step."
                if note:
                    basis += " " + note
                local_id = self.add(
                    kind,
                    near,
                    far_end,
                    [row.row_id],
                    basis,
                    signal=self.signal_text(row),
                    ohms=ohms,
                )
                if local_id:
                    entry["pairs"].append(local_id)
                    derived = True
                self.label("from", row.from_contact_id, near, row)
                self.label("to", to_contact, far_end, row)
            if derived:
                nets[row.row_id] = ("net", near, row)
        self.isolation(nets)
        return self

    def isolation(self, nets):
        intent = self.check.intent
        intended = {
            r.row_id: {("from", r.from_contact_id)} | {("to", c) for c in r.to_contact_ids}
            for r in intent.rows
        }
        entries = {e["row_id"]: e for e in self.rows}
        ids = list(nets)
        for i, a in enumerate(ids):
            for b in ids[i + 1 :]:
                kind_a, near_a, row_a = nets[a]
                kind_b, near_b, row_b = nets[b]
                if kind_a == kind_b == "mnc":
                    continue
                if kind_a == "net" and kind_b == "net" and intended[a] & intended[b]:
                    # The intent itself joins these rows (a shared destination contact).
                    continue
                basis = f"Proposed from intent rows {a} and {b}: " + (
                    "the intent says this pin must not connect"
                    + f" ({(row_a if kind_a == 'mnc' else row_b).basis})."
                    if "mnc" in (kind_a, kind_b)
                    else "the intent keeps these signals apart."
                )
                local_id = self.add("isolation", near_a, near_b, [a, b], basis)
                if local_id:
                    entries[a]["pairs"].append(local_id)
                    entries[b]["pairs"].append(local_id)
        for row_id, (kind, near, row) in nets.items():
            if kind != "mnc":
                continue
            for to_contact in row.to_contact_ids:
                far_end = self.contact("to", to_contact)
                if far_end is None:
                    continue
                local_id = self.add(
                    "isolation",
                    near,
                    far_end,
                    [row_id],
                    f"Proposed from intent row {row_id}: must not connect ({row.basis}).",
                )
                if local_id:
                    entries[row_id]["pairs"].append(local_id)
            self.label("from", row.from_contact_id, near, row)
            if not entries[row_id]["pairs"]:
                entries[row_id]["reasons"].append(
                    "No other tested net at this end to check isolation against."
                )

    def result(self, root, cable_revision):
        intent_revision = self.check.intent_revision
        pairs = [
            {
                "local_id": local_id,
                "first": self.terminal(first),
                "second": self.terminal(second),
                "intent": kind,
                "basis": basis,
                "signal": signal,
                "expected_resistance_ohm": ohms,
                "derived_from": {
                    "intent_revision_id": str(intent_revision.id),
                    "row_ids": row_ids,
                },
            }
            for local_id, first, second, kind, basis, signal, ohms, row_ids in self.pairs
        ]
        labels = [
            {
                "local_id": f"l{index}",
                "text": label["text"],
                "terminal": self.terminal(end),
                "basis": label["basis"],
            }
            for index, (end, label) in enumerate(sorted(self.labels.items()), start=1)
        ]
        for side in ("from", "to"):
            end = self.check.ends[side]
            labels.append(
                {
                    "local_id": f"e-{side}",
                    "text": f"{end['label']} · {self.check.views[side]['name']}",
                    "endpoint_id": end["endpoint_id"],
                    "basis": f"The intent's {side} end.",
                }
            )
        plan = TestPlan.model_validate(
            {
                "root_revision_id": str(root.id),
                "occurrence_path": self.scope.occurrence_path,
                "cable_revision_id": str(cable_revision.id),
                "pairs": pairs,
                "labels": labels,
            }
        ).model_dump(mode="json")
        return {
            "algorithm_version": ALGORITHM,
            "intent_revision_id": str(intent_revision.id),
            "intent_name": intent_revision.definition.name,
            "intent_number": intent_revision.number,
            "test_plan": plan,
            "rows": self.rows,
            "counts": {
                kind: sum(1 for p in pairs if p["intent"] == kind)
                for kind in ("continuity", "isolation", "unknown")
            },
            "limited": self.limited,
            "review": "required",
            "stored": False,
            "physical_test": "not_performed",
            "physical_continuity": "not_evaluated",
            "physical_qualification": "not_evaluated",
            "meaning": "proposed_expectations_from_declared_intent_and_topology",
        }


def derive(user, payload):
    from specmate.cable_test_intent.queries import target

    root, cable_revision, cable = target(user, payload)
    intent_id = payload.intent_revision_id
    if intent_id is None:
        pinned = (cable["intent"] or {}).get("revision_id")
        if pinned is None:
            raise ValidationFailed("The cable pins no cable intent; name one to derive from.")
        intent_id = pinned
    derivation = Derivation(user, payload, cable_revision, intent_id).derive()
    return derivation.result(root, cable_revision)
