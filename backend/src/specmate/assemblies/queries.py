"""Permission-complete assembly closure and occurrence projection shared by adapters."""

import hashlib
import json
from collections import deque
from contextvars import ContextVar
from dataclasses import dataclass

from pydantic import ValidationError

from specmate.access.permissions import Perm, authorize
from specmate.assemblies.contracts import (
    AssemblyContent,
    Containment,
    Electrical,
    OccurrenceRef,
    RevisionRef,
)
from specmate.design.closure_reads import closure_reads, prefetch_origins
from specmate.design.models import Revision, Snapshot, SnapshotDependency
from specmate.design.pins import check_pin
from specmate.operations import NotFound, ValidationFailed

MAX_NODES = 5000
MAX_REVISIONS = 2000
_AUTHORIZING = ContextVar("assembly_authorizing_snapshots", default=frozenset())


def parse_content(content, *, kind=None):
    if "assembly" not in content:
        if kind == "assembly":
            raise ValidationFailed("Assembly content is required.")
        return None
    if kind is not None and kind != "assembly":
        raise ValidationFailed("Assembly content requires an assembly definition.")
    try:
        return AssemblyContent.model_validate(content["assembly"])
    except ValidationError:
        # Never echo payload values or reference paths in validation diagnostics.
        raise ValidationFailed("Invalid assembly content.") from None


def refs(relationship):
    return [
        value
        for value in relationship.__dict__.values()
        if isinstance(value, OccurrenceRef | RevisionRef)
    ]


@dataclass(frozen=True)
class ProposedSnapshot:
    id: object
    canonical: bytes
    sha256: str


@dataclass(frozen=True)
class ProposedRevision:
    """A reviewed assembly revision that would be frozen from a new or selected draft.

    Shaped like the `Revision` attributes a closure reads, so an adoption review can
    resolve its multi-level result before any draft is written or frozen.
    """

    id: object
    definition: object
    snapshot: ProposedSnapshot

    @property
    def definition_id(self):
        return self.definition.id

    @property
    def snapshot_id(self):
        return self.snapshot.id


