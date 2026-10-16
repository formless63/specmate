"""Bounded graph projection; geometry, shared labels and passages never create copper."""

import hashlib
import json

from specmate.assemblies.queries import Closure as AssemblyClosure
from specmate.cables.queries import Closure as CableClosure
from specmate.copper.contracts import Graph
from specmate.design.models import Revision
from specmate.design.operations import authorize_snapshot
from specmate.design.pins import check_pin
from specmate.harnesses.queries import Closure as HarnessClosure
from specmate.interfaces.contracts import ConnectorBody, InterfaceMap, Pinout
from specmate.interfaces.queries import Closure as InterfaceClosure
from specmate.operations import NotFound, ValidationFailed
from specmate.pcb.population import review_payload

MAX_SNAPSHOTS = 2000
MAX_NODES = 20000
MAX_RECORDS = 40000


def stable(kind, *parts):
    raw = json.dumps(parts, sort_keys=True, separators=(",", ":")).encode()
    return f"{kind}-{hashlib.sha256(raw).hexdigest()}"


def body(revision):
    return json.loads(bytes(revision.snapshot.canonical))["content"]


class Builder:
    def __init__(self, user, root):
        self.user, self.root = user, root
        self.nodes, self.edges, self.boundaries = {}, [], []

    def origin(self, revision, path, **extra):
        return {
            "revision_id": str(revision.id),
            "snapshot_sha256": revision.snapshot.sha256,
            "occurrence_path": list(path),
            **extra,
        }

    def node(self, revision, path, terminal, label, feature_kind, **provenance):
        key = stable("terminal", str(self.root.id), list(path), str(revision.id), terminal)
        if key not in self.nodes and len(self.nodes) >= MAX_NODES:
            raise ValidationFailed("Copper graph terminal limit exceeded.")
        self.nodes[key] = {
            "id": key,
            "occurrence_path": list(path),
            "revision_id": str(revision.id),
            "terminal": terminal,
            "label": label,
            "feature_kind": feature_kind,
            "provenance": self.origin(revision, path, **provenance),
        }
        return key

    def record(
        self,
        revision,
        path,
        local_id,
        kind,
        members,
        basis,
        *,
        boundary=None,
        evidence=None,
        **provenance,
    ):
        if len(self.edges) + len(self.boundaries) >= MAX_RECORDS:
            raise ValidationFailed("Copper graph relationship limit exceeded.")
        origin = self.origin(revision, path, local_id=local_id, **provenance)
        key = stable("boundary" if boundary else "edge", str(self.root.id), origin, kind)
        if boundary:
            self.boundaries.append(
                {
                    "id": key,
                    "kind": kind,
                    "members": members,
                    "status": boundary,
                    "reason": basis,
                    "provenance": origin,
                }
            )
        elif len(members) >= 2:
            self.edges.append(
                {
                    "id": key,
                    "kind": kind,
                    "members": members,
                    "basis": basis,
                    "evidence": evidence
                    or ("reported_net_membership" if kind == "native_net" else "declared_copper"),
                    "provenance": origin,
                }
            )

    def project(self, revision, path, content):
        kind = revision.definition.kind
        from specmate.interfaces.wiring import is_section_cable

        if is_section_cable(content):
            self.harness(revision, path, content)
        elif kind == "cable":
            self.cable(revision, path, content)
        elif kind == "harness":
            self.harness(revision, path, content)
        elif kind in {"connector_body", "pinout", "interface_map"}:
            self.interface(revision, path, content)
        elif kind == "pcb_population":
            self.pcb(revision, path, content)
        elif kind == "board" and "interface" in content:
            self.board(revision, path, content)
        elif kind != "assembly":
            self.record(
                revision,
                path,
                "unsupported",
                "unsupported_definition",
                [],
                "This definition has no supported copper evidence.",
                boundary="unknown",
                definition_kind=kind,
            )

    def cable(self, revision, path, content):
        closure = CableClosure(self.user, content, revision.definition.kind)
        value = closure.cable
        conductors = {}
        for element_path, element in closure.elements.items():
            members = []
            for endpoint in value.endpoints:
                terminal = {
                    "kind": "cable_conductor",
                    "endpoint_id": endpoint.local_id,
                    "element_path": element_path,
                }
                key = self.node(
                    revision,
                    path,
                    terminal,
                    f"{endpoint.local_id} / {element_path}",
                    element.kind,
                    stock_revision_id=str(value.stock_revision_id),
                )
                conductors[endpoint.local_id, element_path] = key
                members.append(key)
            self.record(
                revision,
                path,
                element_path,
                "wire",
                members,
                "Same conductive feature between the two declared cable ends.",
            )
        for bond in closure.stock.bonded_sets or []:
            for endpoint in value.endpoints:
                self.record(
                    revision,
                    path,
                    ["stock_bond", endpoint.local_id, bond.local_id],
                    "stock_bond",
                    [conductors[endpoint.local_id, p] for p in bond.element_paths],
                    bond.basis,
                    stock_revision_id=str(value.stock_revision_id),
                    bond_set_id=bond.local_id,
                    authority="stock_construction",
                )
        terminals = {}
        for endpoint, resolved in closure.endpoints.values():
            self.end_stack(revision, path, endpoint, resolved, terminals)
        for assignment in value.assignments:
            self.record(
                revision,
                path,
                [assignment.endpoint_id, assignment.element_path],
                "termination",
                [
                    conductors[assignment.endpoint_id, assignment.element_path],
                    terminals[assignment.endpoint_id, assignment.layer_id, assignment.terminal_id],
                ],
                assignment.basis,
            )

    def end_stack(self, revision, path, endpoint, resolved, terminals):
        """One cable end's stack: connector contacts, board pads, inline leads, shell body.

        Declared joins, straight board copper and a reviewed carried-connector landing join
        copper; an unreviewed landing is an unknown boundary. Inline parts and component or
        switch board paths never merge copper; they are not-evaluated boundaries. A shell is
        joined only by a declared bond or termination.
        """
        for layer in resolved.layers:
            for terminal in layer["terminals"]:
                if layer["kind"] == "connector":
                    connector = resolved.connectors[layer["layer_id"]]
                    shape = {
                        "kind": "endpoint",
                        "endpoint_id": endpoint.local_id,
                        "contact_id": terminal["terminal_id"],
                    }
                    if resolved.stack.graph_version == "0.2":
                        shape = {
                            "kind": "stack_terminal",
                            "endpoint_id": endpoint.local_id,
                            "layer_id": layer["layer_id"],
                            "terminal_id": terminal["terminal_id"],
                        }
                    extra = {
                        "body_revision_id": str(connector[0].body_revision_id),
                        "pinout_revision_id": str(connector[0].pinout_revision_id),
                    }
                    label = f"{endpoint.local_id} / {terminal['terminal_id']}"
                else:
                    shape = {
                        "kind": "stack_terminal",
                        "endpoint_id": endpoint.local_id,
                        "layer_id": layer["layer_id"],
                        "terminal_id": terminal["terminal_id"],
                    }
                    extra = {"layer_kind": layer["kind"]}
                    label = f"{endpoint.local_id} / {layer['layer_id']} / {terminal['label']}"
                if endpoint.end_assembly_revision_id:
                    extra["end_assembly_revision_id"] = str(endpoint.end_assembly_revision_id)
                terminals[endpoint.local_id, layer["layer_id"], terminal["terminal_id"]] = (
                    self.node(
                        revision,
                        path,
                        shape,
                        label,
                        terminal["kind"],
                        **extra,
                    )
                )

        def key(end):
            return terminals[endpoint.local_id, end["layer_id"], end["terminal_id"]]

        for join in resolved.joins:
            members = [key(join["a"]), key(join["b"])]
            if join.get("through"):
                members.append(key(join["through"]))
            local = [endpoint.local_id, "join", join["local_id"]]
            if join["status"] == "unknown":
                self.record(
                    revision,
                    path,
                    local,
                    "carried_connector_correspondence",
                    members,
                    "Unreviewed board terminal/contact correspondence is unknown.",
                    boundary="unknown",
                    declaration=join,
                )
            else:
                self.record(
                    revision,
                    path,
                    local,
                    "shield_bond" if join["kind"] == "bond" else "join",
                    members,
                    join["basis"],
                    declaration=join,
                )
        for layer, board in resolved.boards.values():
            for node in board.internal_nodes:
                terminals[endpoint.local_id, layer.layer_id, node.node_id] = self.node(
                    revision,
                    path,
                    {
                        "kind": "board_internal_node",
                        "endpoint_id": endpoint.local_id,
                        "layer_id": layer.layer_id,
                        "node_id": node.node_id,
                    },
                    f"Internal graph node: {node.label}",
                    "internal_graph_node",
                    board_revision_id=str(layer.board_revision_id),
                    basis=node.basis,
                )
            for board_path in board.paths:
                members = [
                    terminals[endpoint.local_id, layer.layer_id, board_path.from_terminal],
                    terminals[endpoint.local_id, layer.layer_id, board_path.to_terminal],
                ]
                local = [endpoint.local_id, layer.layer_id, board_path.local_id]
                declaration = board_path.model_dump(mode="json")
                if board_path.via == "copper":
                    self.record(
                        revision,
                        path,
                        local,
                        "board_copper",
                        members,
                        board_path.basis,
                        evidence="reported_net_membership"
                        if board_path.provenance == "reported_net_membership"
                        else "declared_copper",
                        declaration=declaration,
                        board_revision_id=str(layer.board_revision_id),
                    )
                else:
                    self.record(
                        revision,
                        path,
                        local,
                        board_path.component.kind
                        if board_path.component
                        else "conditional"
                        if board_path.switch
                        else "unknown_path",
                        members,
                        board_path.basis,
                        boundary="unknown" if board_path.via == "unknown" else "not_evaluated",
                        declaration=declaration,
                        board_revision_id=str(layer.board_revision_id),
                    )
        for layer in resolved.stack.layers:
            if layer.kind != "inline":
                continue
            for part in layer.parts:
                self.record(
                    revision,
                    path,
                    [endpoint.local_id, layer.layer_id, part.local_id],
                    part.component.kind,
                    [
                        terminals[endpoint.local_id, layer.layer_id, f"{part.local_id}.1"],
                        terminals[endpoint.local_id, layer.layer_id, f"{part.local_id}.2"],
                    ],
                    "An inline part separates copper; its behavior is not evaluated here.",
                    boundary="not_evaluated",
                    declaration=part.model_dump(mode="json"),
                )

    def harness(self, revision, path, content):
        closure = HarnessClosure(self.user, content, revision.definition.kind)
        terminals = {}
        stack_terminals = {}
        for endpoint, resolved in closure.endpoints.values():
            # Harness endpoints are end stacks, projected exactly like a cable end's.
            self.end_stack(revision, path, endpoint, resolved, stack_terminals)
        for row in closure.terminals.values():
            terminal = row["terminal"]
            if terminal["kind"] == "endpoint":
                terminals[json.dumps(terminal, sort_keys=True)] = stack_terminals[
                    terminal["endpoint_id"], terminal["layer_id"], terminal["terminal_id"]
                ]
                continue
            key = self.node(
                revision,
                path,
                terminal,
                " / ".join(str(v) for k, v in terminal.items() if k != "kind"),
                row["feature_kind"],
                **{k: v for k, v in row.items() if k not in {"terminal", "feature_kind", "label"}},
            )
            terminals[json.dumps(terminal, sort_keys=True)] = key

        def resolve(terminal):
            return terminals[json.dumps(terminal, sort_keys=True)]

        for segment, paths in closure.segment_paths.items():
            for element_path in paths:
                members = [
                    resolve(
                        {
                            "kind": "segment",
                            "segment_id": segment,
                            "end": end,
                            "element_path": element_path,
                        }
                    )
                    for end in ("a", "b")
                ]
                self.record(
                    revision,
                    path,
                    [segment, element_path],
                    "wire",
                    members,
                    "Same conductive feature within one declared segment span.",
                    section_id=closure.segments[segment].section_id,
                )
        for relationship in [
            *closure.relationships,
            *closure.construction_bonds,
            *closure.pigtails,
        ]:
            self.record(
                revision,
                path,
                [relationship.get("breakout_id"), relationship["id"]],
                "join"
                if relationship["kind"] in {"solder", "pigtail_preparation"}
                else relationship["kind"],
                [resolve(t) for t in relationship["members"]],
                relationship["basis"],
                **(
                    {"declaration": relationship}
                    if relationship["kind"] in {"solder", "stock_bond", "pigtail_preparation"}
                    else {}
                ),
            )
        for fate in closure.breakout_fates:
            if fate["fate"] not in {"unknown", "unconnected"}:
                continue
            self.record(
                revision,
                path,
                [fate["breakout_id"], fate["terminal"]],
                "breakout_fate",
                [resolve(fate["terminal"])],
                "No breakout connection is declared."
                if fate["fate"] == "unknown"
                else "Explicitly unconnected breakout terminal.",
                boundary="unknown" if fate["fate"] == "unknown" else "declared_unconnected",
                declaration=fate,
            )

    def interface(self, revision, path, content):
        closure = InterfaceClosure(self.user, content, revision.definition.kind)
        value = closure.root
        connector = (
            value
            if isinstance(value, ConnectorBody)
            else closure.body_for(
                value
                if isinstance(value, Pinout)
                else closure.values[value.external_pinout_revision_id]
            )
        )
        keys = {}
        for contact in connector.contacts:
            if contact.physical_role != "key":
                keys[contact.contact_id] = self.node(
                    revision,
                    path,
                    {"kind": "contact", "contact_id": contact.contact_id},
                    contact.contact_id,
                    contact.physical_role,
                )
        if isinstance(value, InterfaceMap):
            for passage in value.passages:
                self.record(
                    revision,
                    path,
                    passage.local_id,
                    "interface_passage",
                    [keys[passage.external_contact_id]],
                    "A declared passage does not specify unconditional copper identity.",
                    boundary="not_evaluated",
                    declaration=passage.model_dump(mode="json"),
                )

    def board(self, revision, path, content):
        """Board terminals; copper paths join them, other paths stay boundaries."""
        closure = InterfaceClosure(self.user, content, revision.definition.kind)
        board = closure.root
        keys = {
            t.terminal_id: self.node(
                revision,
                path,
                {"kind": "board_terminal", "terminal_id": t.terminal_id},
                t.label,
                t.kind,
                group=t.group,
                native_pad_ids=[str(pad) for pad in t.native_pad_ids],
            )
            for t in board.terminals
        }
        for node in board.internal_nodes:
            keys[node.node_id] = self.node(
                revision,
                path,
                {"kind": "board_internal_node", "node_id": node.node_id},
                f"Internal graph node: {node.label}",
                "internal_graph_node",
                basis=node.basis,
            )
        for connector in board.carried_connectors:
            body = closure.values[connector.body_revision_id]
            contacts = {
                c.contact_id: self.node(
                    revision,
                    path,
                    {
                        "kind": "carried_contact",
                        "connector_id": connector.local_id,
                        "contact_id": c.contact_id,
                    },
                    f"{connector.local_id} / {c.number or c.contact_id}",
                    c.physical_role,
                    body_revision_id=str(connector.body_revision_id),
                )
                for c in body.contacts
                if c.physical_role != "key"
            }
            for pair in connector.correspondence:
                self.record(
                    revision,
                    path,
                    [connector.local_id, pair.terminal_id],
                    "carried_connector_correspondence",
                    [keys[pair.terminal_id], contacts[pair.contact_id]],
                    "A declared terminal/contact landing does not assert copper identity."
                    if connector.review == "reviewed"
                    else "Unreviewed terminal/contact correspondence is unknown.",
                    boundary="not_evaluated" if connector.review == "reviewed" else "unknown",
                    declaration={**pair.model_dump(mode="json"), "review": connector.review},
                )
        for board_path in board.paths:
            members = [keys[board_path.from_terminal], keys[board_path.to_terminal]]
            declaration = board_path.model_dump(mode="json")
            if board_path.via == "copper":
                self.record(
                    revision,
                    path,
                    board_path.local_id,
                    "board_copper",
                    members,
                    board_path.basis,
                    evidence="reported_net_membership"
                    if board_path.provenance == "reported_net_membership"
                    else "declared_copper",
                    declaration=declaration,
                )
            else:
                # Components and switches never merge copper; they are interpreted separately.
                self.record(
                    revision,
                    path,
                    board_path.local_id,
                    board_path.component.kind
                    if board_path.component
                    else "conditional"
                    if board_path.switch
                    else "unknown_path",
                    members,
                    board_path.basis,
                    boundary="unknown" if board_path.via == "unknown" else "not_evaluated",
                    declaration=declaration,
                )

    def pcb(self, revision, path, content):
        review = review_payload(self.user, revision.definition, content)
        report = review["report"]
        interpretation = review["interpretation"]
        pads, terminal_labels, nets, component_members = {}, {}, {}, {}
        for pad in report["pads"]:
            if pad["type"] == "npth":
                continue
            key = self.node(
                revision,
                path,
                {"kind": "pad", "pad_id": pad["id"], "component_id": pad["component_id"]},
                pad["terminal"],
                "pad",
                interpretation=interpretation,
                native_net=pad["net"] or None,
            )
            pads[pad["id"]] = key
            component_members.setdefault(pad["component_id"], []).append(key)
            terminal_labels.setdefault(pad["terminal"], []).append(key)
            if pad["net"]:
                nets.setdefault(pad["net"], []).append(key)
        for net, members in nets.items():
            self.record(
                revision,
                path,
                net,
                "native_net",
                members,
                "Native reported net membership; routed copper connectivity is not proven.",
                native_net_id=stable(
                    "native-net",
                    str(self.root.id),
                    list(path),
                    interpretation["interpretation_id"],
                    net,
                ),
                native_net_name=net,
                interpretation=interpretation,
            )
        for index, passage in enumerate(report["component_passages"]):
            members = [
                *terminal_labels.get(passage["from"], []),
                *terminal_labels.get(passage["to"], []),
            ]
            self.record(
                revision,
                path,
                ["passage", index],
                passage["kind"],
                members,
                "A component passage does not merge copper nets; "
                "population and electrical behavior are not interpreted.",
                boundary="not_evaluated",
                declaration=passage,
                interpretation=interpretation,
            )
        for component in report["components"]:
            members = component_members.get(component["id"], [])
            if members:
                self.record(
                    revision,
                    path,
                    ["component", component["id"]],
                    "component_behavior",
                    members,
                    "Component behavior and population are not copper connections.",
                    boundary="unknown",
                    component_id=component["id"],
                    native_dnp=component["dnp"],
                )
        for association in review["population"]["associations"]:
            if association["kind"] == "port":
                key = pads.get(association["pad_id"])
                self.record(
                    revision,
                    path,
                    ["association", association["local_id"]],
                    "port_association",
                    [key] if key else [],
                    "A reviewed pad/contact association does not assert "
                    "electrical same-contact identity.",
                    boundary="not_evaluated",
                    declaration=association,
                )

    def components(self):
        parent = {key: key for key in self.nodes}

        def find(key):
            while parent[key] != key:
                parent[key] = parent[parent[key]]
                key = parent[key]
            return key

        for edge in self.edges:
            head = find(edge["members"][0])
            for member in edge["members"][1:]:
                other = find(member)
                low, high = sorted((find(head), other))
                parent[high] = low
                head = low
        groups = {}
        for key in sorted(self.nodes):
            group = groups.setdefault(
                find(key), {"members": [], "edge_ids": [], "native_net_ids": [], "evidence": set()}
            )
            group["members"].append(key)
            node = self.nodes[key]
            if node["provenance"].get("native_net"):
                origin = node["provenance"]
                net_id = stable(
                    "native-net",
                    str(self.root.id),
                    node["occurrence_path"],
                    origin["interpretation"]["interpretation_id"],
                    origin["native_net"],
                )
                if net_id not in group["native_net_ids"]:
                    group["native_net_ids"].append(net_id)
                group["evidence"].add("reported_net_membership")
        for edge in self.edges:
            group = groups[find(edge["members"][0])]
            group["edge_ids"].append(edge["id"])
            group["evidence"].add(edge["evidence"])
        return sorted(
            [
                {
                    "id": stable("component", sorted(group["members"])),
                    **group,
                    "evidence": sorted(group["evidence"]),
                }
                for group in groups.values()
            ],
            key=lambda c: c["id"],
        )


