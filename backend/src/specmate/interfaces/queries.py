"""Current-scope validation of exact interface references and declared traces."""

import json

from pydantic import ValidationError

from specmate.access.permissions import Perm, authorize
from specmate.assemblies.queries import Closure as AssemblyClosure
from specmate.catalog_matching.queries import current_actor
from specmate.catalog_packs.authoring import authorize_origin
from specmate.design.models import Revision
from specmate.design.pins import check_pin
from specmate.interfaces.contracts import (
    INTERFACE_ADAPTER,
    KINDS,
    ConnectorBody,
    InterfaceAssessment,
    InterfaceMap,
    Pinout,
)
from specmate.operations import NotFound, ValidationFailed


def parse_content(content, kind=None):
    if "interface" not in content:
        if kind in KINDS:
            raise ValidationFailed("Typed interface content is required.")
        return None
    try:
        value = INTERFACE_ADAPTER.validate_python(content["interface"])
    except ValidationError:
        raise ValidationFailed("Invalid interface content.") from None
    if kind is not None and kind != value.kind:
        raise ValidationFailed("Interface content must match its definition kind.")
    return value


def validate_content(kind, content):
    parsed = parse_content(content, kind)
    return {**content, "interface": parsed.model_dump(mode="json")} if parsed else content


def references(value):
    if isinstance(value, InterfaceAssessment):
        return [value.left_pinout_revision_id, value.right_pinout_revision_id]
    if isinstance(value, Pinout):
        return [value.body_revision_id]
    if isinstance(value, InterfaceMap):
        return [
            value.assembly_revision_id,
            value.external_pinout_revision_id,
            *(p.internal.revision_id for p in value.passages),
        ]
    return []


class Closure:
    def __init__(self, user, content, kind=None, dependencies=()):
        user = current_actor(user)
        self.user = user
        self.root = parse_content(content, kind)
        self.revisions = {}
        self.contents = {}
        self.values = {}
        self.assemblies = {}
        pending = [*references(self.root), *dependencies]
        pin_scope = None
        while pending:
            rid = pending.pop()
            if rid in self.revisions:
                continue
            if len(self.revisions) >= 2000:
                raise ValidationFailed("Interface dependency limit exceeded.")
            revision = (
                Revision.objects.select_related("definition", "snapshot").filter(id=rid).first()
            )
            # Missing, foreign-workspace and unreadable pins read alike, before any guard.
            pin_scope = check_pin(user, revision, pin_scope)
            authorize_origin(user, revision.definition)
            self.revisions[rid] = revision
            body = json.loads(bytes(revision.snapshot.canonical))["content"]
            self.contents[rid] = body
            value = parse_content(body, revision.definition.kind)
            self.values[rid] = value
            pending.extend(references(value))
            pending.extend(revision.snapshot.dependencies.values_list("revision_id", flat=True))
            if revision.definition.kind == "assembly":
                assembly = AssemblyClosure(user, body, kind="assembly")
                self.assemblies[rid] = assembly
                pending.extend(assembly.revisions)
        from specmate.design.operations import authorize_snapshot
        from specmate.interfaces.assessments import authorize_evidence

        self.assessment_evidence = {}
        for value in [self.root, *self.values.values()]:
            if isinstance(value, (InterfaceAssessment, Pinout)):
                self.assessment_evidence[id(value)] = authorize_evidence(user, value)
        # Retained non-interface dependencies can own source evidence of their own.
        for rid, value in self.values.items():
            if value is None and self.revisions[rid].definition.kind != "assembly":
                authorize_snapshot(user, self.revisions[rid].snapshot)
        # All referenced scopes are checked before reference-kind/contact diagnostics.
        for value in [self.root, *self.values.values()]:
            self.validate(value)

    def body_for(self, pinout):
        body = self.values.get(pinout.body_revision_id)
        if not isinstance(body, ConnectorBody):
            raise ValidationFailed("Pinout requires an exact connector body revision.")
        return body

    def validate(self, value):
        if isinstance(value, InterfaceAssessment):
            from specmate.interfaces.assessments import subjects

            subjects(value, self)
        if isinstance(value, Pinout):
            contacts = {c.contact_id: c for c in self.body_for(value).contacts}
            for assignment in value.assignments:
                contact = contacts.get(assignment.contact_id)
                if contact is None or contact.physical_role == "key":
                    raise ValidationFailed(
                        "Pinout assignment must identify a physical contact or shell."
                    )
        if isinstance(value, InterfaceMap):
            pinout = self.values.get(value.external_pinout_revision_id)
            assembly = self.assemblies.get(value.assembly_revision_id)
            if not isinstance(pinout, Pinout) or assembly is None:
                raise ValidationFailed("Mapping requires exact pinout and assembly revisions.")
            ids = {c.contact_id for c in self.body_for(pinout).contacts if c.physical_role != "key"}
            for passage in value.passages:
                if passage.external_contact_id not in ids:
                    raise ValidationFailed("External contact does not exist on the pinned body.")
                node = assembly.nodes.get(tuple(passage.internal.path))
                if node is None or node.revision.id != passage.internal.revision_id:
                    raise ValidationFailed("Internal occurrence does not match the exact revision.")
                self.feature_status(passage.internal.revision_id, passage.internal.feature_id)

    def feature_status(self, rid, feature_id):
        value = self.values.get(rid)
        if isinstance(value, Pinout):
            value = self.body_for(value)
        if isinstance(value, ConnectorBody):
            if feature_id not in {c.contact_id for c in value.contacts if c.physical_role != "key"}:
                raise ValidationFailed("Internal contact does not exist on the pinned body.")
            return "declared_contact"
        return "not_evaluated"


