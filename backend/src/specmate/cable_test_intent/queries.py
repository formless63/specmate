"""Current complete reference authority precedes test-plan diagnostics and export."""

import hashlib
import json
from contextvars import ContextVar
from types import SimpleNamespace

from pydantic import ValidationError

from specmate.assemblies.queries import resolve_occurrence
from specmate.cable_test_intent.contracts import TestPlan
from specmate.cables.queries import inspect_revision as inspect_cable
from specmate.catalog_matching.operations import evidence_fields
from specmate.catalog_matching.queries import current_actor, evidence_result
from specmate.design.operations import canonical_bytes
from specmate.operations import ValidationFailed
from specmate.queries import get_bundle_revision, get_revision
from specmate.sources.authority import authorize_revision

_ACTIVE = ContextVar("test_plan_closure", default=frozenset())


def parse_content(content, kind=None):
    if "test_plan" not in content:
        if kind == "cable_test_plan":
            raise ValidationFailed("Typed cable test plan is required.")
        return None
    if kind is not None and kind != "cable_test_plan":
        raise ValidationFailed("Test plans require a cable_test_plan definition.")
    try:
        return TestPlan.model_validate(content["test_plan"])
    except ValidationError:
        raise ValidationFailed("Invalid cable test plan.") from None


def validate_content(kind, content):
    plan = parse_content(content, kind)
    return {**content, "test_plan": plan.model_dump(mode="json")} if plan else content


def target(user, p, *, validate=True):
    user = current_actor(user)
    active = _ACTIVE.get()
    pins = {p.root_revision_id, p.cable_revision_id}
    if active & pins or len(active) >= 32:
        raise ValidationFailed("Test plan dependency cycle or nesting limit.")
    token = _ACTIVE.set(active | pins)
    try:
        # Supplied root and selected cable both require full current owning closure.
        root = get_revision(user, p.root_revision_id)
        cable_revision = get_revision(user, p.cable_revision_id)
        if not validate:
            return root, cable_revision, None
        if p.occurrence_path:
            occurrence = resolve_occurrence(user, root.snapshot_id, p.occurrence_path)
            if occurrence["revision_id"] != str(cable_revision.id):
                raise ValidationFailed("Occurrence must pin the exact selected cable revision.")
        elif root.id != cable_revision.id:
            raise ValidationFailed("Standalone test scope requires the cable as its root.")
        cable = inspect_cable(user, cable_revision.id)
        return root, cable_revision, cable
    finally:
        _ACTIVE.reset(token)


def terminals(cable):
    if cable.get("topology") == "section_graph":
        rows = []
        for row in cable["terminals"]:
            original = row["terminal"]
            terminal = {
                **original,
                "kind": "stack_terminal" if original["kind"] == "endpoint" else original["kind"],
            }
            rows.append(
                {
                    "terminal": terminal,
                    "label": " / ".join(
                        str(value) for key, value in terminal.items() if key != "kind"
                    ),
                    "physical_role": row["feature_kind"],
                }
            )
        return rows
    rows = []
    for endpoint in cable["endpoints"]:
        # Test terminals are connector contacts and stock features; an end without a
        # connector layer offers only its stock features (board pads are not test points).
        for contact in (endpoint["body"] or {}).get("contacts", []):
            if contact["physical_role"] == "key":
                continue
            rows.append(
                {
                    "terminal": {
                        "endpoint_id": endpoint["local_id"],
                        "kind": "contact",
                        "contact_id": contact["contact_id"],
                        "element_path": None,
                    },
                    "label": contact["label"],
                    "physical_role": contact["physical_role"],
                    "body_revision_id": endpoint["body_revision_id"],
                    "pinout_revision_id": endpoint["pinout_revision_id"],
                }
            )
        for conductor in cable["conductors"]:
            rows.append(
                {
                    "terminal": {
                        "endpoint_id": endpoint["local_id"],
                        "kind": "stock_feature",
                        "contact_id": None,
                        "element_path": conductor["element_path"],
                    },
                    "label": conductor["label"],
                    "physical_role": conductor["kind"],
                    "stock_revision_id": conductor["stock_revision_id"],
                }
            )
    return rows


def terminal_key(value):
    from specmate.cable_test_intent.contracts import Terminal

    return Terminal.model_validate(value).key()


