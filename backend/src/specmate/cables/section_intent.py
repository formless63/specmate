"""Section cable intent checks retain physical section and occurrence addresses.

Connections and component chains reuse the shared checker. Stock facts belong to each
exact section stock. Unimplemented screen/bond evaluation is explicitly unknown.
"""

import json

from specmate.cables.intent_check import Check, Graph, dim
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

    def return_dim(self, row, centers):
        if row.return_policy != "dedicated_screen" or not centers:
            return super().return_dim(row, centers)
        return dim(
            "unknown",
            "Dedicated screen continuity across physical sections requires "
            "a section-aware bond assessment; it has not been evaluated.",
        )

    def _shield_dim(self):
        if self.intent.shield.policy == "unknown":
            return dim("not_evaluated", "The intent states no shield policy.")
        return dim(
            "unknown", "Overall shield bonding across physical sections has not been evaluated."
        )


def check_section_cable(user, content, kind, intent_revision_id, dependencies):
    intent_id = intent_revision_id or content["cable"].get("intent_revision_id")
    closure = Closure(user, content, kind, [*dependencies, *([intent_id] if intent_id else [])])
    if intent_id is None:
        raise ValidationFailed("Pin a cable intent on the cable or name one to check against.")
    # Reuse the physical graph under its cable classification; no synthetic combined stock.
    closure.cable = closure.harness
    result = SectionCheck(user, closure, intent_id).result()
    result["algorithm_version"] = "section_cable_intent_check/0.1"
    result["topology"] = "section_graph"
    return result
