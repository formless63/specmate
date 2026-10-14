"""Deterministic, permission-complete resolution shared by every adapter.

Resolution reads only exact frozen revisions: the configuration pins one option-set
revision, every revision choice is an exact pin, and the optional target is a frozen
assembly revision. Mutable drafts and later revisions are never consulted, so a
captured resolution is reproducible. Compatibility between choices is not inferred
here (labels, names and part numbers prove nothing); it stays `not_evaluated`. Rules the
option set declares are evaluated explicitly (constraints.py) with valid/invalid/unknown/
not-evaluated outcomes; their fact reads are recorded by assertion ID in the resolution.
"""

from __future__ import annotations

import hashlib
import json

from pydantic import ValidationError

from specmate.configurations.contracts import (
    DOMAIN_KINDS,
    EXCLUDED_KINDS,
    OCCURRENCE_DOMAINS,
    ConfigurationContent,
    OptionSetContent,
)
from specmate.design.closure_reads import authorized_revision, remember_authorized_revision
from specmate.design.models import Revision
from specmate.design.pins import check_pin
from specmate.operations import NotFound, ValidationFailed

KINDS = {"option_set": "option_set", "configuration": "configuration"}
NOT_EVALUATED = {
    "compatibility": "not_evaluated",
    "physical_qualification": False,
}


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def digest(value) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def _parse(model, kind, key, content):
    if key not in content:
        if kind == key:
            raise ValidationFailed(f"Typed {key.replace('_', ' ')} content is required.")
        return None
    if kind != key:
        raise ValidationFailed(f"{key.replace('_', ' ').capitalize()} content needs its own kind.")
    if set(content) != {key}:
        raise ValidationFailed(f"{key.replace('_', ' ').capitalize()} content has one typed field.")
    try:
        return model.model_validate(content[key])
    except ValidationError:
        # Do not echo submitted identifiers or values in diagnostics.
        raise ValidationFailed(f"Invalid {key.replace('_', ' ')} content.") from None


def parse_option_set(content, kind=None):
    return _parse(OptionSetContent, kind, "option_set", content)


def parse_configuration(content, kind=None):
    return _parse(ConfigurationContent, kind, "configuration", content)


def validate_content(kind, content):
    option_set = parse_option_set(content, kind)
    if option_set is not None:
        return {"option_set": option_set.model_dump(mode="json")}
    configuration = parse_configuration(content, kind)
    if configuration is not None:
        return {"configuration": configuration.model_dump(mode="json")}
    return content


class Reader:
    """Authorize each exact revision closure once per synchronous traversal."""

    def __init__(self, user):
        self.user = user
        self.authorized = set()
        self.revisions = {}

    def revision(self, revision_id, message="Configuration input unavailable."):
        from specmate.design.operations import authorize_snapshot

        key = str(revision_id)
        if key in self.revisions:
            return self.revisions[key]
        revision = authorized_revision(self.user, revision_id)
        if revision is not None:
            # Closure already authorized in this traversal; the pin scope is still checked.
            check_pin(self.user, revision)
            self.revisions[key] = revision
            return revision
        revision = (
            Revision.objects.select_related("definition", "snapshot__definition")
            .filter(id=revision_id)
            .first()
        )
        # Missing, foreign-workspace and non-member pins all read as the same NotFound.
        check_pin(self.user, revision)
        try:
            authorize_snapshot(self.user, revision.snapshot, _authorized=self.authorized)
        except NotFound:
            raise NotFound(message) from None
        remember_authorized_revision(self.user, revision)
        self.revisions[key] = revision
        return revision

    @staticmethod
    def content(revision):
        return json.loads(bytes(revision.snapshot.canonical))["content"]


def pin(revision):
    return {
        "revision_id": str(revision.id),
        "definition_id": str(revision.definition_id),
        "kind": revision.definition.kind,
        "name": revision.definition.name,
        "number": revision.number,
        "snapshot_sha256": revision.snapshot.sha256,
    }


