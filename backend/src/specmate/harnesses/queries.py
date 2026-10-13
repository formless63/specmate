"""Authorize the complete owning closure before resolving harness selections."""

import json
from contextvars import ContextVar
from decimal import Decimal

from pydantic import ValidationError

from specmate.access.permissions import Perm, authorize
from specmate.cables.queries import conductive_elements
from specmate.design.models import Revision
from specmate.design.operations import authorize_snapshot
from specmate.harnesses.contracts import (
    EndpointTerminal,
    Harness,
    JointFate,
    ReadHarness,
    SegmentTerminal,
    Through,
    terminal_key,
)
from specmate.interfaces.contracts import ConnectorBody, Pinout
from specmate.interfaces.queries import parse_content as parse_interface
from specmate.operations import NotFound, ValidationFailed
from specmate.wire_stock.schemas import StockSpecification

_AUTHORIZING = ContextVar("harness_authorizing_snapshots", default=frozenset())


def authorize_reference(user, revision):
    active = _AUTHORIZING.get()
    if revision.snapshot_id in active or len(active) >= 32:
        raise ValidationFailed("Harness authorization nesting limit or dependency cycle.")
    token = _AUTHORIZING.set(active | {revision.snapshot_id})
    try:
        authorize_snapshot(user, revision.snapshot)
    finally:
        _AUTHORIZING.reset(token)


def parse_content(content, kind=None):
    if "harness" not in content:
        if kind == "harness":
            raise ValidationFailed("Typed harness content is required.")
        return None
    if kind is not None and kind != "harness":
        raise ValidationFailed("Harness content requires a harness definition.")
    try:
        return Harness.model_validate(content["harness"])
    except ValidationError:
        raise ValidationFailed("Invalid harness content.") from None


def validate_content(kind, content):
    value = parse_content(content, kind)
    return {**content, "harness": value.model_dump(mode="json")} if value else content


