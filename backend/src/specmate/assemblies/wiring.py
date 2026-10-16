"""Exact terminal resolution for assembly-owned joins between reusable wiring products."""

from pydantic import ValidationError

from specmate.operations import ValidationFailed


def canonical_terminal(user, node, terminal):
    """Validate against the exact pinned child and return its copper projection address.

    Called only after full owning assembly closure authority. A new draft or matching
    label on another occurrence never replaces the saved revision's feature identity.
    """
    from specmate.cables.queries import Closure as CableClosure
    from specmate.harnesses.contracts import (
        EndpointTerminal,
        PigtailTerminal,
        SegmentTerminal,
        terminal_key,
    )
    from specmate.harnesses.queries import Closure as SectionClosure
    from specmate.interfaces.contracts import ConnectorBody, Pinout
    from specmate.interfaces.queries import Closure as InterfaceClosure
    from specmate.interfaces.wiring import is_section_cable

    value = terminal.model_dump(mode="json")
    kind = node.revision.definition.kind
    if kind == "harness" or is_section_cable(node.content):
        closure = SectionClosure(user, node.content, kind)
        model = {
            "segment": SegmentTerminal,
            "pigtail": PigtailTerminal,
            "stack_terminal": EndpointTerminal,
        }.get(terminal.kind)
        if model is None:
            raise ValidationFailed(
                "This wiring occurrence requires an exact material or stack terminal."
            )
        request = {**value, "kind": "endpoint"} if terminal.kind == "stack_terminal" else value
        try:
            resolved_terminal = model.model_validate(request)
            closure.resolve(resolved_terminal)
            if (
                terminal.kind != "stack_terminal"
                and terminal_key(resolved_terminal) in closure.owners
            ):
                raise ValidationFailed(
                    "An assembly join requires an exposed, unowned material end."
                )
        except ValidationError:
            raise ValidationFailed("Invalid exact wiring terminal.") from None
        if terminal.kind != "stack_terminal":
            return value
        resolved = closure.endpoints[terminal.endpoint_id][1]
    elif kind == "cable":
        if terminal.kind != "stack_terminal":
            raise ValidationFailed("A simple cable exposes exact end-stack terminals here.")
        closure = CableClosure(user, node.content, kind)
        endpoint = closure.endpoints.get(terminal.endpoint_id)
        if endpoint is None:
            raise ValidationFailed("Exact cable endpoint is absent.")
        resolved = endpoint[1]
        resolved.require(terminal.layer_id, terminal.terminal_id, "An assembly electrical join")
    elif kind in {"connector_body", "pinout"} and terminal.kind == "contact":
        closure = InterfaceClosure(user, node.content, kind)
        root = closure.root
        body = (
            root
            if isinstance(root, ConnectorBody)
            else closure.body_for(root)
            if isinstance(root, Pinout)
            else None
        )
        if body is None or not any(
            c.contact_id == terminal.contact_id and c.physical_role != "key" for c in body.contacts
        ):
            raise ValidationFailed("Exact connector contact is absent or nonconductive.")
        return value
    else:
        raise ValidationFailed("This occurrence has no supported exact wiring terminal.")
    layer = resolved.layer(terminal.layer_id)
    if layer.kind == "connector" and resolved.stack.graph_version == "0.1":
        return {
            "kind": "endpoint",
            "endpoint_id": terminal.endpoint_id,
            "contact_id": terminal.terminal_id,
        }
    return value
