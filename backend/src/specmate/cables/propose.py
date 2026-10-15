"""Propose cable wiring from an intent, a stock and the two chosen ends (auto-construct).

The proposal is deterministic and explainable, and it is never stored here: the person
accepts rows into a cable draft through the ordinary cable commands.

1. Conductors for signal rows: candidates must meet the row's conductor requirement
   (coax, pair or single) and be unused. They are ranked by the stock's exact conventions,
   then color codes: preferred, then allowed, then spare, then unranked. A conductor a
   convention keeps for another signal, ``avoid`` and ``do not use`` are never chosen.
   More than one best candidate is a question; none is a question.
2. Returns: the screen of each chosen coax goes to the row that returns its signal when a
   convention says it is that signal's return or the row asks for a dedicated screen.
   Several screens on a return row with several destination contacts are split into
   contiguous blocks in stock order.
3. Landings: at each end a conductor lands on the stack terminal that reaches the row's
   contact through the most declared steps (cable-side pad rather than the connector-side
   pad), preferring a path that carries a part the row requires. Equal choices are a
   question. Nothing is invented: no joint, bond, board path or part is added.
4. A required part found on neither end's path is a question, with a suggested
   development need (adapter board) and the workspace's existing needs.

Every proposal is checked by the same checker as a cable (``cable_intent.check``).
"""

from specmate.cables.intent_check import Check, check
from specmate.cables.queries import Closure
from specmate.interfaces.intents import RETURN_LIKE
from specmate.operations import ValidationFailed
from specmate.pcb.component_values import parse_capacitance, parse_resistance

RANK_WORDS = {0: "preferred by convention", 1: "allowed by convention", 2: "a spare"}
PART_KIND = {"series_resistor": "resistor", "series_capacitor": "capacitor"}


def skeleton(intent_revision_id, stock_revision_id, from_end, to_end):
    ends = []
    for local_id, stock_end, end in (("a", "a", from_end), ("b", "b", to_end)):
        ends.append(
            {
                "local_id": local_id,
                "label": end.get("label"),
                "stock_end": end.get("stock_end") or stock_end,
                "end_assembly_revision_id": end.get("end_assembly_revision_id"),
                "stack": end.get("stack"),
            }
        )
    return {
        "schema_version": "0.2",
        "stock_revision_id": str(stock_revision_id),
        "intent_revision_id": str(intent_revision_id),
        "endpoints": ends,
        "assignments": [],
        "review": "unreviewed",
        "review_basis": None,
    }