def inspect_graph(user, query):
    root = (
        Revision.objects.select_related("definition", "snapshot")
        .filter(id=query.revision_id)
        .first()
    )
    # Missing, foreign-workspace (inside a typed closure) and unreadable roots read alike.
    # This precedes occurrence/terminal diagnostics, graph caps and any projection.
    check_pin(user, root)
    # Membership in the root's workspace covers its exact closure (pins never cross
    # workspaces); the walk only bounds the closure before any projection work.
    pending, visited = [root.snapshot], set()
    while pending:
        snapshot = pending.pop()
        if snapshot.id in visited:
            continue
        if len(visited) >= MAX_SNAPSHOTS:
            raise ValidationFailed("Copper graph source closure limit exceeded.")
        visited.add(snapshot.id)
        pending.extend(
            dependency.revision.snapshot
            for dependency in snapshot.dependencies.select_related("revision__snapshot__definition")
        )
    authorize_snapshot(user, root.snapshot)
    content = body(root)
    assembly = AssemblyClosure(
        user, content, kind=root.definition.kind, workspace_id=root.definition.workspace_id
    )
    scope = tuple(query.occurrence_path)
    if scope and scope not in assembly.nodes:
        raise NotFound("Copper graph occurrence unavailable.")
    builder = Builder(user, root)
    if not scope:
        builder.project(root, (), content)
    for path, node in sorted(assembly.nodes.items()):
        if path[: len(scope)] == scope:
            builder.project(node.revision, path, node.content)
    for prefix, relationship in assembly.relationships:
        if prefix[: len(scope)] != scope or relationship.kind not in {"electrical", "mating"}:
            continue
        owner = root if not prefix else assembly.nodes[prefix].revision
        builder.record(
            owner,
            prefix,
            relationship.local_id,
            f"assembly_{relationship.kind}",
            [],
            "This relationship does not specify exact unconditional copper semantics.",
            boundary="not_evaluated",
            declaration=relationship.model_dump(mode="json"),
        )
    components = builder.components()
    selected = None
    if query.terminal_id:
        if query.terminal_id not in builder.nodes:
            raise NotFound("Copper graph terminal unavailable.")
        selected = next(c["id"] for c in components if query.terminal_id in c["members"])
    return Graph(
        root_revision_id=root.id,
        snapshot_id=root.snapshot_id,
        snapshot_sha256=root.snapshot.sha256,
        occurrence_path=query.occurrence_path,
        nodes=sorted(builder.nodes.values(), key=lambda n: n["id"]),
        edges=sorted(builder.edges, key=lambda e: e["id"]),
        boundaries=sorted(builder.boundaries, key=lambda b: b["id"]),
        components=components,
        selected_component_id=selected,
        limitations=[
            "Declared copper and reported net membership are distinct evidence; "
            "neither proves physical continuity.",
            "Shared sections, geometry, labels, mating and associations "
            "create no inferred copper links.",
            "Passive passages, conditional and active behavior require separate interpretation.",
        ],
    ).model_dump(mode="json")
