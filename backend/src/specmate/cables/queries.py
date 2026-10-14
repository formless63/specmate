"""Authorize the complete owning closure before resolving cable selections."""

import json
from contextvars import ContextVar

from pydantic import ValidationError

from specmate.access.permissions import Perm, authorize
from specmate.cables.contracts import Cable
from specmate.cables.lengths import project_lengths
from specmate.design.closure_reads import closure_reads
from specmate.design.models import Revision, SnapshotDependency
from specmate.design.operations import authorize_snapshots
from specmate.design.pins import check_pin
from specmate.interfaces.contracts import ConnectorBody, Pinout
from specmate.interfaces.queries import parse_content as parse_interface
from specmate.operations import NotFound, ValidationFailed
from specmate.wire_stock.schemas import StockSpecification

_AUTHORIZING = ContextVar("cable_authorizing_snapshots", default=frozenset())


def authorize_references(user, revisions):
    """Authorize every revision's closure in one batched traversal.

    Each revision is checked against the active nesting set, which then only deepens by
    one level (siblings are not marked active, so nested typed content may revisit them).
    """
    revisions = list(revisions)
    active = _AUTHORIZING.get()
    if len(active) >= 32 or any(r.snapshot_id in active for r in revisions):
        raise ValidationFailed("Cable authorization nesting limit or dependency cycle.")
    token = _AUTHORIZING.set(active | {object()})
    try:
        authorize_snapshots(user, [r.snapshot for r in revisions])
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
        # One membership read per workspace for the whole read-only closure walk.
        with closure_reads():
            self._build(user, content, kind, dependencies, authority_only)

    def _build(self, user, content, kind, dependencies, authority_only):
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
        pin_scope = None
        while pending:
            # Level by level: one query for the level's revisions, one for their pins.
            level = [rid for rid in dict.fromkeys(pending) if rid not in self.revisions]
            loaded = {
                str(key): value
                for key, value in Revision.objects.select_related(
                    "definition", "snapshot__definition"
                )
                .in_bulk({str(rid) for rid in level})
                .items()
            }
            for rid in level:
                if len(self.revisions) >= 2000:
                    raise ValidationFailed("Cable dependency limit exceeded.")
                revision = loaded.get(str(rid))
                # Missing, foreign-workspace and unreadable pins read alike, before any guard.
                pin_scope = check_pin(user, revision, pin_scope)
                self.revisions[rid] = revision
            pending = list(
                SnapshotDependency.objects.filter(
                    snapshot_id__in=[self.revisions[rid].snapshot_id for rid in level]
                ).values_list("revision_id", flat=True)
            )
        # Recheck typed source evidence, not just membership or snapshot dependency rows.
        authorize_references(user, self.revisions.values())
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
    authorize(user, revision.definition.workspace_id, Perm.WORKSPACE_READ)
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


# Cable content sections whose change alters generated documents (specifications, schematic,
# terminations, cut/end preparation lists, build sheet, test intent). Each section names
# whether preparation must also be re-reviewed; label/review-only edits change documents only.
_PREPARATION = "preparation"
_DOCUMENTS = "documents"


def _keyed(rows, key):
    return {key(row): row for row in rows}