class Closure:
    def __init__(self, user, content, kind=None, dependencies=()):
        self.harness = parse_content(content, kind)
        self.revisions = {}
        if self.harness is None:
            return
        pending = [
            *(s.stock_revision_id for s in self.harness.sections),
            *(e.body_revision_id for e in self.harness.endpoints),
            *(e.pinout_revision_id for e in self.harness.endpoints),
            *dependencies,
        ]
        while pending:
            rid = pending.pop()
            if rid in self.revisions:
                continue
            if len(self.revisions) >= 2000:
                raise ValidationFailed("Harness dependency limit exceeded.")
            revision = (
                Revision.objects.select_related("definition", "snapshot").filter(id=rid).first()
            )
            if revision is None:
                raise NotFound("Harness reference unavailable.")
            authorize(user, revision.definition.project_id, Perm.PROJECT_READ)
            self.revisions[rid] = revision
            pending.extend(revision.snapshot.dependencies.values_list("revision_id", flat=True))
        for revision in self.revisions.values():
            authorize_reference(user, revision)
        self.sections = {s.local_id: s for s in self.harness.sections}
        self.constructions = {}
        for section in self.harness.sections:
            revision = self.revisions[section.stock_revision_id]
            content = json.loads(bytes(revision.snapshot.canonical))["content"]
            if revision.definition.kind != "wire_stock" or "stock" not in content:
                raise ValidationFailed("Physical sections require exact typed stock revisions.")
            self.constructions[section.local_id] = dict(
                conductive_elements(StockSpecification.model_validate(content["stock"]).structure)
            )
        self.segments = {s.local_id: s for s in self.harness.segments}
        self.terminals = {}
        self.segment_paths = {}
        for segment in self.harness.segments:
            if segment.section_id not in self.sections:
                raise ValidationFailed("Segment section is absent from the harness.")
            elements = self.constructions[segment.section_id]
            paths = list(elements) if segment.element_paths is None else segment.element_paths
            if set(paths) - set(elements):
                raise ValidationFailed("Segment paths must identify conductive stock features.")
            if len(self.terminals) + len(paths) * 2 > 20000:
                raise ValidationFailed("Harness terminal limit exceeded.")
            self.segment_paths[segment.local_id] = paths
            for path in paths:
                for end in ("a", "b"):
                    terminal = SegmentTerminal(
                        segment_id=segment.local_id, end=end, element_path=path
                    )
                    self.terminals[terminal_key(terminal)] = {
                        "terminal": terminal.model_dump(mode="json"),
                        "feature_kind": elements[path].kind,
                        "stock_revision_id": str(
                            self.sections[segment.section_id].stock_revision_id
                        ),
                        "section_id": segment.section_id,
                    }
        self.endpoints = {}
        for endpoint in self.harness.endpoints:
            body_revision = self.revisions[endpoint.body_revision_id]
            pins_revision = self.revisions[endpoint.pinout_revision_id]
            body = parse_interface(
                json.loads(bytes(body_revision.snapshot.canonical))["content"],
                body_revision.definition.kind,
            )
            pinout = parse_interface(
                json.loads(bytes(pins_revision.snapshot.canonical))["content"],
                pins_revision.definition.kind,
            )
            if (
                not isinstance(body, ConnectorBody)
                or not isinstance(pinout, Pinout)
                or pinout.body_revision_id != endpoint.body_revision_id
            ):
                raise ValidationFailed("Endpoint requires a pinout of its exact body revision.")
            self.endpoints[endpoint.local_id] = (endpoint, body, pinout)
            for contact in body.contacts:
                if contact.physical_role == "key":
                    continue
                terminal = EndpointTerminal(
                    endpoint_id=endpoint.local_id, contact_id=contact.contact_id
                )
                self.terminals[terminal_key(terminal)] = {
                    "terminal": terminal.model_dump(mode="json"),
                    "feature_kind": contact.physical_role,
                    "body_revision_id": str(endpoint.body_revision_id),
                    "pinout_revision_id": str(endpoint.pinout_revision_id),
                }
        if len(self.terminals) > 20000:
            raise ValidationFailed("Harness terminal limit exceeded.")
        self.joints = {j.local_id: j for j in self.harness.joints}
        self.owners = {}
        self.relationships = []
        for joint in self.harness.joints:
            records = [self.resolve(member) for member in joint.members]
            segments = sum(isinstance(m, SegmentTerminal) for m in joint.members)
            if joint.kind == "termination" and (len(records) != 2 or segments != 1):
                raise ValidationFailed(
                    "A termination joins one segment end to one endpoint contact."
                )
            if joint.kind == "splice" and segments != len(records):
                raise ValidationFailed("A splice joins segment ends.")
            if joint.kind == "shield_bond" and any(
                r["feature_kind"] not in {"shield", "drain", "shell"} for r in records
            ):
                raise ValidationFailed(
                    "A shield bond requires exact shield, drain or shell features."
                )
            for member in joint.members:
                self.claim(member, ("joint", joint.local_id))
            self.relationships.append(
                {
                    "id": joint.local_id,
                    "kind": joint.kind,
                    "members": [m.model_dump(mode="json") for m in joint.members],
                    "basis": joint.basis,
                }
            )
        self.breakout_fates = []
        participating = set()
        for breakout in self.harness.breakouts:
            ends = [(e.segment_id, e.end) for e in [breakout.trunk, *breakout.legs]]
            if any(segment not in self.segments for segment, _ in ends):
                raise ValidationFailed("Breakout segment is absent from the harness.")
            if participating.intersection(ends):
                raise ValidationFailed("A segment end belongs to at most one breakout.")
            participating.update(ends)
            expected = {
                ("segment", segment, end, path)
                for segment, end in ends
                for path in self.segment_paths[segment]
            }
            described = {}
            for fate in breakout.fates:
                members = [fate.trunk, fate.leg] if isinstance(fate, Through) else [fate.terminal]
                for terminal in members:
                    self.resolve(terminal)
                    key = terminal_key(terminal)
                    if key not in expected:
                        raise ValidationFailed(
                            "Breakout fate must address a participating segment end."
                        )
                    if key in described:
                        raise ValidationFailed(
                            "Breakout terminal has duplicate or conflicting fates."
                        )
                    described[key] = fate.kind
                owner = ("breakout", breakout.local_id, fate.local_id)
                if isinstance(fate, Through):
                    if (fate.trunk.segment_id, fate.trunk.end) != ends[0] or (
                        fate.leg.segment_id,
                        fate.leg.end,
                    ) not in ends[1:]:
                        raise ValidationFailed(
                            "Uncut correspondence must connect trunk to a declared leg."
                        )
                    if (
                        self.segments[fate.trunk.segment_id].section_id
                        != self.segments[fate.leg.segment_id].section_id
                        or fate.trunk.element_path != fate.leg.element_path
                    ):
                        raise ValidationFailed(
                            "Uncut correspondence requires the same physical section and feature."
                        )
                    self.relationships.append(
                        {
                            "id": fate.local_id,
                            "breakout_id": breakout.local_id,
                            "kind": "through",
                            "members": [m.model_dump(mode="json") for m in members],
                            "basis": fate.basis,
                        }
                    )
                elif isinstance(fate, JointFate):
                    owner = ("joint", fate.joint_id)
                    if self.owners.get(terminal_key(fate.terminal)) != owner:
                        raise ValidationFailed(
                            "Breakout joint fate must reference its exact declared joint."
                        )
                for terminal in members:
                    # Joint fates annotate the existing ownership; they add no second edge.
                    if isinstance(fate, JointFate):
                        continue
                    self.claim(terminal, owner)
            for key in sorted(expected):
                # A joint at a breakout end needs an explicit matching joint fate.
                if key in self.owners and self.owners[key][0] == "joint" and key not in described:
                    raise ValidationFailed("A jointed breakout terminal requires its joint fate.")
                self.breakout_fates.append(
                    {
                        "breakout_id": breakout.local_id,
                        "terminal": self.terminals[key]["terminal"],
                        "fate": described.get(key, "unknown"),
                    }
                )

    def resolve(self, terminal):
        record = self.terminals.get(terminal_key(terminal))
        if record is None:
            raise ValidationFailed("Terminal must identify an exact conductive feature or contact.")
        return record

    def claim(self, terminal, owner):
        key = terminal_key(terminal)
        if key in self.owners:
            raise ValidationFailed("A terminal has conflicting joint or breakout ownership.")
        self.owners[key] = owner


