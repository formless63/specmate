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
from specmate.interfaces.end_assembly_contracts import EndAssembly
from specmate.interfaces.end_stacks import ResolvedStack, stack_references
from specmate.interfaces.queries import Lookup
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
        # Frozen schema 0.1 content stays readable; it is upgraded in memory, never rewritten.
        return Cable.model_validate(content["cable"])
    except ValidationError:
        raise ValidationFailed("Invalid cable content.") from None


def stored_schema_version(content):
    raw = content.get("cable")
    return raw.get("schema_version", "0.1") if isinstance(raw, dict) else None


def validate_content(kind, content):
    value = parse_content(content, kind)
    return {**content, "cable": value.model_dump(mode="json")} if value else content


def conductive_elements(node, prefix=""):
    path = f"{prefix}.{node.id}" if prefix else node.id
    if node.kind in {"conductor", "shield", "drain"}:
        yield path, node
    for child in getattr(node, "children", []):
        yield from conductive_elements(child, path)


def end_references(endpoint):
    if endpoint.end_assembly_revision_id is not None:
        return [endpoint.end_assembly_revision_id]
    return stack_references(endpoint.stack)


class Closure(Lookup):
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
            *(rid for e in self.cable.endpoints for rid in end_references(e)),
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
        self.values = {}
        for rid, revision in self.revisions.items():
            body = json.loads(bytes(revision.snapshot.canonical))["content"]
            if "interface" in body:
                self.values[rid] = parse_interface(body, revision.definition.kind)
        self.endpoints = {}
        for endpoint in self.cable.endpoints:
            stack = endpoint.stack
            if endpoint.end_assembly_revision_id is not None:
                assembly = self.values.get(endpoint.end_assembly_revision_id)
                if not isinstance(assembly, EndAssembly):
                    raise ValidationFailed("A cable end pins an exact end assembly revision.")
                stack = assembly.stack
            self.endpoints[endpoint.local_id] = (endpoint, ResolvedStack(stack, self))
        for assignment in self.cable.assignments:
            endpoint = self.endpoints.get(assignment.endpoint_id)
            if endpoint is None:
                raise ValidationFailed("Termination endpoint is absent from this cable.")
            if assignment.element_path not in self.elements:
                raise ValidationFailed("Termination must identify a conductive stock element.")
            endpoint[1].require(assignment.layer_id, assignment.terminal_id, "A termination")

    def connector(self, endpoint_id):
        """The end's connector layer (layer, body, pinout), or None without one."""
        return self.endpoints[endpoint_id][1].connector

    def termination(self, assignment):
        """A termination with its layer kind, terminal label and reached connector contacts."""
        resolved = self.endpoints[assignment.endpoint_id][1]
        layer = resolved.layer(assignment.layer_id)
        terminal = resolved.terminals[assignment.layer_id, assignment.terminal_id]
        direct = layer.kind == "connector"
        return {
            **assignment.model_dump(mode="json"),
            "layer_kind": layer.kind,
            "terminal_label": terminal["label"],
            # The connector contact when landed directly on one; else null (see "reaches").
            "contact_id": assignment.terminal_id if direct else None,
            "signal": terminal.get("signal") if direct else None,
            "reaches": []
            if direct
            else resolved.reaches(assignment.layer_id, assignment.terminal_id),
        }


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
    terminations = [closure.termination(a) for a in closure.cable.assignments]
    assignments = {(t["element_path"], t["endpoint_id"]): t for t in terminations}
    endpoints = []
    for endpoint, resolved in closure.endpoints.values():
        connector = resolved.connector
        assembly = (
            closure.revisions[endpoint.end_assembly_revision_id]
            if endpoint.end_assembly_revision_id
            else None
        )
        endpoints.append(
            {
                **endpoint.model_dump(mode="json"),
                "end_assembly_name": assembly.definition.name if assembly else None,
                "end_assembly_revision_number": assembly.number if assembly else None,
                "resolved_stack": resolved.view(),
                # The connector layer, read as a 0.1 endpoint by connector-only consumers.
                "body_revision_id": str(connector[0].body_revision_id) if connector else None,
                "pinout_revision_id": str(connector[0].pinout_revision_id) if connector else None,
                "body": connector[1].model_dump(mode="json") if connector else None,
                "pinout": connector[2].model_dump(mode="json") if connector else None,
            }
        )
    return {
        "definition_id": str(revision.definition_id),
        "lengths": closure.lengths,
        "revision_id": str(revision.id),
        "snapshot_id": str(revision.snapshot_id),
        "sha256": revision.snapshot.sha256,
        "stored_schema_version": stored_schema_version(
            json.loads(bytes(revision.snapshot.canonical))["content"]
        ),
        "cable": closure.cable.model_dump(mode="json"),
        "terminations": terminations,
        "conductors": [
            {
                "element_path": path,
                "stock_revision_id": str(closure.cable.stock_revision_id),
                "kind": element.kind,
                "label": element.label,
                "ends": [
                    {
                        "endpoint_id": endpoint.local_id,
                        "assignment": assignments.get((path, endpoint.local_id)),
                    }
                    for endpoint in closure.cable.endpoints
                ],
            }
            for path, element in closure.elements.items()
        ],
        "endpoints": endpoints,
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
        if (a["end_assembly_revision_id"], a["stack"], a["stock_end"]) != (
            b["end_assembly_revision_id"],
            b["stack"],
            b["stock_end"],
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
            "End stack (end assembly, board, inline parts, connector, pinout or shell) or "
            "stock end changed; end preparation profiles bound to these ends must be "
            "re-applied.",
            connectors,
        )

    def termination_key(row):
        return (row["element_path"], row["endpoint_id"])

    old_terms = _keyed(before["terminations"], termination_key)
    new_terms = _keyed(after["terminations"], termination_key)
    terminations = []
    for key in sorted(old_terms.keys() | new_terms.keys()):
        a, b = old_terms.get(key), new_terms.get(key)
        declared = ("layer_id", "terminal_id", "basis")
        if a is None or b is None or any(a[f] != b[f] for f in declared):
            terminations.append(
                {
                    "element_path": key[0],
                    "endpoint_id": key[1],
                    "before_target": a and f"{a['layer_id']} / {a['terminal_label']}",
                    "after_target": b and f"{b['layer_id']} / {b['terminal_label']}",
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
            "Conductor terminations changed; terminations, schematic, build sheet, "
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
