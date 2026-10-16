"""Choose physical wiring semantics from content, never from graph complexity."""

import json


def is_section_cable(content):
    value = content.get("cable") if isinstance(content, dict) else None
    return isinstance(value, dict) and value.get("schema_version") == "0.3"


def revision_content(revision):
    return json.loads(bytes(revision.snapshot.canonical))["content"]


def is_section_revision(revision):
    return revision.definition.kind == "harness" or is_section_cable(revision_content(revision))


def validate_intent_endpoints(value, endpoints):
    from specmate.operations import ValidationFailed

    for choice in getattr(value, "intent_endpoints", []):
        endpoint = endpoints.get(choice.endpoint_id)
        if endpoint is None or choice.layer_id not in endpoint[1].connectors:
            raise ValidationFailed(
                "Intent mapping requires an exact endpoint connector occurrence."
            )

    for binding in getattr(value, "intent_contact_bindings", []):
        endpoint = endpoints.get(binding.endpoint_id)
        if endpoint is None or binding.layer_id not in endpoint[1].connectors:
            raise ValidationFailed("Intent contact binding requires an exact connector occurrence.")
        endpoint[1].require(binding.layer_id, binding.terminal_id, "Intent contact binding")
