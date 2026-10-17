"""Section cable intent checks retain physical section and occurrence addresses.

Connections and component chains reuse the shared checker. Stock facts belong to each
exact section stock. Return and shield checks distinguish physical end-local landings
from remote electrical reachability and preserve missing return relations as unknown.
"""

import json

from specmate.cables.intent_check import MAX_DEPTH, MAX_PATHS, Check, Graph, dim, path_status
from specmate.harnesses.queries import Closure
from specmate.interfaces.conventions import stock_conventions
from specmate.operations import NotFound, PermissionDenied, ValidationFailed
from specmate.wire_stock.electrical import impedance_fact, ohm_value
from specmate.wire_stock.schemas import StockSpecification


def feature_key(section_id, path):
    return f"{section_id}::{path}"


def terminal_node(member):
    if member["kind"] == "endpoint":
        return ("t", member["endpoint_id"], member["layer_id"], member["terminal_id"])
    if member["kind"] == "pigtail":
        return ("p", member["segment_id"], member["end"], member["pigtail_id"])
    return ("s", member["segment_id"], member["end"], member["element_path"])


class SectionGraph(Graph):
    def __init__(self, closure):
        self.closure, self.adjacent, self.labels = closure, {}, {}
        self.connector, self.connector_occurrences = {}, {}
        for endpoint_id, (_, resolved) in closure.endpoints.items():
            self.connector_occurrences[endpoint_id] = set(resolved.connectors)
            if resolved.connector:
                self.connector[endpoint_id] = resolved.connector[0].layer_id
            for (layer_id, terminal_id), terminal in resolved.terminals.items():
                self.labels[("t", endpoint_id, layer_id, terminal_id)] = (
                    resolved.layer(layer_id).kind,
                    f"{endpoint_id}/{layer_id}/{terminal['label']}",
                )
            for layer, board in resolved.boards.values():
                for node in getattr(board, "internal_nodes", []):
                    self.labels[("t", endpoint_id, layer.layer_id, node.node_id)] = (
                        "internal_graph_node",
                        node.label,
                    )
            # Includes explicit solder/carrier joints and all exact board component paths.
            for a, b, status, text, detail in resolved.edges:
                self.edge(
                    ("t", endpoint_id, *a),
                    ("t", endpoint_id, *b),
                    status,
                    text,
                    {**detail, "endpoint_id": endpoint_id, "layer_id": a[0]},
                )
        for segment_id, paths in closure.segment_paths.items():
            section_id = closure.segments[segment_id].section_id
            for path in paths:
                a, b = ("s", segment_id, "a", path), ("s", segment_id, "b", path)
                label = f"{section_id}/{segment_id}/{path}"
                self.labels[a] = self.labels[b] = ("conductor", label)
                self.edge(
                    a,
                    b,
                    "declared",
                    label,
                    {
                        "kind": "conductor",
                        "element_path": feature_key(section_id, path),
                        "section_id": section_id,
                        "segment_id": segment_id,
                        "stock_element_path": path,
                    },
                )
        for relationship in [
            *closure.relationships,
            *closure.construction_bonds,
            *closure.pigtails,
        ]:
            members = [terminal_node(m) for m in relationship["members"]]
            for node in members:
                self.labels.setdefault(node, ("pigtail", "/".join(node[1:])))
            for target in members[1:]:
                self.edge(
                    members[0],
                    target,
                    "declared",
                    relationship["basis"],
                    {
                        "kind": relationship["kind"],
                        "local_id": relationship["id"],
                        "basis": relationship["basis"],
                    },
                )