def _target(reader, option_set):
    if option_set.target_revision_id is None:
        return None, None
    from specmate.assemblies.queries import get_snapshot

    target = reader.revision(option_set.target_revision_id)
    if target.definition.kind != "assembly":
        raise ValidationFailed("An option-set target must be a frozen assembly revision.")
    _, closure = get_snapshot(reader.user, target.snapshot_id)
    return target, closure


def check_option_set(reader, option_set):
    """Authorize and check exact pins; return target revision and assembly closure."""
    target, closure = _target(reader, option_set)
    for option in option_set.options:
        if option.domain in OCCURRENCE_DOMAINS:
            node = closure.nodes.get(tuple(option.path))
            if node is None:
                raise ValidationFailed("An option path does not resolve in the target assembly.")
            if node.revision.definition.kind != "pcb_population":
                raise ValidationFailed(
                    "Population and firmware options address a board population occurrence."
                )
        for choice in option.choices:
            if choice.revision_id is None:
                continue
            revision = reader.revision(choice.revision_id)
            kind = revision.definition.kind
            if kind in EXCLUDED_KINDS:
                raise ValidationFailed("Option sets and configurations are not choices.")
            required = DOMAIN_KINDS.get(option.domain)
            if required and kind != required:
                raise ValidationFailed(
                    f"A {option.domain} choice requires an exact {required} revision."
                )
            if option.domain == "population":
                options = reader.content(revision)["pcb_population"].get("options", [])
                if choice.population_option_id not in {o["local_id"] for o in options}:
                    raise ValidationFailed(
                        "A population choice names an option absent from its revision."
                    )
    return target, closure


def option_set_revision(reader, revision_id):
    revision = reader.revision(revision_id)
    if revision.definition.kind != "option_set":
        raise ValidationFailed("A configuration pins one frozen option-set revision.")
    return revision, parse_option_set(reader.content(revision), "option_set")


def _choice(reader, option, choice):
    result = {"key": choice.key, "label": choice.label, "value": choice.value}
    if choice.revision_id is not None:
        revision = reader.revision(choice.revision_id)
        result["revision"] = pin(revision)
        if option.domain == "population":
            result["population_option_id"] = choice.population_option_id
        if option.domain == "firmware":
            target = reader.content(revision)["firmware"]["target"]
            # A declaration recorded for later constraint evaluation, not a compatibility result.
            result["declared_target"] = {
                "population_revision_id": target.get("population_revision_id"),
                "option_id": target.get("option_id"),
            }
    else:
        result["revision"] = None
    return result


def _base(closure, option):
    if option.domain not in OCCURRENCE_DOMAINS:
        return None
    path = tuple(option.path)
    node = closure.nodes[path]
    assigned = closure.assignments.get(path) or node.occurrence.assignments
    base = {
        "display_ref": node.occurrence.display_ref,
        "population_revision_id": str(node.revision.id),
        "population_snapshot_sha256": node.revision.snapshot.sha256,
        "firmware_revision_id": (
            str(assigned.firmware_revision_id) if assigned.firmware_revision_id else None
        ),
    }
    # The fitted option recorded on the occurrence (e.g. by an earlier adoption); absent
    # when none is recorded, so resolutions without one keep their exact bytes.
    if assigned.population_option_id is not None:
        base["population_option_id"] = assigned.population_option_id
    return base


