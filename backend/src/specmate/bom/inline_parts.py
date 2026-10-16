"""Physical inline uses, distinct from assembly occurrence paths and board contents."""

import json

from specmate.interfaces.end_assembly_contracts import EndAssembly
from specmate.interfaces.wiring import is_section_cable
from specmate.operations import ValidationFailed


def inline_parts(revision, revisions):
    """Read already-authorized exact declarations; never infer a component from Part metadata."""
    kind = revision.definition.kind
    if kind not in {"cable", "harness", "end_assembly"}:
        return []
    content = json.loads(bytes(revision.snapshot.canonical))["content"]
    if kind == "end_assembly":
        endpoints = [(None, EndAssembly.model_validate(content["interface"]).stack)]
    else:
        from specmate.cables.contracts import Cable, SectionCable
        from specmate.harnesses.contracts import Harness

        model = SectionCable if is_section_cable(content) else Cable if kind == "cable" else Harness
        value = model.model_validate(content[kind])
        endpoints = []
        for endpoint in value.endpoints:
            stack = endpoint.stack
            if endpoint.end_assembly_revision_id:
                saved = revisions.get(endpoint.end_assembly_revision_id)
                if saved is None:
                    raise ValidationFailed("Exact inline end assembly is unavailable.")
                body = json.loads(bytes(saved.snapshot.canonical))["content"]
                stack = EndAssembly.model_validate(body["interface"]).stack
            endpoints.append((endpoint.local_id, stack))
    result = []
    for endpoint_id, stack in endpoints:
        for layer in stack.layers:
            if layer.kind == "inline":
                for part in layer.parts:
                    if part.part_revision_id:
                        pinned = revisions.get(part.part_revision_id)
                        if pinned is None or pinned.definition.kind != "part":
                            raise ValidationFailed("Exact inline catalog Part is unavailable.")
                        result.append(
                            (
                                {
                                    "endpoint_id": endpoint_id,
                                    "layer_id": layer.layer_id,
                                    "part_local_id": part.local_id,
                                },
                                pinned,
                            )
                        )
    return result