def authorize_content(user, content):
    Closure(user, content)


def dependency_revisions(user, definition, content):
    return sorted(Closure(user, content, definition.kind).revisions, key=str)


def read_revision(user, revision_id):
    revision = (
        Revision.objects.select_related("definition", "snapshot").filter(id=revision_id).first()
    )
    if revision is None:
        raise NotFound("Harness revision unavailable.")
    authorize(user, revision.definition.project_id, Perm.PROJECT_READ)
    closure = Closure(
        user,
        json.loads(bytes(revision.snapshot.canonical))["content"],
        revision.definition.kind,
        revision.snapshot.dependencies.values_list("revision_id", flat=True),
    )
    if closure.harness is None:
        raise ValidationFailed("Revision is not a harness.")
    return revision, closure


def quantities(closure, quantity):
    rows = {}
    for section in closure.harness.sections:
        key = str(section.stock_revision_id)
        rows.setdefault(key, []).append(section)
    return {
        "harness_count": quantity,
        "segment_count": None if quantity is None else len(closure.harness.segments) * quantity,
        "physical_piece_count": None
        if quantity is None
        else len(closure.harness.sections) * quantity,
        "stock": [
            {
                "stock_revision_id": key,
                "section_ids": [s.local_id for s in sections],
                "piece_count": None if quantity is None else len(sections) * quantity,
                "planned_cut_total_mm": None
                if quantity is None or any(s.planned_cut_length_mm is None for s in sections)
                else str(sum(Decimal(str(s.planned_cut_length_mm)) for s in sections) * quantity),
            }
            for key, sections in sorted(rows.items())
        ],
        "basis": (
            "Each explicitly declared physical section counts once per harness; "
            "segments do not add stock pieces."
        ),
    }


def inspect_revision(user, revision_id, quantity=1):
    revision, closure = read_revision(user, revision_id)
    try:
        quantity = ReadHarness(revision_id=revision.id, quantity=quantity).quantity
    except ValidationError:
        raise ValidationFailed("Invalid harness quantity.") from None
    return {
        "revision_id": str(revision.id),
        "snapshot_id": str(revision.snapshot_id),
        "sha256": revision.snapshot.sha256,
        "harness": closure.harness.model_dump(mode="json"),
        "quantities": quantities(closure, quantity),
        "terminals": list(closure.terminals.values()),
        "declared_relationships": closure.relationships,
        "breakout_fates": closure.breakout_fates,
        "continuity": "not_evaluated",
        "compatibility": "not_evaluated",
        "physical_qualification": "not_evaluated",
    }


def inspect_relationships(user, revision_id, terminal):
    revision, closure = read_revision(user, revision_id)
    closure.resolve(terminal)
    key = terminal_key(terminal)
    relationships = [
        r
        for r in closure.relationships
        if any(
            terminal_key(
                SegmentTerminal.model_validate(m)
                if m["kind"] == "segment"
                else EndpointTerminal.model_validate(m)
            )
            == key
            for m in r["members"]
        )
    ]
    return {
        "revision_id": str(revision.id),
        "terminal": terminal.model_dump(mode="json"),
        "status": "declared" if relationships else "unknown",
        "declared_relationships": relationships,
        "continuity": "not_evaluated",
        "compatibility": "not_evaluated",
        "physical_qualification": "not_evaluated",
        "limitations": [
            "Only explicit relationships touching the selected terminal are inspected. "
            "No longitudinal copper, inferred bonds or full electrical trace."
        ],
    }