def resolve(reader, configuration):
    """Deterministic resolution of explicit selections against one exact option set."""
    # Deferred: fact queries import assembly queries, which import design operations.
    from specmate.configurations.constraints import evaluate

    revision, option_set = option_set_revision(reader, configuration.option_set_revision_id)
    target, closure = check_option_set(reader, option_set)
    selections = {s.option_key: s.choice_key for s in configuration.selections}
    declared = {option.key for option in option_set.options}
    invalid = [
        {
            "option_key": key,
            "choice_key": selections[key],
            "reason": "The pinned option-set revision does not declare this option.",
        }
        for key in sorted(set(selections) - declared)
    ]
    decisions = []
    for option in option_set.options:
        choices = {choice.key: choice for choice in option.choices}
        selected = option.key in selections
        choice_key = selections.get(option.key)
        choice = None
        if selected and choice_key is None:
            source = "explicit_none"
            if option.required:
                status, reason = "unresolved", "A required option was left without a choice."
            else:
                status, reason = "none", "Explicitly left without a choice."
        elif selected and choice_key not in choices:
            source, status = "selected", "invalid"
            reason = "The pinned option-set revision does not declare this choice."
            invalid.append({"option_key": option.key, "choice_key": choice_key, "reason": reason})
        elif selected:
            source, status, choice = "selected", "resolved", choices[choice_key]
            reason = "Explicitly selected."
        elif option.default_choice is not None:
            source, status, choice = "default", "resolved", choices[option.default_choice]
            reason = f"Default declared by option-set revision {revision.number}."
        elif option.required:
            source, status = "not_selected", "unresolved"
            reason = "No selection and no declared default."
        else:
            source, status = "not_selected", "none"
            reason = "Optional and not selected."
        decisions.append(
            {
                "option_key": option.key,
                "label": option.label,
                "domain": option.domain,
                "path": list(option.path) if option.path else None,
                "required": option.required,
                "status": status,
                "source": source,
                "choice": _choice(reader, option, choice) if choice else None,
                "base": _base(closure, option),
                "reason": reason,
                "compatibility": "not_evaluated",
            }
        )
    counts = {
        status: sum(1 for d in decisions if d["status"] == status)
        for status in ("resolved", "none", "unresolved", "invalid")
    }
    status = "invalid" if invalid else "incomplete" if counts["unresolved"] else "complete"
    return {
        "schema_version": "0.1",
        "option_set": pin(revision),
        "target": pin(target) if target else None,
        "decisions": decisions,
        "invalid_selections": invalid,
        "counts": counts,
        "status": status,
        "constraints": evaluate(reader, option_set, decisions),
        **NOT_EVALUATED,
    }


def available(reader, configuration):
    """Declared choices for authoring; read from the same exact option-set pin."""
    _, option_set = option_set_revision(reader, configuration.option_set_revision_id)
    return [
        {
            "option_key": option.key,
            "label": option.label,
            "domain": option.domain,
            "required": option.required,
            "default_choice": option.default_choice,
            "choices": [{"key": c.key, "label": c.label} for c in option.choices],
        }
        for option in option_set.options
    ]


def resolved_revisions(resolution):
    ids = {resolution["option_set"]["revision_id"]}
    if resolution["target"]:
        ids.add(resolution["target"]["revision_id"])
    for decision in resolution["decisions"]:
        if decision["choice"] and decision["choice"]["revision"]:
            ids.add(decision["choice"]["revision"]["revision_id"])
    return ids


def dependency_revisions(user, definition, content):
    """Exact capture pins and authorization for both kinds; never reads live drafts."""
    from uuid import UUID

    reader = Reader(user)
    option_set = parse_option_set(content, definition.kind)
    if option_set is not None:
        target, _ = check_option_set(reader, option_set)
        ids = {str(c.revision_id) for o in option_set.options for c in o.choices if c.revision_id}
        if target is not None:
            ids.add(str(target.id))
        return sorted((UUID(i) for i in ids), key=str)
    configuration = parse_configuration(content, definition.kind)
    if configuration is not None:
        resolution = resolve(reader, configuration)
        return sorted((UUID(i) for i in resolved_revisions(resolution)), key=str)
    return []


def authorize_content(user, definition, content):
    dependency_revisions(user, definition, content)


def require_capturable(user, definition, content):
    configuration = parse_configuration(content, definition.kind)
    if configuration is not None and resolve(Reader(user), configuration)["status"] == "invalid":
        raise ValidationFailed("Correct invalid selections before capturing this configuration.")