def authorize_content(user, content):
    Closure(user, content)


def dependency_revisions(user, definition, content):
    return sorted(Closure(user, content, definition.kind).revisions, key=str)


def read_revision(user, revision_id):
    user = current_actor(user)
    revision = (
        Revision.objects.select_related("definition", "snapshot").filter(id=revision_id).first()
    )
    if revision is None:
        raise NotFound("Interface unavailable.")
    authorize(user, revision.definition.workspace_id, Perm.WORKSPACE_READ)
    authorize_origin(user, revision.definition)
    content = json.loads(bytes(revision.snapshot.canonical))["content"]
    closure = Closure(
        user,
        content,
        revision.definition.kind,
        revision.snapshot.dependencies.values_list("revision_id", flat=True),
    )
    if closure.root is None:
        raise ValidationFailed("Revision is not an interface definition.")
    return revision, closure


def inspect_revision(user, revision_id):
    revision, closure = read_revision(user, revision_id)
    result = {
        "revision_id": str(revision.id),
        "definition_id": str(revision.definition_id),
        "snapshot_id": str(revision.snapshot_id),
        "sha256": revision.snapshot.sha256,
        "interface": closure.root.model_dump(mode="json"),
        "compatibility": "not_evaluated",
    }
    if isinstance(closure.root, InterfaceAssessment):
        from specmate.interfaces.assessments import assess

        result["assessment"] = assess(closure.root, closure)
    if isinstance(closure.root, Pinout):
        body = closure.body_for(closure.root)
        assignments = {
            a.contact_id: a.electrical.model_dump(mode="json") for a in closure.root.assignments
        }
        from specmate.interfaces.orientation import project_contacts

        result["contact_view"] = project_contacts(body, closure.root.orientation)
        result["contact_views"] = {
            side: project_contacts(
                body, closure.root.orientation.model_copy(update={"viewing_side": side})
            )
            for side in ("mating", "termination")
        }
        result["rating_evidence"] = {
            a.contact_id: {
                r.local_id: closure.assessment_evidence[id(closure.root)][
                    r.evidence.model_dump_json()
                ].model_dump(mode="json")
                for r in a.electrical.conditional_ratings
            }
            for a in closure.root.assignments
        }
        result["contacts"] = [
            {**c.model_dump(mode="json"), "electrical": assignments.get(c.contact_id)}
            for c in body.contacts
        ]
    return result


def trace(user, revision_id, contact_id):
    revision, closure = read_revision(user, revision_id)
    mapping = closure.root
    if not isinstance(mapping, InterfaceMap):
        raise ValidationFailed("Trace requires an interface mapping revision.")
    pinout = closure.values[mapping.external_pinout_revision_id]
    if contact_id not in {
        c.contact_id for c in closure.body_for(pinout).contacts if c.physical_role != "key"
    }:
        raise NotFound("External contact not found.")
    assembly = closure.revisions[mapping.assembly_revision_id]
    passages = [p for p in mapping.passages if p.external_contact_id == contact_id]
    return {
        "revision_id": str(revision.id),
        "external_contact_id": contact_id,
        "external_pinout_revision_id": str(mapping.external_pinout_revision_id),
        "status": "declared" if passages else "unknown",
        "continuity": "not_evaluated",
        "compatibility": "not_evaluated",
        "targets": [
            {
                "passage_id": p.local_id,
                "assembly_revision_id": str(assembly.id),
                "snapshot_id": str(assembly.snapshot_id),
                **p.internal.model_dump(mode="json"),
                "condition": p.condition,
                "basis": p.basis,
                "feature_status": closure.feature_status(
                    p.internal.revision_id, p.internal.feature_id
                ),
            }
            for p in passages
        ],
    }