def _section_changes(before, after):
    """Per-section differences between two inspected cable revisions.

    A section that cannot be compared (an unknown schema or content field) is reported as
    ``uncomparable`` and requires review: an unknown difference is never "no change".
    """
    old, new = before["cable"], after["cable"]
    sections = []

    def add(section, reviews, summary, details):
        sections.append(
            {
                "section": section,
                "status": "changed",
                "reviews": sorted(reviews),
                "summary": summary,
                "details": details,
            }
        )

    if old.get("schema_version") != new.get("schema_version"):
        sections.append(
            {
                "section": "cable",
                "status": "uncomparable",
                "reviews": sorted({_PREPARATION, _DOCUMENTS}),
                "summary": "Cable content versions differ; every generated section needs review.",
                "details": [
                    {
                        "field": "schema_version",
                        "before": old.get("schema_version"),
                        "after": new.get("schema_version"),
                    }
                ],
            }
        )
        return sections

    if old["stock_revision_id"] != new["stock_revision_id"]:
        add(
            "stock",
            {_PREPARATION, _DOCUMENTS},
            "Pinned wire stock revision changed; conductor identities, labels and cut "
            "material may differ.",
            [{"before": old["stock_revision_id"], "after": new["stock_revision_id"]}],
        )

    def endpoint_key(row):
        return row["local_id"]

    old_ends = _keyed(old["endpoints"], endpoint_key)
    new_ends = _keyed(new["endpoints"], endpoint_key)
    labels, connectors = [], []
    for local_id in sorted(old_ends.keys() | new_ends.keys()):
        a, b = old_ends.get(local_id), new_ends.get(local_id)
        if a is None or b is None:
            connectors.append({"endpoint_id": local_id, "before": a, "after": b})
            continue
        if (a["body_revision_id"], a["pinout_revision_id"]) != (
            b["body_revision_id"],
            b["pinout_revision_id"],
        ):
            connectors.append({"endpoint_id": local_id, "before": a, "after": b})
        if a.get("label") != b.get("label"):
            labels.append(
                {"endpoint_id": local_id, "before": a.get("label"), "after": b.get("label")}
            )
    if connectors:
        add(
            "connectors",
            {_PREPARATION, _DOCUMENTS},
            "Endpoint connector body or pinout changed; end preparation profiles bound to "
            "these ends must be re-applied.",
            connectors,
        )

    def termination_key(row):
        return (row["element_path"], row["endpoint_id"])

    old_terms = _keyed(old["assignments"], termination_key)
    new_terms = _keyed(new["assignments"], termination_key)
    terminations = []
    for key in sorted(old_terms.keys() | new_terms.keys()):
        a, b = old_terms.get(key), new_terms.get(key)
        if a != b:
            terminations.append(
                {
                    "element_path": key[0],
                    "endpoint_id": key[1],
                    "before_contact_id": a and a["contact_id"],
                    "after_contact_id": b and b["contact_id"],
                    "before_basis": a and a["basis"],
                    "after_basis": b and b["basis"],
                }
            )
    if terminations:
        add(
            "terminations",
            {_PREPARATION, _DOCUMENTS},
            "Conductor-to-contact terminations changed; terminations, schematic, build sheet, "
            "test intent and end preparation must be re-reviewed.",
            terminations,
        )

    if labels:
        add("labels", {_DOCUMENTS}, "Endpoint labels changed.", labels)

    if (old.get("review"), old.get("review_basis")) != (new.get("review"), new.get("review_basis")):
        add(
            "review",
            {_DOCUMENTS},
            "Declared cable review status or basis changed.",
            [
                {
                    "before": {"review": old.get("review"), "basis": old.get("review_basis")},
                    "after": {"review": new.get("review"), "basis": new.get("review_basis")},
                }
            ],
        )

    covered = {
        "schema_version",
        "stock_revision_id",
        "lengths",
        "endpoints",
        "assignments",
        "review",
        "review_basis",
    }
    other = sorted(
        field for field in (old.keys() | new.keys()) - covered if old.get(field) != new.get(field)
    )
    if other:
        sections.append(
            {
                "section": "other",
                "status": "uncomparable",
                "reviews": sorted({_PREPARATION, _DOCUMENTS}),
                "summary": "Other cable content changed without a known document mapping.",
                "details": [{"field": field} for field in other],
            }
        )
    return sections


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
    sections = []
    if changes:
        sections.append(
            {
                "section": "lengths",
                "status": "changed",
                "reviews": sorted({_PREPARATION, _DOCUMENTS}),
                "summary": "Length declarations or model suggestions changed.",
                "details": [{"target": change["target"]} for change in changes],
            }
        )
    sections.extend(_section_changes(before, after))
    if before["cable"] != after["cable"] and not sections:
        # Different frozen content with no recognized difference cannot be called unchanged.
        sections.append(
            {
                "section": "cable",
                "status": "uncomparable",
                "reviews": sorted({_PREPARATION, _DOCUMENTS}),
                "summary": "Frozen content differs outside the compared sections.",
                "details": [],
            }
        )
    return {
        "before_revision_id": before["revision_id"],
        "after_revision_id": after["revision_id"],
        "before_sha256": before["sha256"],
        "after_sha256": after["sha256"],
        "route_changed": route_changed,
        "changes": changes,
        "sections": sections,
        "preparation_review_required": any(_PREPARATION in s["reviews"] for s in sections),
        "document_review_required": any(_DOCUMENTS in s["reviews"] for s in sections),
        "stock_revision_changed": before["cable"]["stock_revision_id"]
        != after["cable"]["stock_revision_id"],
        "stock_facts_written": False,
        "declarations_applied": False,
        "physical_qualification": "not_evaluated",
    }