class SectionCheck(Check):
    def _graph(self, closure):
        return SectionGraph(closure)

    def _stock_parents(self):
        self.stock_by_path = {}
        self.closure.elements = {}
        for section_id, elements in self.closure.constructions.items():
            section = self.closure.sections[section_id]
            revision = self.closure.revisions[section.stock_revision_id]
            stock = StockSpecification.model_validate(
                json.loads(bytes(revision.snapshot.canonical))["content"]["stock"]
            )

            def visit(node, prefix="", section_id=section_id):
                path = f"{prefix}.{node.id}" if prefix else node.id
                for child in getattr(node, "children", []):
                    self.parents[feature_key(section_id, f"{path}.{child.id}")] = node
                    visit(child, path)

            visit(stock.structure)
            for path, element in elements.items():
                key = feature_key(section_id, path)
                self.stock_by_path[key] = stock
                self.closure.elements[key] = element

    def _map_ends(self):
        if self.closure.cable.intent_contact_bindings:
            return self._binding_ends(
                {"from": self.intent.from_revision_id, "to": self.intent.to_revision_id}
            )
        choices = {choice.side: choice for choice in self.closure.cable.intent_endpoints}
        if not choices:
            raise ValidationFailed(
                "Section cable intent mapping requires exact endpoint and connector "
                "occurrence choices; no two ends are inferred."
            )
        return self._chosen_ends(
            {"from": self.intent.from_revision_id, "to": self.intent.to_revision_id}, choices
        )

    def _conventions(self):
        rules = {}
        for section_id, section in self.closure.sections.items():
            try:
                found = stock_conventions(self.user, section.stock_revision_id)
            except (NotFound, PermissionDenied):
                continue
            for entry in found["conventions"]:
                if entry.get("exact") and "convention" in entry:
                    for row in entry["convention"]["rows"]:
                        if row.get("element_path"):
                            rules.setdefault(
                                feature_key(section_id, row["element_path"]), (entry, row)
                            )
        return rules

    def conductor_dim(self, row, centers):
        need = row.conductor
        if need.kind in ("unknown", "any"):
            return dim("not_evaluated", "The intent states no conductor requirement.")
        if not centers:
            return dim("not_evaluated", "No conductor is on the path.")
        unknown = []
        for path in set(centers):
            role = getattr(self.parents.get(path), "role", None)
            kind = {"coax": "coax", "pair": "pair"}.get(role, "single")
            if kind != need.kind:
                return dim("fail", f"{path} is a {kind} conductor; the intent needs {need.kind}.")
            if need.impedance_ohm is not None:
                fact = impedance_fact(self.stock_by_path[path], path.split("::", 1)[1])
                value = ohm_value(fact)
                if value is None:
                    unknown.append(path)
                elif abs(value - need.impedance_ohm) > 1e-9:
                    return dim(
                        "fail",
                        f"{path} impedance {value:g} ohm; "
                        f"the intent needs {need.impedance_ohm:g} ohm.",
                    )
        if unknown:
            return dim(
                "unknown", "No characteristic impedance is declared for " + ", ".join(unknown)
            )
        return dim(
            "pass",
            "Every traversed section has the required conductor construction "
            "and any requested impedance.",
            "exact section stock declarations",
        )

    def convention_dim(self, row, centers):
        checks = [super(SectionCheck, self).convention_dim(row, [path]) for path in set(centers)]
        return next(
            (c for c in checks if c["status"] == "flagged"),
            next(
                (c for c in checks if c["status"] != "pass"),
                checks[0] if checks else dim("not_evaluated", "No conductor on path."),
            ),
        )

    def _return_relation(self, row, side, contact):
        """Only an independent exact signal-set return_for relation proves a return."""
        signal = (self.pins[side].get(contact) or {}).get("signal")
        if not signal or row.signal_ref is None:
            return "unknown"
        if signal["type"] != "ground_return":
            return "fail"
        if str(row.signal_ref.signal_set_revision_id) != str(signal["signal_set_revision_id"]):
            return "unknown"
        from specmate.interfaces.signal_contracts import SignalRef

        declared = self.closure.signal(
            SignalRef(signal_set_revision_id=signal["signal_set_revision_id"], key=signal["key"])
        )
        if not declared.return_for:
            return "unknown"  # Generic ground is not an invented dedicated return.
        return "pass" if row.signal_ref.key in declared.return_for else "fail"

    @staticmethod
    def _copper_status(steps):
        if path_status(steps) == "unknown" or any(
            step[-1].get("component") is not None for step in steps
        ):
            return "unknown"
        return "pass"

    def _screen_side(self, row, start, side):
        found, _ = self.graph.paths(start)
        limited = self.graph.limited
        possible = limited
        for node, steps in found:
            mapped_side, contact = self.port_contact(node)
            if mapped_side != side:
                continue
            relation = self._return_relation(row, side, contact)
            status = self._copper_status(steps)
            if relation == "pass" and status == "pass":
                return "pass"
            possible = possible or relation == "unknown" or status == "unknown"
        return "unknown" if possible else "fail"

    def _shared_return(self, row):
        candidates = {
            side: [
                contact
                for contact in self.pins[side]
                if self._return_relation(row, side, contact) == "pass"
            ]
            for side in ("from", "to")
        }
        if not all(candidates.values()):
            return dim(
                "unknown",
                "No exact return_for relation establishes shared ground at both ports.",
            )
        possible = False
        for contact in candidates["from"]:
            start = self.near("from", contact)
            if start is None:
                possible = True
                continue
            found, _ = self.graph.paths(start)
            possible = possible or self.graph.limited
            for node, steps in found:
                side, target = self.port_contact(node)
                if side == "to" and target in candidates["to"]:
                    if self._copper_status(steps) == "pass":
                        return dim(
                            "pass",
                            "The independent shared return has a declared copper path "
                            "between both ports.",
                            "exact signal return_for and wiring declarations",
                        )
                    possible = True
        return dim(
            "unknown" if possible else "fail",
            "The declared shared return has no confirmed declared copper path between both ports.",
        )

    def return_dim(self, row, centers, steps=()):
        if row.return_policy == "shared_ground":
            return self._shared_return(row)
        if row.return_policy != "dedicated_screen" or not centers:
            return super().return_dim(row, centers, steps)
        # Every traversed physical span needs its own declared screen; do not pool
        # unrelated pieces simply because they use the same stock path spelling.
        screens = []
        for *_, detail in steps:
            if detail.get("kind") != "conductor" or detail["element_path"] not in centers:
                continue
            parent = self.parents.get(detail["element_path"])
            prefix = detail["stock_element_path"].rsplit(".", 1)[0]
            own = [
                f"{prefix}.{child.id}"
                for child in getattr(parent, "children", [])
                if child.kind == "shield"
            ]
            if not own:
                return dim(
                    "fail", f"{detail['stock_element_path']} has no declared screen of its own."
                )
            for screen in own:
                start = ("s", detail["segment_id"], "a", screen)
                if start not in self.graph.labels:
                    return dim(
                        "fail", f"The span {detail['segment_id']} omits its own screen {screen}."
                    )
                screens.append(start)
        if not screens:
            return dim("unknown", "The exact traversed screen spans are unavailable.")
        local = [
            (start, end, self._screen_end_return(row, (*start[:2], end, start[3])))
            for start in set(screens)
            for end in ("a", "b")
        ]
        missing = next(((start, end) for start, end, status in local if status == "fail"), None)
        if missing:
            return dim(
                "fail",
                f"Own screen {missing[0][3]} has no local landing or screen continuation "
                f"at {missing[0][1]}/{missing[1]}.",
            )
        statuses = [
            (start, side, self._screen_side(row, start, side))
            for start in set(screens)
            for side in ("from", "to")
        ]
        failed = next(((start, side) for start, side, status in statuses if status == "fail"), None)
        if failed:
            return dim(
                "fail",
                f"Own screen {failed[0][3]} on {failed[0][1]} has no declared "
                f"copper landing on this signal's return at the {failed[1]} port.",
            )
        if any(status == "unknown" for _, _, status in [*statuses, *local]):
            return dim(
                "unknown",
                "A screen path, landing signal or exact return_for relation remains unknown.",
            )
        return dim(
            "pass",
            "Every traversed span's own screen has a declared copper path to this "
            "signal's independent return at both ports.",
            "exact section screens, bonds, pigtails and signal return_for declarations",
        )

    def _side_occurrences(self):
        pairs = {}
        for side, end in self.ends.items():
            pairs[side] = (
                {(target[1], target[2]) for target in end.get("contacts", {}).values()}
                if "contacts" in end
                else {(end["endpoint_id"], end["layer_id"])}
            )
        return pairs

    def _physical_sides(self, node):
        if node[0] != "t":
            return set()
        pairs = self._side_occurrences()
        if self.graph.labels.get(node, (None,))[0] == "shell":
            return {
                side
                for side, occurrences in pairs.items()
                if node[1] in {end for end, _ in occurrences}
            }
        return {side for side, occurrences in pairs.items() if (node[1], node[2]) in occurrences}

    def _local_nodes(self, start):
        """Bounded end-local traversal, excluding every longitudinal stock span."""
        found = []
        queue = [(start, False, frozenset({start}), 0)]
        limited = False
        while queue and len(found) < MAX_PATHS * MAX_DEPTH:
            node, uncertain, seen, depth = queue.pop()
            found.append((node, uncertain))
            if self.graph.is_contact(node):
                continue
            if depth >= MAX_DEPTH:
                limited = True
                continue
            for neighbor, status, _, detail in self.graph.adjacent.get(node, []):
                if neighbor in seen or detail.get("kind") == "conductor":
                    continue
                queue.append(
                    (
                        neighbor,
                        uncertain or status == "unknown" or detail.get("component") is not None,
                        seen | {neighbor},
                        depth + 1,
                    )
                )
        return found, limited or bool(queue)

    def _screen_end_return(self, row, start):
        """Each screen end must actually land or continue, not borrow a remote bond."""
        found, limited = self._local_nodes(start)
        possible = limited
        for node, uncertain in found:
            if node == start:
                continue
            if node[0] == "s" and node[1] != start[1]:
                record = self.closure.terminals[("segment", *node[1:])]
                if record["feature_kind"] in {"shield", "drain"}:
                    if not uncertain:
                        return "pass"
                    possible = True
                else:
                    possible = True
            if self.graph.is_contact(node):
                side, contact = self.port_contact(node)
                relation = self._return_relation(row, side, contact) if side else "unknown"
                if relation == "pass" and not uncertain:
                    return "pass"
                possible = possible or uncertain or relation == "unknown"
        return "unknown" if possible else "fail"

    def _local_bonds(self, start):
        """Local shield preparations do not propagate through other ground wires."""
        found = {"from": set(), "to": set()}
        nodes, limited = self._local_nodes(start)
        for node, uncertain in nodes:
            if (
                not self.graph.is_contact(node)
                and self.graph.labels.get(node, (None,))[0] != "shell"
            ):
                continue
            sides = self._physical_sides(node)
            for side in sides:
                found[side].add("unknown" if uncertain or len(sides) != 1 else "bonded")
        return found, limited

    def _shield_dim(self):
        policy = self.intent.shield.policy
        if policy == "unknown":
            return dim("not_evaluated", "The intent states no shield policy.")
        wanted = {
            "bond_from": (True, False),
            "bond_to": (False, True),
            "bond_both": (True, True),
            "isolated": (False, False),
        }[policy]
        if not all(self._side_occurrences().values()):
            return dim(
                "unknown", "Exact physical port bindings are incomplete for shield assessment."
            )
        # A shield mass may continue through several physical stock sections. Merge
        # only material copper declarations, never board/connector ground ties.
        parents = {}
        for node in self.graph.labels:
            if node[0] == "p" or (
                node[0] == "s"
                and self.closure.terminals[("segment", *node[1:])]["feature_kind"]
                in {"shield", "drain"}
            ):
                parents[node] = node

        def root(node):
            while parents[node] != node:
                parents[node] = parents[parents[node]]
                node = parents[node]
            return node

        for node in parents:
            for neighbor, status, _, detail in self.graph.adjacent.get(node, []):
                if neighbor in parents and status != "unknown" and detail.get("component") is None:
                    parents[root(neighbor)] = root(node)
        masses = {}
        for section_id, stock in self.closure.stocks.items():
            overall = {
                f"{stock.structure.id}.{child.id}"
                for child in getattr(stock.structure, "children", [])
                if child.kind in {"shield", "drain"}
            }
            for segment_id, paths in self.closure.segment_paths.items():
                if self.closure.segments[segment_id].section_id != section_id:
                    continue
                for screen in overall & set(paths):
                    for end in ("a", "b"):
                        node = ("s", segment_id, end, screen)
                        masses.setdefault(root(node), []).append((section_id, node))
        observations = []
        unknown = False
        for members in masses.values():
            found = {"from": set(), "to": set()}
            section_limited = False
            for _, node in members:
                reached, limited = self._local_bonds(node)
                section_limited = section_limited or limited
                for side in found:
                    found[side].update(reached[side])
            got = tuple("bonded" in found[side] for side in ("from", "to"))
            uncertain = tuple(
                ("unknown" in found[side] or section_limited) and "bonded" not in found[side]
                for side in ("from", "to")
            )
            sections = ", ".join(sorted({section for section, _ in members}))
            for index in range(2):
                if uncertain[index]:
                    unknown = True
                elif got[index] != wanted[index]:
                    return dim(
                        "fail",
                        f"Overall shield mass in {sections} is locally bonded "
                        f"from={got[0]}, to={got[1]}; the intent needs {policy}.",
                        "explicit local stock construction and end landings",
                    )
            observations.append(sections)
        if not observations:
            return dim("not_evaluated", "No section declares an overall shield or drain.")
        if unknown:
            return dim(
                "unknown", "An overall shield's local bond path or bounded search remains unknown."
            )
        return dim(
            "pass",
            f"Overall shield local bonding matches {policy} for every declared mass.",
            "explicit stock bonds, end preparations and landings",
        )


def check_section_cable(user, content, kind, intent_revision_id, dependencies):
    intent_id = intent_revision_id or content["cable"].get("intent_revision_id")
    closure = Closure(user, content, kind, [*dependencies, *([intent_id] if intent_id else [])])
    if intent_id is None:
        raise ValidationFailed("Pin a cable intent on the cable or name one to check against.")
    # Reuse the physical graph under its cable classification; no synthetic combined stock.
    closure.cable = closure.harness
    result = SectionCheck(user, closure, intent_id).result()
    result["algorithm_version"] = "section_cable_intent_check/0.2"
    result["topology"] = "section_graph"
    return result
