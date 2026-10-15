"""Current-scope validation of exact interface references and declared traces."""

import json

from pydantic import ValidationError

from specmate.access.permissions import Perm, authorize
from specmate.assemblies.queries import Closure as AssemblyClosure
from specmate.catalog_matching.queries import current_actor
from specmate.catalog_packs.authoring import authorize_origin
from specmate.design.closure_reads import closure_reads, prefetch_origins
from specmate.design.models import Revision, SnapshotDependency
from specmate.design.pins import check_pin
from specmate.interfaces.contracts import (
    INTERFACE_ADAPTER,
    KINDS,
    ConnectorBody,
    InterfaceAssessment,
    InterfaceMap,
    Pinout,
    Port,
)
from specmate.interfaces.signal_contracts import SignalSet, role_accepts
from specmate.operations import NotFound, PermissionDenied, ValidationFailed


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
        return [value.body_revision_id, *signal_set_revisions(value)]
    if isinstance(value, ConnectorBody):
        return [m.body_revision_id for m in value.mates_with]
    if isinstance(value, Port):
        return [value.pinout_revision_id]
    if isinstance(value, InterfaceMap):
        return [
            value.assembly_revision_id,
            value.external_pinout_revision_id,
            *(p.internal.revision_id for p in value.passages),
        ]
    return []


def signal_refs(pinout):
    """Every (role, signal_ref) a pinout declares, conditional meanings included."""
    for assignment in pinout.assignments:
        if assignment.electrical.signal_ref is not None:
            yield assignment.electrical.role, assignment.electrical.signal_ref
        for alternative in assignment.alternatives:
            if alternative.signal_ref is not None:
                yield alternative.role, alternative.signal_ref


def signal_set_revisions(pinout):
    return list(dict.fromkeys(ref.signal_set_revision_id for _, ref in signal_refs(pinout)))


