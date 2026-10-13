"""Authorize the complete owning closure before resolving cable selections."""

import json
from contextvars import ContextVar

from pydantic import ValidationError

from specmate.access.permissions import Perm, authorize
from specmate.cables.contracts import Cable
from specmate.cables.lengths import project_lengths
from specmate.design.models import Revision
from specmate.design.operations import authorize_snapshot
from specmate.interfaces.contracts import ConnectorBody, Pinout
from specmate.interfaces.queries import parse_content as parse_interface
from specmate.operations import NotFound, ValidationFailed
from specmate.wire_stock.schemas import StockSpecification

_AUTHORIZING = ContextVar("cable_authorizing_snapshots", default=frozenset())


def authorize_reference(user, revision):
    active = _AUTHORIZING.get()
    if revision.snapshot_id in active or len(active) >= 32:
        raise ValidationFailed("Cable authorization nesting limit or dependency cycle.")
    token = _AUTHORIZING.set(active | {revision.snapshot_id})
    try:
        authorize_snapshot(user, revision.snapshot)
    finally:
        _AUTHORIZING.reset(token)


def parse_content(content, kind=None):
    if "cable" not in content:
        if kind == "cable":
            raise ValidationFailed("Typed cable content is required.")
        return None
    if kind is not None and kind != "cable":
        raise ValidationFailed("Cable content requires a cable definition.")
    try:
        return Cable.model_validate(content["cable"])
    except ValidationError:
        raise ValidationFailed("Invalid cable content.") from None


def validate_content(kind, content):
    value = parse_content(content, kind)
    return {**content, "cable": value.model_dump(mode="json")} if value else content


def conductive_elements(node, prefix=""):
    path = f"{prefix}.{node.id}" if prefix else node.id
    if node.kind in {"conductor", "shield", "drain"}:
        yield path, node
    for child in getattr(node, "children", []):
        yield from conductive_elements(child, path)


class Closure:
    def __init__(self, user, content, kind=None, dependencies=(), *, authority_only=False):
        self.cable = parse_content(content, kind)
        self.revisions = {}
        if self.cable is None:
            return
        pending = [
            self.cable.stock_revision_id,
            *(e.body_revision_id for e in self.cable.endpoints),
            *(e.pinout_revision_id for e in self.cable.endpoints),
            *dependencies,
        ]
        while pending:
            rid = pending.pop()
            if rid in self.revisions:
                continue
            if len(self.revisions) >= 2000:
                raise ValidationFailed("Cable dependency limit exceeded.")
            revision = (
                Revision.objects.select_related("definition", "snapshot").filter(id=rid).first()
            )
            if revision is None:
                raise NotFound("Cable reference unavailable.")
            authorize(user, revision.definition.project_id, Perm.PROJECT_READ)
            self.revisions[rid] = revision
            pending.extend(revision.snapshot.dependencies.values_list("revision_id", flat=True))
        # Recheck typed source evidence, not just membership or snapshot dependency rows.
        for revision in self.revisions.values():
            authorize_reference(user, revision)
        if authority_only:
            return
        stock_revision = self.revisions[self.cable.stock_revision_id]
        stock_content = json.loads(bytes(stock_revision.snapshot.canonical))["content"]
        if stock_revision.definition.kind != "wire_stock" or "stock" not in stock_content:
            raise ValidationFailed("Cable requires an exact typed stock revision.")
        self.stock = StockSpecification.model_validate(stock_content["stock"])
        self.elements = dict(conductive_elements(self.stock.structure))
        self.lengths = project_lengths(self.cable.lengths, self.elements)
        for row in self.lengths["rows"]:
            row["stock_revision_id"] = str(self.cable.stock_revision_id)
            if row["target"].startswith("conductor:"):
                path = row["target"].removeprefix("conductor:")
                row["element_path"] = path
                row["element_kind"] = self.elements[path].kind
            if row["model"]:
                for allowance in row["model"]["allowances"]:
                    if allowance["scope"] == "endpoint" and allowance["endpoint_id"] not in {
                        endpoint.local_id for endpoint in self.cable.endpoints
                    }:
                        raise ValidationFailed(
                            "Length allowance endpoint is absent from this cable."
                        )
        self.endpoints = {}
        for endpoint in self.cable.endpoints:
            body_revision = self.revisions[endpoint.body_revision_id]
            pinout_revision = self.revisions[endpoint.pinout_revision_id]
            body = parse_interface(
                json.loads(bytes(body_revision.snapshot.canonical))["content"],
                body_revision.definition.kind,
            )
            pinout = parse_interface(
                json.loads(bytes(pinout_revision.snapshot.canonical))["content"],
                pinout_revision.definition.kind,
            )
            if not isinstance(body, ConnectorBody) or not isinstance(pinout, Pinout):
                raise ValidationFailed("Cable endpoints require exact body and pinout revisions.")
            if pinout.body_revision_id != endpoint.body_revision_id:
                raise ValidationFailed("Endpoint body must match the pinout's exact body revision.")
            self.endpoints[endpoint.local_id] = (endpoint, body, pinout)
        for assignment in self.cable.assignments:
            endpoint = self.endpoints.get(assignment.endpoint_id)
            if endpoint is None:
                raise ValidationFailed("Termination endpoint is absent from this cable.")
            if assignment.element_path not in self.elements:
                raise ValidationFailed("Termination must identify a conductive stock element.")
            contacts = {c.contact_id for c in endpoint[1].contacts if c.physical_role != "key"}
            if assignment.contact_id not in contacts:
                raise ValidationFailed("Termination must identify a physical contact or shell.")