def closure(user, content, kind=None, *, validate=True):
    user = current_actor(user)
    plan = parse_content(content, kind)
    if plan is None:
        return None, None, None, None
    # Source ancestry and both complete design closures precede file-path and target
    # diagnostics. Authority-only replay checks never resolve caller-supplied paths.
    rows = [*plan.pairs, *plan.labels]
    source_ids = {
        row.evidence.source_bundle_revision_id
        for row in rows
        if row.evidence.status == "registered_file"
    }
    for source_id in sorted(source_ids, key=str):
        authorize_revision(user, get_bundle_revision(user, source_id))
    root, revision, cable = target(user, plan, validate=False)
    if validate:
        for row in rows:
            evidence_fields(user, row.evidence)
        root, revision, cable = target(user, plan)
        allowed = {terminal_key(row["terminal"]) for row in terminals(cable)}
        endpoints = {row["local_id"] for row in cable["endpoints"]}
        for pair in plan.pairs:
            if pair.first.key() not in allowed or pair.second.key() not in allowed:
                raise ValidationFailed("Test pair must identify exact cable terminals.")
        for label in plan.labels:
            if label.endpoint_id is not None and label.endpoint_id not in endpoints:
                raise ValidationFailed("Label endpoint is absent from the selected cable.")
            if label.terminal is not None and label.terminal.key() not in allowed:
                raise ValidationFailed("Label must identify an exact cable terminal.")
    return plan, root, revision, cable


def dependency_revisions(user, definition, content):
    plan, _, _, _ = closure(user, content, definition.kind)
    return sorted({plan.root_revision_id, plan.cable_revision_id}, key=str) if plan else []


def authorize_content(user, definition, content):
    closure(user, content, definition.kind)


def inspect_target(user, payload):
    root, revision, cable = target(user, payload)
    return {
        "root_revision_id": str(root.id),
        "root_snapshot_id": str(root.snapshot_id),
        "root_sha256": root.snapshot.sha256,
        "occurrence_path": payload.occurrence_path,
        "cable_revision_id": str(revision.id),
        "cable_sha256": revision.snapshot.sha256,
        "endpoints": cable["cable"]["endpoints"],
        "terminals": terminals(cable),
        "physical_test": "not_performed",
        "physical_qualification": "not_evaluated",
    }


def result(user, revision_id):
    user = current_actor(user)
    revision = get_revision(user, revision_id)
    plan, root, cable_revision, cable = closure(
        user, json.loads(bytes(revision.snapshot.canonical))["content"], revision.definition.kind
    )
    if plan is None:
        raise ValidationFailed("Revision is not a cable test plan.")
    evidence = [
        {
            "kind": kind,
            "local_id": row.local_id,
            "evidence": evidence_result(
                SimpleNamespace(**evidence_fields(user, row.evidence))
            ).model_dump(mode="json"),
        }
        for kind, rows in (("pair", plan.pairs), ("label", plan.labels))
        for row in rows
    ]
    return {
        "definition_id": str(revision.definition_id),
        "revision_id": str(revision.id),
        "snapshot_id": str(revision.snapshot_id),
        "sha256": revision.snapshot.sha256,
        "test_plan": plan.model_dump(mode="json"),
        "evidence": evidence,
        "root_snapshot_id": str(root.snapshot_id),
        "root_sha256": root.snapshot.sha256,
        "cable_sha256": cable_revision.snapshot.sha256,
        "cable": cable,
        "terminals": terminals(cable),
        "physical_test": "not_performed",
        "physical_continuity": "not_evaluated",
        "physical_qualification": "not_evaluated",
    }


def portable_package(user, revision_id):
    user = current_actor(user)
    inspected = result(user, revision_id)
    # Only the selected cable's design closure is embedded, never parent or siblings.
    pending = [inspected["test_plan"]["cable_revision_id"]]
    captured = {}
    while pending:
        rid = pending.pop()
        if str(rid) in captured:
            continue
        revision = get_revision(user, rid)
        if len(captured) >= 2000:
            raise ValidationFailed("Cable package dependency limit exceeded.")
        captured[str(rid)] = {
            "revision_id": str(revision.id),
            "snapshot_id": str(revision.snapshot_id),
            "sha256": revision.snapshot.sha256,
            "canonical": json.loads(bytes(revision.snapshot.canonical)),
        }
        pending.extend(revision.snapshot.dependencies.values_list("revision_id", flat=True))
    plan_revision = get_revision(user, revision_id)
    package = {
        "plan_snapshot": {
            "snapshot_id": str(plan_revision.snapshot_id),
            "sha256": plan_revision.snapshot.sha256,
            "canonical": json.loads(bytes(plan_revision.snapshot.canonical)),
        },
        "format": "specmate.cable-test-package",
        "schema_version": "0.1",
        "plan_revision_id": inspected["revision_id"],
        "plan_sha256": inspected["sha256"],
        "scope": {
            "root_revision_id": inspected["test_plan"]["root_revision_id"],
            "root_snapshot_id": inspected["root_snapshot_id"],
            "root_sha256": inspected["root_sha256"],
            "occurrence_path": inspected["test_plan"]["occurrence_path"],
        },
        "test_plan": inspected["test_plan"],
        "evidence": inspected["evidence"],
        "design_revisions": [captured[key] for key in sorted(captured)],
        "physical_test": "not_performed",
        "physical_continuity": "not_evaluated",
        "physical_qualification": "not_evaluated",
        "source_bytes": "not_included",
        "distribution_rights": "not_evaluated",
    }
    data = canonical_bytes(package)
    return data, hashlib.sha256(data).hexdigest()