class Closure:
    def __init__(self, user, content, kind=None, dependencies=()):
        # One membership read per workspace for the whole read-only closure walk.
        with closure_reads():
            self._build(user, content, kind, dependencies)

    def _build(self, user, content, kind, dependencies):
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
            pending = []
            batch = []
            for rid in level:
                if len(self.revisions) >= 2000:
                    raise ValidationFailed("Interface dependency limit exceeded.")
                revision = loaded.get(str(rid))
                # Missing, foreign-workspace and unreadable pins read alike, before any guard.
                pin_scope = check_pin(user, revision, pin_scope)
                self.revisions[rid] = revision
                batch.append((rid, revision))
            prefetch_origins({revision.definition_id for _, revision in batch})
            deps = {}
            for snapshot_id, revision_id in SnapshotDependency.objects.filter(
                snapshot_id__in=[revision.snapshot_id for _, revision in batch]
            ).values_list("snapshot_id", "revision_id"):
                deps.setdefault(snapshot_id, []).append(revision_id)
            for rid, revision in batch:
                authorize_origin(user, revision.definition)
                body = json.loads(bytes(revision.snapshot.canonical))["content"]
                self.contents[rid] = body
                value = parse_content(body, revision.definition.kind)
                self.values[rid] = value
                pending.extend(references(value))
                pending.extend(deps.get(revision.snapshot_id, ()))
                if revision.definition.kind == "assembly":
                    assembly = AssemblyClosure(user, body, kind="assembly")
                    self.assemblies[rid] = assembly
                    pending.extend(assembly.revisions)
        from specmate.design.operations import authorize_snapshots
        from specmate.interfaces.assessments import authorize_evidence

        self.assessment_evidence = {}
        for value in [self.root, *self.values.values()]:
            if isinstance(value, (InterfaceAssessment, Pinout)):
                self.assessment_evidence[id(value)] = authorize_evidence(user, value)
        # Retained non-interface dependencies can own source evidence of their own.
        retained = [
            self.revisions[rid].snapshot
            for rid, value in self.values.items()
            if value is None and self.revisions[rid].definition.kind != "assembly"
        ]
        if retained:
            authorize_snapshots(user, retained)
        # All referenced scopes are checked before reference-kind/contact diagnostics.
        for value in [self.root, *self.values.values()]:
            self.validate(value)

    def body_for(self, pinout):
        body = self.values.get(pinout.body_revision_id)
        if not isinstance(body, ConnectorBody):
            raise ValidationFailed("Pinout requires an exact connector body revision.")
        return body

    def validate(self, value):
        if isinstance(value, ConnectorBody):
            self.validate_mating(value)
        if isinstance(value, Port):
            self.validate_port(value)
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
            for role, ref in signal_refs(value):
                signal = self.signal(ref)
                if not role_accepts(role, signal.type):
                    raise ValidationFailed(f"Pin role {role} cannot carry a {signal.type} signal.")
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

    def validate_mating(self, body):
        mine = {c.contact_id for c in body.contacts if c.physical_role != "key"}
        for mate in body.mates_with:
            other = self.values.get(mate.body_revision_id)
            if not isinstance(other, ConnectorBody):
                raise ValidationFailed("A mating partner must be an exact connector body revision.")
            roles = {body.mating_role, other.mating_role}
            if (
                body.mating_role == other.mating_role and body.mating_role in ("plug", "receptacle")
            ) or ("hermaphroditic" in roles and len(roles - {"unknown"}) > 1):
                raise ValidationFailed("Declared mating roles cannot mate with each other.")
            theirs = {c.contact_id for c in other.contacts if c.physical_role != "key"}
            if mate.correspondence == "same_contact_id":
                if not mine or not mine <= theirs:
                    raise ValidationFailed(
                        "Same-ID correspondence needs every contact on the partner body."
                    )
            else:
                for pair in mate.pairs:
                    if pair.this not in mine or pair.other not in theirs:
                        raise ValidationFailed("A mating pair must name contacts on both bodies.")

    def validate_port(self, port):
        pinout = self.values.get(port.pinout_revision_id)
        if not isinstance(pinout, Pinout):
            raise ValidationFailed("A port requires an exact pinout variant revision.")
        if "unknown" not in (port.role, pinout.role) and port.role != pinout.role:
            raise ValidationFailed("The port role contradicts its pinout variant role.")
        conditions = {c.key: {choice.key for choice in c.choices} for c in pinout.conditions}
        for key, choice in port.selected_conditions.items():
            if choice not in conditions.get(key, ()):
                raise ValidationFailed("A selected condition must be declared by the variant.")
        contacts = {
            c.contact_id for c in self.body_for(pinout).contacts if c.physical_role != "key"
        }
        for pin in port.pins:
            if pin.contact_id not in contacts:
                raise ValidationFailed("A port pin must identify a contact of the pinned body.")

    def signal(self, ref):
        signals = self.values.get(ref.signal_set_revision_id)
        if not isinstance(signals, SignalSet):
            raise ValidationFailed("A typed pin signal requires an exact signal set revision.")
        for signal in signals.signals:
            if signal.key == ref.key:
                return signal
        raise ValidationFailed("The signal is not declared in the pinned signal set.")

    def describe(self, ref):
        if ref is None:
            return None
        signal = self.signal(ref)
        revision = self.revisions[ref.signal_set_revision_id]
        return {
            **ref.model_dump(mode="json"),
            "name": signal.name,
            "type": signal.type,
            "set_name": revision.definition.name,
            "set_revision_number": revision.number,
        }

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
        result["signals"] = pin_signals(closure.root, closure)
    if isinstance(closure.root, ConnectorBody):
        result["pinout_variants"] = pinout_variants(user, revision)
        result["mates_with"] = [
            mating_row(m, closure.revisions[m.body_revision_id], closure)
            for m in closure.root.mates_with
        ]
        result["mated_by"] = mated_by(user, revision)
    if isinstance(closure.root, Port):
        result["end"] = end_rows(closure.root, revision, closure)
    return result


