"""Permission-complete assembly closure and occurrence projection shared by adapters."""

import json
from collections import deque
from contextvars import ContextVar
from dataclasses import dataclass

from pydantic import ValidationError

from specmate.access.permissions import Perm, authorize
from specmate.assemblies.contracts import (
    AssemblyContent,
    Containment,
    OccurrenceRef,
    RevisionRef,
)
from specmate.design.models import Revision, Snapshot
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


@dataclass
class Node:
    path: tuple[str, ...]
    revision: Revision
    occurrence: object
    content: dict


class Closure:
    """Authorize every revision before returning any path, count or graph diagnostic."""

    def __init__(self, user, content, kind=None, dependencies=()):
        self.user = user
        self.revisions = {}
        self.nodes = {}
        self.relationships = []
        self.assignments = {}
        self.root = parse_content(content, kind=kind)
        self._read_pending(content, dependencies)
        if self.root is not None:
            self._expand(self.root, (), frozenset())
            self._validate_graph()

    def _revision(self, revision_id):
        if revision_id in self.revisions:
            return self.revisions[revision_id]
        revision = (
            Revision.objects.select_related("definition", "snapshot").filter(id=revision_id).first()
        )
        if revision is None:
            raise NotFound("Assembly unavailable.")
        try:
            authorize(self.user, revision.definition.workspace_id, Perm.WORKSPACE_READ)
        except NotFound:
            raise NotFound("Assembly unavailable.") from None
        if len(self.revisions) >= MAX_REVISIONS:
            raise ValidationFailed("Assembly exceeds the supported closure limit.")
        self.revisions[revision_id] = revision
        return revision

    def _read_pending(self, content, dependencies):
        """Follow reference closure with a visited set; documentary cycles are legal."""
        pending = [*dependencies, *self._references(parse_content(content))]
        while pending:
            rid = pending.pop()
            if rid in self.revisions:
                continue
            revision = self._revision(rid)
            body = json.loads(bytes(revision.snapshot.canonical))
            assembly = parse_content(body["content"], kind=revision.definition.kind)
            pending.extend(self._references(assembly))
            # Non-assembly children can themselves pin restricted sources/designs.
            pending.extend(revision.snapshot.dependencies.values_list("revision_id", flat=True))
        self._authorize_typed_references()

    def _authorize_typed_references(self):
        from specmate.design.operations import authorize_design_content

        # Design pins do not include every source-file reference. Let each owning
        # module authorize its retained content before paths or diagnostics escape.
        active = _AUTHORIZING.get()
        token = _AUTHORIZING.set(active | {r.snapshot_id for r in self.revisions.values()})
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
        for assignments in [occ.assignments for occ in assembly.occurrences] + [
            record.assignments for record in assembly.assignments
        ]:
            if (
                assignments.firmware_revision_id
                and self.revisions[assignments.firmware_revision_id].definition.kind != "firmware"
            ):
                raise ValidationFailed("Firmware assignment requires a firmware revision.")

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
    return sorted(Closure(user, content, kind=definition.kind).revisions, key=str)


def permitted_self_dependencies(user, definition, content):
    """Only exact same-definition pins reached by a valid assembly closure.

    Definition identity equality alone is not resolved physical recursion: a new
    revision can contain an older, finite assembly or document its prior revision.
    Arbitrary caller-added self pins never enter this set.
    """
    closure = Closure(user, content, kind=definition.kind)
    return {
        rid
        for rid, revision in closure.revisions.items()
        if revision.definition_id == definition.id
    }


def authorize_content(user, content):
    Closure(user, content)


def get_snapshot(user, snapshot_id):
    from specmate.catalog_matching.queries import current_actor
    from specmate.catalog_packs.authoring import authorize_origin

    user = current_actor(user)
    snapshot = Snapshot.objects.select_related("definition").filter(id=snapshot_id).first()
    if snapshot is None:
        raise NotFound("Assembly unavailable.")
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
