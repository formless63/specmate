"""Choose physical wiring semantics from content, never from graph complexity."""

import json


def is_section_cable(content):
    value = content.get("cable") if isinstance(content, dict) else None
    return isinstance(value, dict) and value.get("schema_version") == "0.3"


def revision_content(revision):
    return json.loads(bytes(revision.snapshot.canonical))["content"]


def is_section_revision(revision):
    return revision.definition.kind == "harness" or is_section_cable(revision_content(revision))