def mating_row(mate, partner, closure):
    other = closure.values[mate.body_revision_id]
    if mate.correspondence == "same_contact_id":
        theirs = {c.contact_id for c in other.contacts if c.physical_role != "key"}
        mine = [c.contact_id for c in closure.root.contacts if c.physical_role != "key"]
        pairs = [{"this": c, "other": c} for c in mine if c in theirs]
    else:
        pairs = [p.model_dump(mode="json") for p in mate.pairs]
    return {
        **mate.model_dump(mode="json", exclude={"pairs"}),
        "name": partner.definition.name,
        "number": partner.number,
        "mating_role": other.mating_role,
        # Unreviewed correspondence is a declaration, never established mating.
        "status": "reviewed" if mate.review == "reviewed" else "unknown",
        "pairs": pairs,
    }


def mated_by(user, body_revision):
    """Other bodies whose newest frozen revision declares mating with any revision of this one."""
    latest = {}
    for revision in (
        Revision.objects.select_related("definition", "snapshot")
        .filter(
            definition__kind="connector_body",
            definition__workspace_id=body_revision.definition.workspace_id,
            snapshot__dependencies__revision__definition_id=body_revision.definition_id,
        )
        .exclude(definition_id=body_revision.definition_id)
        .order_by("definition_id", "-number")
        .distinct()
    ):
        latest.setdefault(revision.definition_id, revision)
    ours = set(
        Revision.objects.filter(definition_id=body_revision.definition_id).values_list(
            "id", flat=True
        )
    )
    rows = []
    for revision in latest.values():
        try:
            authorize_origin(user, revision.definition)
        except (NotFound, PermissionDenied):
            continue
        body = parse_content(json.loads(bytes(revision.snapshot.canonical))["content"])
        for mate in body.mates_with:
            if mate.body_revision_id in ours:
                rows.append(
                    {
                        "body_revision_id": str(revision.id),
                        "name": revision.definition.name,
                        "number": revision.number,
                        "declares_revision_id": str(mate.body_revision_id),
                        "correspondence": mate.correspondence,
                        "review": mate.review,
                        "status": "reviewed" if mate.review == "reviewed" else "unknown",
                    }
                )
    rows.sort(key=lambda r: (r["name"].casefold(), r["body_revision_id"]))
    return rows


def resolve_pin(pinout, assignment, selections, closure):
    """A contact's signal under the selected conditions; unselected conditions stay unknown."""
    if assignment is None:
        return {"status": "unknown", "reason": "No pin assignment in the variant."}
    if assignment.alternatives:
        key = assignment.alternatives[0].condition_key
        names = {c.key: c.name for c in pinout.conditions}
        choice = selections.get(key)
        chosen = next((a for a in assignment.alternatives if a.choice == choice), None)
        if chosen is None:
            possible = [
                {
                    "choice": a.choice,
                    "role": a.role,
                    "signal": a.signal,
                    "signal_ref": closure.describe(a.signal_ref),
                }
                for a in assignment.alternatives
            ]
            hazards = []
            if any(
                a["role"] == "power" or (a["signal_ref"] or {}).get("type") == "power"
                for a in possible
            ):
                hazards.append("may_be_power")
            return {
                "status": "unknown",
                "reason": f"Condition {names.get(key, key)} is not selected.",
                "condition_key": key,
                "alternatives": possible,
                "hazards": hazards,
            }
        return {
            "status": "declared",
            "role": chosen.role,
            "signal": closure.describe(chosen.signal_ref),
            "note": chosen.signal,
            "condition": {"key": key, "choice": choice},
        }
    typed = closure.describe(assignment.electrical.signal_ref)
    return {
        "status": "declared" if typed else "unknown",
        "role": assignment.electrical.role,
        "signal": typed,
        "note": assignment.electrical.signal,
        **({} if typed else {"reason": "No typed signal declared."}),
    }