class Proposer:
    def __init__(self, user, content, intent_revision_id):
        self.user = user
        closure = Closure(user, {"cable": content}, "cable", [intent_revision_id])
        self.check = Check(user, closure, intent_revision_id)
        self.closure = closure
        self.content = content
        self.intent = self.check.intent
        self.name = (
            f"{self.check.intent_revision.definition.name} r{self.check.intent_revision.number}"
        )
        self.rules = self._rules()
        self.used = set()
        self.rows = {}
        self.questions = []
        self.assignments = []

    # -- conventions

    def _rules(self):
        from specmate.interfaces.conventions import stock_conventions

        found = stock_conventions(self.user, self.closure.cable.stock_revision_id)
        exact, coded = {}, {}
        for entry in found["conventions"]:
            source = f"{entry['name']} r{entry['number']}"
            if entry.get("exact") and "convention" in entry:
                for row in entry["convention"]["rows"]:
                    if row.get("element_path"):
                        exact.setdefault(row["element_path"], (row, source))
            for match in entry.get("matches", []):
                coded.setdefault(match["element_path"], (match["rule"], source))
        return {**coded, **exact}

    def rank(self, path, signal):
        """(rank, reason) for using ``path`` for ``signal``; None when never to be chosen."""
        rule = self.rules.get(path)
        if rule is None:
            return 3, "no convention"
        row, source = rule
        use, preference = row["use"], row.get("preference", "preferred")
        if preference == "avoid" or use["kind"] in ("do_not_use", "return_of"):
            return None
        if use["kind"] == "spare":
            return 2, f"a spare in {source}"
        if use["kind"] == "signal" and use.get("signal_key") != signal.key:
            return None
        if use["kind"] == "signal_type" and use.get("signal_type") != signal.type:
            return None
        rank = 0 if preference == "preferred" else 1
        return rank, f"{RANK_WORDS[rank]} {source}"

    def screen_is_return_of(self, screen, key):
        rule = self.rules.get(screen)
        return bool(
            rule
            and rule[0]["use"]["kind"] == "return_of"
            and rule[0]["use"].get("signal_key") == key
        )

    # -- stock

    def kind_of(self, path):
        parent = self.check.parents.get(path)
        return {"coax": "coax", "pair": "pair"}.get(getattr(parent, "role", None), "single")

    def centers(self):
        return [p for p, e in self.closure.elements.items() if e.kind == "conductor"]

    def screen_of(self, center):
        parent = self.check.parents.get(center)
        base = center.rsplit(".", 1)[0]
        for child in getattr(parent, "children", []):
            if child.kind == "shield":
                return f"{base}.{child.id}"
        return None

    # -- landings

    def landing(self, side, contact, parts=()):
        """The stack terminal to land on for a port contact, with its declared steps."""
        start = self.check.near(side, contact)
        if start is None:
            return None, "The end's connector does not map this contact."
        endpoint = start[1]
        candidates = [(start, [])]
        _, resolved = self.closure.endpoints[endpoint]
        for (layer_id, terminal_id), _terminal in resolved.terminals.items():
            node = ("t", endpoint, layer_id, terminal_id)
            if node == start or resolved.layer(layer_id).kind == "shell":
                continue
            if self.check.graph.is_contact(node):
                continue
            found, _ = self.check.graph.paths(node)
            for reached, steps in found:
                if reached == start:
                    candidates.append((node, steps))
                    break
        declared = [c for c in candidates if all(s[2] != "unknown" for s in c[1])] or candidates
        if parts:
            with_part = [c for c in declared if self.carries(c[1], parts)]
            declared = with_part or declared
        longest = max(len(c[1]) for c in declared)
        best = [c for c in declared if len(c[1]) == longest]
        if len(best) > 1:
            labels = ", ".join(self.check.graph.labels[c[0]][1] for c in best)
            return None, f"Several terminals reach this contact equally: {labels}."
        return best[0], None

    def carries(self, steps, parts):
        components = [d["component"] for *_, d in steps if d.get("component") is not None]
        for part in parts:
            kind = PART_KIND.get(part.conditioning)
            if kind is None:
                return False
            parse = parse_resistance if kind == "resistor" else parse_capacitance
            wanted = parse(part.value) if part.value else None
            ok = False
            for c in components:
                if c.kind != kind:
                    continue
                have = c.resistance_ohm if kind == "resistor" else c.capacitance_f
                if have is None and c.value:
                    have = parse(c.value)
                ok = ok or wanted is None or have == wanted
            if not ok:
                return False
        return True

    def land(self, row_id, side, contact, element_path, why, parts=()):
        chosen, problem = self.landing(side, contact, parts)
        if chosen is None:
            self.question(row_id, "landing", problem)
            return None
        node, _ = chosen
        _, endpoint, layer_id, terminal_id = node
        assignment = {
            "endpoint_id": endpoint,
            "element_path": element_path,
            "layer_id": layer_id,
            "terminal_id": terminal_id,
            "basis": f"Proposed from intent {self.name}, row {row_id}: {why}",
        }
        self.assignments.append(assignment)
        self.rows[row_id]["assignments"].append(
            {**assignment, "terminal_label": self.check.graph.labels[node][1]}
        )
        return assignment

    # -- questions

    def question(self, row_id, kind, text, **extra):
        item = {"row_id": row_id, "kind": kind, "text": text, **extra}
        self.questions.append(item)
        self.rows[row_id]["questions"].append(item)

    # -- proposal

    def propose(self):
        returns = {}
        for row in self.intent.rows:
            self.rows[row.row_id] = {
                "row_id": row.row_id,
                "requirement": row.requirement,
                "status": "proposed",
                "conductor": None,
                "reason": None,
                "assignments": [],
                "questions": [],
            }
            signal = self.closure.signal(row.signal_ref) if row.signal_ref else None
            if signal is not None and signal.type in RETURN_LIKE:
                returns[row.row_id] = (row, signal)
        screens = {}
        for row in self.intent.rows:
            entry = self.rows[row.row_id]
            if row.question is not None:
                self.question(row.row_id, "intent_question", "Answer the intent's question first.")
                continue
            if (
                row.requirement == "must_not_connect"
                or not row.from_contact_id
                or not row.to_contact_ids
            ):
                entry["status"] = "not_wired"
                entry["reason"] = (
                    "Must not connect." if row.requirement == "must_not_connect" else "Not wired."
                )
                continue
            if row.row_id in returns:
                continue
            if row.requirement == "optional":
                entry["status"] = "not_wired"
                entry["reason"] = "Optional row; not wired unless you choose."
                continue
            signal = self.closure.signal(row.signal_ref) if row.signal_ref else None
            if signal is None:
                self.question(
                    row.row_id, "no_signal", "The row names no signal to rank conductors by."
                )
                continue
            need = row.conductor.kind
            pool = [
                p
                for p in self.centers()
                if p not in self.used and (need in ("unknown", "any") or self.kind_of(p) == need)
            ]
            ranked = sorted(
                ((r, p) for p in pool if (r := self.rank(p, signal)) is not None),
                key=lambda x: (x[0][0], x[1]),
            )
            kind_text = "" if need in ("unknown", "any") else f"{need} "
            if not ranked:
                self.question(
                    row.row_id,
                    "no_conductor",
                    f"No free {kind_text}conductor may carry {signal.name}.",
                )
                continue
            best = [x for x in ranked if x[0][0] == ranked[0][0][0]]
            if len(best) > 1:
                self.question(
                    row.row_id,
                    "tie",
                    f"{len(best)} conductors are equally suitable for {signal.name}; choose one.",
                    options=[p for _, p in best],
                )
                continue
            (_, why), path = best[0]
            self.used.add(path)
            entry["conductor"] = path
            entry["reason"] = why
            parts = row.required_parts
            part_ends = []
            if parts:
                for side, contact in (("from", row.from_contact_id), ("to", row.to_contact_ids[0])):
                    landing, _ = self.landing(side, contact, parts)
                    if landing and self.carries(landing[1], parts):
                        part_ends.append(side)
                if not part_ends:
                    wanted = ", ".join(
                        f"{p.conditioning.replace('_', ' ')} {p.value or ''}".strip() for p in parts
                    )
                    self.question(
                        row.row_id,
                        "missing_part",
                        f"Neither end carries the required {wanted} on {signal.name}. "
                        "Choose an end with that part, or record it as development work.",
                        development_need={
                            "need": "adapter_board",
                            "summary": f"Adapter with {wanted} on {signal.name}"[:200],
                            "description": f"Cable intent {self.name}, row {row.row_id}: the "
                            "chosen ends declare no such part on this signal's path.",
                        },
                    )
            if len(row.to_contact_ids) > 1:
                self.question(
                    row.row_id,
                    "several_destinations",
                    "One conductor cannot land on several destination contacts.",
                )
                continue
            for side, contact in (("from", row.from_contact_id), ("to", row.to_contact_ids[0])):
                self.land(row.row_id, side, contact, path, why, parts if side in part_ends else ())
            screen = self.screen_of(path)
            if screen and self.kind_of(path) == "coax":
                target = [
                    rid
                    for rid, (_, s) in returns.items()
                    if signal.key in getattr(s, "return_for", [])
                ]
                if len(target) == 1 and (
                    self.screen_is_return_of(screen, signal.key)
                    or row.return_policy == "dedicated_screen"
                ):
                    screens.setdefault(target[0], []).append(screen)
                    self.used.add(screen)
        order = list(self.closure.elements)
        for rid, (row, _) in returns.items():
            entry = self.rows[rid]
            if row.question is not None or not row.from_contact_id or not row.to_contact_ids:
                continue
            assigned = sorted(screens.get(rid, []), key=order.index)
            if not assigned:
                if row.requirement == "required":
                    self.question(
                        rid, "no_return", "No chosen coax screen returns this row's signals."
                    )
                else:
                    entry["status"] = "not_wired"
                continue
            entry["conductor"] = ", ".join(assigned)
            entry["reason"] = "screens of the coax carrying the signals this row returns"
            per = -(-len(assigned) // len(row.to_contact_ids))
            for index, screen in enumerate(assigned):
                target = row.to_contact_ids[min(index // per, len(row.to_contact_ids) - 1)]
                why = "own screen of the coax whose signal this row returns"
                self.land(rid, "from", row.from_contact_id, screen, why)
                self.land(rid, "to", target, screen, why)
        for entry in self.rows.values():
            if entry["questions"]:
                entry["status"] = "question"
        content = {**self.content, "assignments": self.assignments}
        return content


def existing_needs(workspace_id):
    from specmate.design.models import Definition

    return [
        {"definition_id": str(d.id), "name": d.name}
        for d in Definition.objects.filter(
            workspace_id=workspace_id, kind="development_need"
        ).order_by("name")[:50]
    ]


def diff(current, proposed):
    """Per (end, conductor): added, changed or removed against the current draft."""
    key = lambda a: (a["endpoint_id"], a["element_path"])  # noqa: E731
    old = {key(a): a for a in current}
    new = {key(a): a for a in proposed}
    rows = []
    for k in sorted(old.keys() | new.keys()):
        a, b = old.get(k), new.get(k)
        if a and b and (a["layer_id"], a["terminal_id"]) == (b["layer_id"], b["terminal_id"]):
            change = "same"
        else:
            change = "added" if a is None else "removed" if b is None else "changed"
        rows.append(
            {
                "endpoint_id": k[0],
                "element_path": k[1],
                "change": change,
                "current": a,
                "proposed": b,
            }
        )
    return rows


def propose_cable(user, p, draft=None):
    """The proposal, its check result and its difference from the draft, if any."""
    if draft is not None:
        from specmate.cables.queries import parse_content

        current = parse_content(draft.content, "cable").model_dump(mode="json")
        stock = p.stock_revision_id or current["stock_revision_id"]
        ends = [e.model_dump(mode="json") for e in (p.from_end, p.to_end) if e] or current[
            "endpoints"
        ]
        if len(ends) != 2:
            raise ValidationFailed("Choose both ends, or neither to keep the draft's ends.")
        workspace_id = draft.definition.workspace_id
    else:
        current = None
        stock = p.stock_revision_id
        if stock is None or p.from_end is None or p.to_end is None:
            raise ValidationFailed("A new proposal needs a stock and both ends.")
        ends = [p.from_end.model_dump(mode="json"), p.to_end.model_dump(mode="json")]
        workspace_id = None
    content = skeleton(p.intent_revision_id, stock, ends[0], ends[1])
    if current is not None:
        content["lengths"] = current.get("lengths")
        content["endpoints"] = [
            {**e, "local_id": c["local_id"], "label": e.get("label") or c.get("label")}
            for e, c in zip(content["endpoints"], current["endpoints"], strict=True)
        ]
    proposer = Proposer(user, content, p.intent_revision_id)
    proposed = proposer.propose()
    if workspace_id is None:
        workspace_id = proposer.check.intent_revision.definition.workspace_id
    result = check(user, {"cable": proposed}, "cable", p.intent_revision_id)
    return {
        "intent_revision_id": str(p.intent_revision_id),
        "cable": proposed,
        "rows": list(proposer.rows.values()),
        "questions": proposer.questions,
        "existing_needs": existing_needs(workspace_id)
        if any(q["kind"] == "missing_part" for q in proposer.questions)
        else [],
        "check": result,
        "diff": diff(current["assignments"], proposed["assignments"]) if current else None,
        "status": "proposed",
        "review": "required",
    }