def authorize_content(user, content, *, authority_only=False):
    Closure(user, content, authority_only=authority_only)


def dependency_revisions(user, definition, content):
    return sorted(Closure(user, content, definition.kind).revisions, key=str)


def inspect_revision(user, revision_id):
    revision = (
        Revision.objects.select_related("definition", "snapshot").filter(id=revision_id).first()
    )
    if revision is None:
        raise NotFound("Cable revision unavailable.")
    authorize(user, revision.definition.project_id, Perm.PROJECT_READ)
    closure = Closure(
        user,
        json.loads(bytes(revision.snapshot.canonical))["content"],
        revision.definition.kind,
        revision.snapshot.dependencies.values_list("revision_id", flat=True),
    )
    if closure.cable is None:
        raise ValidationFailed("Revision is not a cable.")
    assignments = {(a.element_path, a.endpoint_id): a for a in closure.cable.assignments}
    return {
        "definition_id": str(revision.definition_id),
        "lengths": closure.lengths,
        "revision_id": str(revision.id),
        "snapshot_id": str(revision.snapshot_id),
        "sha256": revision.snapshot.sha256,
        "cable": closure.cable.model_dump(mode="json"),
        "conductors": [
            {
                "element_path": path,
                "stock_revision_id": str(closure.cable.stock_revision_id),
                "kind": element.kind,
                "label": element.label,
                "ends": [
                    {
                        "endpoint_id": endpoint.local_id,
                        "assignment": (
                            assignments[path, endpoint.local_id].model_dump(mode="json")
                            if (path, endpoint.local_id) in assignments
                            else None
                        ),
                    }
                    for endpoint in closure.cable.endpoints
                ],
            }
            for path, element in closure.elements.items()
        ],
        "endpoints": [
            {
                **endpoint.model_dump(mode="json"),
                "body": body.model_dump(mode="json"),
                "pinout": pinout.model_dump(mode="json"),
            }
            for endpoint, body, pinout in closure.endpoints.values()
        ],
        "continuity": "not_evaluated",
        "compatibility": "not_evaluated",
        "physical_qualification": "not_evaluated",
    }


def length_impact(user, before_id, after_id):
    before = inspect_revision(user, before_id)
    after = inspect_revision(user, after_id)
    if before["definition_id"] != after["definition_id"]:
        raise ValidationFailed("Length comparison requires revisions of one cable definition.")
    old = {row["target"]: row for row in before["lengths"]["rows"]}
    new = {row["target"]: row for row in after["lengths"]["rows"]}
    changes = [
        {"target": target, "before": old.get(target), "after": new.get(target)}
        for target in sorted(old.keys() | new.keys())
        if old.get(target) != new.get(target)
    ]
    route_changed = old["route"]["declaration"] != new["route"]["declaration"]
    return {
        "before_revision_id": before["revision_id"],
        "after_revision_id": after["revision_id"],
        "before_sha256": before["sha256"],
        "after_sha256": after["sha256"],
        "route_changed": route_changed,
        "changes": changes,
        "preparation_review_required": bool(changes),
        "document_review_required": bool(changes),
        "stock_revision_changed": before["cable"]["stock_revision_id"]
        != after["cable"]["stock_revision_id"],
        "stock_facts_written": False,
        "declarations_applied": False,
        "physical_qualification": "not_evaluated",
    }