def end_rows(value, revision, closure):
    """One cable end's per-contact expectations from a device port or a bare pinout variant.

    A destination may be given either way. A pinout variant has no device facts, so every
    device expectation reads unknown; a port adds its declared facts and condition choices.
    """
    port = value if isinstance(value, Port) else None
    pinout = closure.values[port.pinout_revision_id] if port else value
    selections = port.selected_conditions if port else {}
    body = closure.body_for(pinout)
    assignments = {a.contact_id: a for a in pinout.assignments}
    pins = {p.contact_id: p for p in port.pins} if port else {}
    rows = []
    for contact in body.contacts:
        if contact.physical_role == "key":
            continue
        pin = pins.get(contact.contact_id)
        rows.append(
            {
                "contact_id": contact.contact_id,
                "number": contact.number,
                "label": contact.label,
                "physical_role": contact.physical_role,
                **resolve_pin(pinout, assignments.get(contact.contact_id), selections, closure),
                "device": pin.model_dump(mode="json") if pin else None,
            }
        )
    return {
        "kind": value.kind,
        "revision_id": str(revision.id),
        "device_label": port.device_label if port else None,
        "role": port.role if port and port.role != "unknown" else pinout.role,
        "variant_label": pinout.variant_label,
        "standard": pinout.standard,
        "pinout_revision_id": str(port.pinout_revision_id) if port else str(revision.id),
        "body_revision_id": str(pinout.body_revision_id),
        "selected_conditions": selections,
        "compatibility": "not_evaluated",
        "rows": rows,
    }


def end_expectations(user, revision_id):
    revision, closure = read_revision(user, revision_id)
    if not isinstance(closure.root, (Port, Pinout)):
        raise ValidationFailed("A cable end is a device port or a pinout variant.")
    return end_rows(closure.root, revision, closure)


def pin_signals(pinout, closure):
    """Resolved typed signal per contact; a conditional pin without a selection is unknown."""
    rows = {}
    for assignment in pinout.assignments:
        alternatives = [
            {
                "condition_key": a.condition_key,
                "choice": a.choice,
                "role": a.role,
                "signal": a.signal,
                "signal_ref": closure.describe(a.signal_ref),
            }
            for a in assignment.alternatives
        ]
        typed = closure.describe(assignment.electrical.signal_ref)
        if alternatives:
            status = "conditional"
        elif typed is not None:
            status = "declared"
        else:
            status = "unknown"
        rows[assignment.contact_id] = {
            "status": status,
            "signal": typed,
            "alternatives": alternatives,
        }
    return rows


def pinout_variants(user, body_revision):
    """Frozen pinouts of any revision of this body, newest revision per pinout definition.

    Exact pins stay inside the body's workspace, so the actor's read of the body covers them.
    """
    latest = {}
    for revision in (
        Revision.objects.select_related("definition", "snapshot")
        .filter(
            definition__kind="pinout",
            definition__workspace_id=body_revision.definition.workspace_id,
            snapshot__dependencies__revision__definition_id=body_revision.definition_id,
        )
        .order_by("definition_id", "-number")
        .distinct()
    ):
        latest.setdefault(revision.definition_id, revision)
    ours = set(
        Revision.objects.filter(definition_id=body_revision.definition_id).values_list(
            "id", flat=True
        )
    )
    variants = []
    for revision in latest.values():
        try:
            authorize_origin(user, revision.definition)
        except (NotFound, PermissionDenied):
            continue
        content = json.loads(bytes(revision.snapshot.canonical))["content"]
        value = parse_content(content, "pinout")
        if value.body_revision_id not in ours:
            # Pinned only through a mating partner of its own body.
            continue
        variants.append(
            {
                "definition_id": str(revision.definition_id),
                "name": revision.definition.name,
                "revision_id": str(revision.id),
                "number": revision.number,
                "variant_label": value.variant_label,
                "role": value.role,
                "standard": value.standard,
                "body_revision_id": str(value.body_revision_id),
                "same_body_revision": value.body_revision_id == body_revision.id,
            }
        )
    variants.sort(key=lambda v: ((v["variant_label"] or v["name"]).casefold(), v["definition_id"]))
    return variants


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