def proposed_revision(placeholder, definition, content):
    body = json.dumps(
        {"content": content}, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode()
    snapshot = ProposedSnapshot(placeholder, body, hashlib.sha256(body).hexdigest())
    return ProposedRevision(placeholder, definition, snapshot)


@dataclass
class Node:
    path: tuple[str, ...]
    revision: Revision
    occurrence: object
    content: dict


class Closure:
    """Authorize every revision before returning any path, count or graph diagnostic."""

    def __init__(
        self, user, content, kind=None, dependencies=(), *, workspace_id=None, proposed=None
    ):
        self.user = user
        self.workspace_id = workspace_id
        # Reviewed, not yet frozen assembly revisions keyed by placeholder ID (see
        # `proposed_revision`); only an adoption review supplies them, never stored content.
        self.proposed = proposed or {}
        self.revisions = {}
        self.nodes = {}
        self.relationships = []
        self.assignments = {}
        self.root = parse_content(content, kind=kind)
        with closure_reads():
            self._read_pending(content, dependencies)
        if self.root is not None:
            self._expand(self.root, (), frozenset())
            self._validate_graph()

    def _revision(self, revision_id, loaded=None):
        if revision_id in self.revisions:
            return self.revisions[revision_id]
        if revision_id in self.proposed:
            # Built from an already authorized exact revision of this workspace.
            self.revisions[revision_id] = self.proposed[revision_id]
            return self.proposed[revision_id]
        if loaded is None:
            loaded = self._load([revision_id])
        revision = loaded.get(str(revision_id))
        # Missing, foreign-workspace and unreadable pins all read as the same NotFound,
        # before any graph diagnostic or a database guard can see them.
        self.workspace_id = check_pin(self.user, revision, self.workspace_id)
        if len(self.revisions) >= MAX_REVISIONS:
            raise ValidationFailed("Assembly exceeds the supported closure limit.")
        self.revisions[revision_id] = revision
        return revision

    def _load(self, revision_ids):
        """One query for a level of pinned revisions, keyed by string id."""
        rows = Revision.objects.select_related("definition", "snapshot").in_bulk(
            {str(rid) for rid in revision_ids}
        )
        return {str(rid): revision for rid, revision in rows.items()}

    def _read_pending(self, content, dependencies):
        """Follow reference closure level by level; documentary cycles are legal.

        Each level's revisions are read in one query and its dependency pins in another.
        Every revision is still pin-checked (missing, foreign and unreadable read alike)
        before anything about it is parsed or returned.
        """
        pending = [*dependencies, *self._references(parse_content(content))]
        while pending:
            level = [
                rid
                for rid in dict.fromkeys(pending)
                if rid not in self.revisions and rid not in self.proposed
            ]
            proposed = [rid for rid in dict.fromkeys(pending) if rid in self.proposed]
            pending = []
            loaded = self._load(level) if level else {}
            fresh = [self._revision(rid, loaded) for rid in level]
            fresh.extend(self._revision(rid) for rid in proposed if rid not in self.revisions)
            for revision in fresh:
                body = json.loads(bytes(revision.snapshot.canonical))
                assembly = parse_content(body["content"], kind=revision.definition.kind)
                pending.extend(self._references(assembly))
            # Non-assembly children can themselves pin restricted sources/designs.
            stored = [r.snapshot_id for r in fresh if not isinstance(r, ProposedRevision)]
            if stored:
                pending.extend(
                    SnapshotDependency.objects.filter(snapshot_id__in=stored).values_list(
                        "revision_id", flat=True
                    )
                )
        self._authorize_typed_references()

    def _authorize_typed_references(self):
        from specmate.design.operations import authorize_design_content

        # Design pins do not include every source-file reference. Let each owning
        # module authorize its retained content before paths or diagnostics escape.
        active = _AUTHORIZING.get()
        token = _AUTHORIZING.set(active | {r.snapshot_id for r in self.revisions.values()})
        prefetch_origins(
            {r.definition_id for r in self.revisions.values() if r.snapshot_id not in active}
        )
        try:
            for revision in self.revisions.values():
                if revision.snapshot_id in active:
                    continue
                content = json.loads(bytes(revision.snapshot.canonical))["content"]
                # Assembly references are already covered by our iterative closure.
                # Do not recursively re-enter it for documentary/historical pins.
                authorize_design_content(
                    self.user,
                    revision.definition,
                    {key: value for key, value in content.items() if key != "assembly"},
                )
        finally:
            _AUTHORIZING.reset(token)

    @staticmethod
    def _references(assembly):
        if assembly is None:
            return []
        revisions = [occ.revision_id for occ in assembly.occurrences]
        revisions.extend(
            occ.assignments.firmware_revision_id
            for occ in assembly.occurrences
            if occ.assignments.firmware_revision_id
        )
        revisions.extend(
            record.assignments.firmware_revision_id
            for record in assembly.assignments
            if record.assignments.firmware_revision_id
        )
        revisions.extend(
            ref.revision_id
            for rel in assembly.relationships
            for ref in refs(rel)
            if isinstance(ref, RevisionRef)
        )
        return revisions

    def _expand(self, assembly, prefix, ancestors):
        for occurrence in assembly.occurrences:
            path = (*prefix, occurrence.local_id)
            if len(path) > 32 or len(self.nodes) >= MAX_NODES:
                raise ValidationFailed("Assembly exceeds the supported occurrence limit.")
            revision = self.revisions[occurrence.revision_id]
            if revision.id in ancestors:
                raise ValidationFailed("Containment cycle.")
            content = json.loads(bytes(revision.snapshot.canonical))["content"]
            self.nodes[path] = Node(path, revision, occurrence, content)
            nested = parse_content(content, kind=revision.definition.kind)
            if nested:
                self._expand(nested, path, ancestors | {revision.id})
        self.relationships.extend((prefix, rel) for rel in assembly.relationships)
        # Outer configuration can assign firmware independently to repeated nested boards.
        for record in assembly.assignments:
            path = (*prefix, *record.path)
            if path not in self.nodes:
                raise ValidationFailed("Assignment occurrence does not resolve.")
            self.assignments[path] = record.assignments
        for path, assignments in [
            ((*prefix, occ.local_id), occ.assignments) for occ in assembly.occurrences
        ] + [((*prefix, *record.path), record.assignments) for record in assembly.assignments]:
            if (
                assignments.firmware_revision_id
                and self.revisions[assignments.firmware_revision_id].definition.kind != "firmware"
            ):
                raise ValidationFailed("Firmware assignment requires a firmware revision.")
            if assignments.population_option_id is not None:
                node = self.nodes[path]
                if node.revision.definition.kind != "pcb_population":
                    raise ValidationFailed(
                        "A population option assignment requires a board population occurrence."
                    )
                options = node.content.get("pcb_population", {}).get("options", [])
                if assignments.population_option_id not in {o["local_id"] for o in options}:
                    raise ValidationFailed(
                        "A population option assignment names an option absent from the"
                        " occurrence's exact population revision."
                    )

    def _validate_graph(self):
        graph = {(): set()}
        for path in self.nodes:
            graph.setdefault(path[:-1], set()).add(path)
            graph.setdefault(path, set())
        for prefix, relationship in self.relationships:
            for ref in refs(relationship):
                if isinstance(ref, OccurrenceRef):
                    path = (*prefix, *ref.path)
                    if path and path not in self.nodes:
                        raise ValidationFailed("Relationship occurrence does not resolve.")
            if isinstance(relationship, Electrical) and relationship.a_terminal is not None:
                from specmate.assemblies.wiring import canonical_terminal

                for ref, terminal in (
                    (relationship.a, relationship.a_terminal),
                    (relationship.b, relationship.b_terminal),
                ):
                    canonical_terminal(self.user, self.nodes[(*prefix, *ref.path)], terminal)
            if isinstance(relationship, Containment):
                parent = (*prefix, *relationship.parent.path)
                child = (*prefix, *relationship.child.path)
                graph[parent].add(child)
        # Explicit containment chains can exceed Python's recursion limit even when
        # the structural occurrence tree is shallow. Use an iterative topological check.
        incoming = dict.fromkeys(graph, 0)
        for children in graph.values():
            for child in children:
                incoming[child] += 1
        ready = deque(path for path, count in incoming.items() if count == 0)
        visited = 0
        while ready:
            path = ready.popleft()
            visited += 1
            for child in graph[path]:
                incoming[child] -= 1
                if incoming[child] == 0:
                    ready.append(child)
        if visited != len(graph):
            raise ValidationFailed("Containment cycle.")


def dependency_revisions(user, definition, content):
    """Design capture hook: exact recursively pinned closure, never live draft children."""
    closure = Closure(user, content, kind=definition.kind, workspace_id=definition.workspace_id)
    return sorted(closure.revisions, key=str)


def permitted_self_dependencies(user, definition, content):
    """Only exact same-definition pins reached by a valid assembly closure.

    Definition identity equality alone is not resolved physical recursion: a new
    revision can contain an older, finite assembly or document its prior revision.
    Arbitrary caller-added self pins never enter this set.
    """
    closure = Closure(user, content, kind=definition.kind, workspace_id=definition.workspace_id)
    return {
        rid
        for rid, revision in closure.revisions.items()
        if revision.definition_id == definition.id
    }


def authorize_content(user, content, workspace_id=None):
    Closure(user, content, workspace_id=workspace_id)


def get_snapshot(user, snapshot_id):
    from specmate.catalog_matching.queries import current_actor
    from specmate.catalog_packs.authoring import authorize_origin

    user = current_actor(user)
    snapshot = Snapshot.objects.select_related("definition").filter(id=snapshot_id).first()
    if snapshot is None:
        raise NotFound("Assembly unavailable.")
    with closure_reads():
        authorize(user, snapshot.definition.workspace_id, Perm.WORKSPACE_READ)
        # The root's retained adoption pack is independent of its child/dependency closure.
        authorize_origin(user, snapshot.definition)
        body = json.loads(bytes(snapshot.canonical))
        # Historical or manually supplied pins are authorized before graph diagnostics too.
        closure = Closure(
            user,
            body["content"],
            kind=snapshot.definition.kind,
            dependencies=snapshot.dependencies.values_list("revision_id", flat=True),
            workspace_id=snapshot.definition.workspace_id,
        )
    if closure.root is None:
        raise ValidationFailed("Snapshot is not an assembly.")
    return snapshot, closure


def occurrence_result(snapshot, node, assignments=None):
    return {
        "address": {"snapshot_id": str(snapshot.id), "path": list(node.path)},
        "definition_id": str(node.revision.definition_id),
        "revision_id": str(node.revision.id),
        "snapshot_sha256": node.revision.snapshot.sha256,
        "kind": node.revision.definition.kind,
        "name": node.revision.definition.name,
        "display_ref": node.occurrence.display_ref,
        "placement": node.occurrence.placement.model_dump(mode="json"),
        "assignments": (assignments or node.occurrence.assignments).model_dump(mode="json"),
    }


def read_assembly(user, snapshot_id):
    snapshot, closure = get_snapshot(user, snapshot_id)
    return {
        "snapshot_id": str(snapshot.id),
        "definition_id": str(snapshot.definition_id),
        "sha256": snapshot.sha256,
        "occurrences": [
            occurrence_result(snapshot, node, closure.assignments.get(node.path))
            for node in closure.nodes.values()
        ],
        "relationships": [
            {"context_path": list(prefix), **rel.model_dump(mode="json")}
            for prefix, rel in closure.relationships
        ],
    }


def resolve_occurrence(user, snapshot_id, path, feature_id=None):
    snapshot, closure = get_snapshot(user, snapshot_id)
    node = closure.nodes.get(tuple(path))
    if node is None:
        raise NotFound("Occurrence not found.")
    result = occurrence_result(snapshot, node, closure.assignments.get(node.path))
    result["address"]["feature_id"] = feature_id
    # Addressing is independent of feature existence/compatibility qualification.
    result["feature_status"] = "not_evaluated" if feature_id else "not_applicable"
    return result
