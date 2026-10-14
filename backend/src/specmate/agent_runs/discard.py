"""Discarding a definition (and its drafts) that an agent run created.

A created definition may be removed from a review only if nothing references it and it
has no frozen state. Every reference found is reported as a blocker instead; nothing is
removed in that case. References are discovered from the model graph, so a new model
that points at a definition or draft blocks the discard without further code here.
"""

from __future__ import annotations

from collections import Counter

from specmate.agent_runs.capture import record_ref
from specmate.design.models import Definition, Draft, Revision, Snapshot

FROZEN = {Revision: "frozen revision", Snapshot: "snapshot"}


def _counts(instance, model) -> Counter:
    found: Counter = Counter()
    # include_hidden: related_name="+" references still count as references.
    for rel in model._meta.get_fields(include_hidden=True):
        if not (rel.auto_created and not rel.concrete):
            continue
        related = rel.related_model
        if related is Draft and model is Definition:
            continue  # the definition's own drafts are discarded with it
        if related is Snapshot and model is Draft:
            continue  # already counted through the definition
        if not (rel.one_to_many or rel.one_to_one):
            continue
        count = related._base_manager.filter(**{rel.field.name: instance}).count()
        if count:
            found[related] += count
    return found


def blockers(definition: Definition) -> list[dict]:
    """Everything that stops the definition and its drafts from being discarded."""
    found = _counts(definition, Definition)
    for draft in Draft.objects.filter(definition=definition):
        found += _counts(draft, Draft)
    out = []
    for related, count in sorted(found.items(), key=lambda kv: kv[0]._meta.label_lower):
        label = related._meta.label_lower
        frozen = related in FROZEN
        out.append(
            {
                "kind": "frozen" if frozen else "reference",
                "model": label,
                "count": count,
                "reason": (
                    f"{count} {FROZEN[related]}(s) exist"
                    if frozen
                    else f"{count} {label} record(s) reference it"
                ),
            }
        )
    return out


def records_of(definition: Definition) -> list[str]:
    drafts = Draft.objects.filter(definition=definition).values_list("pk", flat=True)
    return [record_ref(Definition, definition.pk), *(record_ref(Draft, pk) for pk in drafts)]


def created_definition_pk(step_changes: list[dict], change: dict) -> str | None:
    """The definition a created-record change belongs to, if the step created it."""
    created = {c["record"]: c for c in step_changes if c["action"] == "created"}
    if change["model"] == "design.definition" and change["action"] == "created":
        return change["pk"]
    if change["model"] == "design.draft" and change["action"] == "created":
        definition_pk = (change.get("after") or {}).get("definition_id")
        if record_ref(Definition, definition_pk) in created:
            return str(definition_pk)
    return None
