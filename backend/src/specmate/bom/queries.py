"""Permission-complete frozen inputs and purpose-specific, occurrence-preserving projections."""

import json
from contextvars import ContextVar
from decimal import localcontext

from pydantic import ValidationError

from specmate.access.permissions import Perm, authorize
from specmate.assemblies.queries import Closure as AssemblyClosure
from specmate.bom.contracts import BomPlan, DemandQuantity
from specmate.design.models import Revision
from specmate.design.operations import authorize_snapshot
from specmate.inventory.contracts import (
    CANONICAL_UNITS,
    QUANTITY_CONTEXT,
    UNITS,
    Quantity,
)
from specmate.operations import NotFound, ValidationFailed

_AUTHORIZING = ContextVar("bom_authorizing_snapshots", default=frozenset())


def authorize_reference(user, revision, *, _authorized=None):
    """Apply owning typed-content/source checks without unbounded BOM re-entry."""
    active = _AUTHORIZING.get()
    if revision.snapshot_id in active or len(active) >= 32:
        raise ValidationFailed("BOM authorization nesting limit or dependency cycle.")
    token = _AUTHORIZING.set(active | {revision.snapshot_id})
    try:
        if _authorized is None:
            authorize_snapshot(user, revision.snapshot)
        else:
            authorize_snapshot(user, revision.snapshot, _authorized=_authorized)
    finally:
        _AUTHORIZING.reset(token)


def parse_content(content, kind=None):
    if "bom" not in content:
        if kind == "bom_plan":
            raise ValidationFailed("Typed BOM planning content is required.")
        return None
    if kind is not None and kind != "bom_plan":
        raise ValidationFailed("BOM planning content requires a bom_plan definition.")
    try:
        return BomPlan.model_validate(content["bom"])
    except ValidationError:
        raise ValidationFailed("Invalid BOM planning content.") from None


def validate_content(kind, content):
    value = parse_content(content, kind)
    return {**content, "bom": value.model_dump(mode="json")} if value else content


class Closure:
    def __init__(self, user, content, kind=None, dependencies=()):
        self.plan = parse_content(content, kind)
        self.revisions = {}
        if self.plan is None:
            return
        pending = [
            self.plan.assembly_revision_id,
            *(n.revision_id for n in self.plan.needs),
            *dependencies,
        ]
        while pending:
            rid = pending.pop()
            if rid in self.revisions:
                continue
            if len(self.revisions) >= 2000:
                raise ValidationFailed("BOM dependency limit exceeded.")
            revision = (
                Revision.objects.select_related("definition", "snapshot").filter(id=rid).first()
            )
            if revision is None:
                raise NotFound("BOM reference unavailable.")
            authorize(user, revision.definition.workspace_id, Perm.WORKSPACE_READ)
            self.revisions[rid] = revision
            pending.extend(revision.snapshot.dependencies.values_list("revision_id", flat=True))
        # Project membership alone does not authorize typed source-file references,
        # which need not be represented by design SnapshotDependency rows.
        authorized_snapshots = set()
        for revision in self.revisions.values():
            authorize_reference(user, revision, _authorized=authorized_snapshots)
        self.root = self.revisions[self.plan.assembly_revision_id]
        content = json.loads(bytes(self.root.snapshot.canonical))["content"]
        if self.root.definition.kind != "assembly":
            raise ValidationFailed("BOM root requires an exact assembly revision.")
        self.assembly = AssemblyClosure(user, content, kind="assembly", dependencies=self.revisions)
        for rid, revision in self.assembly.revisions.items():
            if rid not in self.revisions:
                authorize_reference(user, revision, _authorized=authorized_snapshots)
        self.revisions.update(self.assembly.revisions)
        for policy in self.plan.policies:
            node = self.assembly.nodes.get(tuple(policy.path))
            expected = node.revision.id if node else self.root.id if not policy.path else None
            if expected != policy.revision_id:
                raise ValidationFailed("Policy must match an exact contextual occurrence revision.")
        demand_paths = set()
        for demand in self.plan.occurrence_demands:
            path = tuple(demand.path)
            node = self.assembly.nodes.get(path)
            expected = node.revision.id if node else self.root.id if not path else None
            if expected != demand.revision_id or path in demand_paths:
                raise ValidationFailed("Demand must identify one exact contextual occurrence.")
            demand_paths.add(path)
        # Validate semantics and derived arithmetic only after current owning source
        # closure has been authorized, including declarations excluded by buy policy.
        for demand in [*self.plan.occurrence_demands, *self.plan.needs]:
            if not demand.basis.strip() or (demand.waste and not demand.waste.basis.strip()):
                raise ValidationFailed("Demand and waste require an explicit nonblank basis.")
            for quantity in [demand.quantity, *([demand.waste.quantity] if demand.waste else [])]:
                if quantity.amount is not None:
                    try:
                        Quantity(amount=quantity.amount, unit=quantity.unit)
                    except ValidationError:
                        raise ValidationFailed(
                            "Invalid exact dimensional demand quantity."
                        ) from None
            if demand.quantity.amount is not None and demand.quantity.amount <= 0:
                raise ValidationFailed("Net demand must be positive when known.")
            if demand.waste:
                if UNITS[demand.quantity.unit][0] != UNITS[demand.waste.quantity.unit][0]:
                    raise ValidationFailed("Waste allowance must have the net demand dimension.")
                if demand.waste.quantity.amount is not None and demand.waste.quantity.amount < 0:
                    raise ValidationFailed("Waste allowance cannot be negative.")
            demand_quantities(demand, self.plan.quantity.amount)
        for path in [*self.plan.scope_paths, *(n.context_path for n in self.plan.needs)]:
            if path and tuple(path) not in self.assembly.nodes:
                raise ValidationFailed("BOM context does not resolve in the pinned assembly.")
        # A need represents process demand, never a second copy of a retained child.
        for need in self.plan.needs:
            context = tuple(need.context_path)
            if any(
                path[:-1] == context and node.revision.id == need.revision_id
                for path, node in self.assembly.nodes.items()
            ):
                raise ValidationFailed(
                    "A retained child cannot also be a supplemental need in that context."
                )


def authorize_content(user, content):
    Closure(user, content)


def dependency_revisions(user, definition, content):
    return sorted(Closure(user, content, definition.kind).revisions, key=str)


def read_revision(user, revision_id):
    from specmate.catalog_matching.queries import current_actor
    from specmate.catalog_packs.authoring import authorize_origin

    user = current_actor(user)
    revision = (
        Revision.objects.select_related("definition", "snapshot").filter(id=revision_id).first()
    )
    if revision is None:
        raise NotFound("BOM plan unavailable.")
    authorize(user, revision.definition.workspace_id, Perm.WORKSPACE_READ)
    authorize_origin(user, revision.definition)
    closure = Closure(
        user,
        json.loads(bytes(revision.snapshot.canonical))["content"],
        revision.definition.kind,
        revision.snapshot.dependencies.values_list("revision_id", flat=True),
    )
    if closure.plan is None:
        raise ValidationFailed("Revision is not a BOM plan.")
    return revision, closure


def quantity_result(amount, unit):
    return {
        "status": "known" if amount is not None else "unknown",
        "amount": None if amount is None else int(amount) if unit == "ea" else format(amount, "f"),
        "unit": unit,
    }


def demand_quantities(demand, root_count):
    """Independent net and additive waste per root, with bounded exact canonical totals."""
    unit = CANONICAL_UNITS[UNITS[demand.quantity.unit][0]]

    def scaled(quantity):
        if quantity.amount is None or root_count is None:
            return None
        with localcontext(QUANTITY_CONTEXT):
            amount = (quantity.amount * UNITS[quantity.unit][1] * root_count).normalize()
        try:
            Quantity(amount=amount, unit=unit)
        except ValidationError:
            raise ValidationFailed(
                "Derived demand exceeds supported exact quantity bounds."
            ) from None
        return amount

    net = scaled(demand.quantity)
    waste = scaled(demand.waste.quantity) if demand.waste else None
    total = None
    if net is not None and waste is not None:
        with localcontext(QUANTITY_CONTEXT):
            total = (net + waste).normalize()
        try:
            Quantity(amount=total, unit=unit)
        except ValidationError:
            raise ValidationFailed(
                "Demand plus waste exceeds supported exact quantity bounds."
            ) from None
    return {
        "net_quantity": quantity_result(net, unit),
        "waste_quantity": quantity_result(waste, unit),
        "required_quantity": quantity_result(total, unit),
        "waste_status": "declared" if demand.waste else "not_evaluated",
        "waste_basis": demand.waste.basis if demand.waste else None,
        "demand_basis": demand.basis,
        "per_root_quantity": demand.quantity.model_dump(mode="json"),
        "per_root_waste": demand.waste.quantity.model_dump(mode="json") if demand.waste else None,
    }


def project(closure, purpose):
    plan, root, nodes = closure.plan, closure.root, closure.assembly.nodes
    scopes = [tuple(p) for p in plan.scope_paths]
    policies = {tuple(p.path): p for p in plan.policies}
    demands = {tuple(d.path): d for d in plan.occurrence_demands}
    rows, unresolved, boundaries, excluded_needs = [], [], [], []

    def selected(path):
        return not scopes or any(path[: len(scope)] == scope for scope in scopes)

    def address(path):
        return {"snapshot_id": str(root.snapshot_id), "path": list(path)}

    def issue(path, reason, need_id=None):
        unresolved.append({"address": address(path), "reason": reason, "need_id": need_id})

    def blocking(path, include_self=False):
        for size in range(0, len(path) + int(include_self)):
            prefix = path[:size]
            policy = policies.get(prefix)
            if policy is None or policy.decision != "make":
                return prefix, policy.decision if policy else "unknown"
        return None

    def row(path, revision, reason, amount, need=None):
        declaration = need or demands.get(path)
        if declaration is None:
            declaration = SimpleNamespace(
                quantity=DemandQuantity(status="known", amount=1),
                waste=None,
                basis="One structural item per contextual occurrence per root assembly.",
            )
        quantities = demand_quantities(declaration, plan.quantity.amount)
        structural = quantity_result(amount, "ea") if need is None else None
        return {
            "address": address(path),
            "revision_id": str(revision.id),
            "definition_id": str(revision.definition_id),
            "name": revision.definition.name,
            "quantity": structural
            if purpose == "assembly_contents"
            else quantities["net_quantity"],
            "structural_quantity": structural,
            **quantities,
            "reason": reason,
            "need_id": need.local_id if need else None,
            "basis": need.basis if need else (policies[path].basis if path in policies else None),
        }

    from types import SimpleNamespace

    candidates = (
        nodes if purpose == "assembly_contents" else {(): SimpleNamespace(revision=root), **nodes}
    )
    for path, node in candidates.items():
        if not selected(path):
            continue
        if purpose == "assembly_contents":
            rows.append(row(path, node.revision, "retained_occurrence", plan.quantity.amount))
            continue
        block = blocking(path)
        if block:
            # A scoped child cannot bypass a bought or undecided ancestor.
            ancestor, decision = block
            record = {"address": address(ancestor), "decision": decision}
            if record not in boundaries:
                boundaries.append(record)
            if decision == "unknown" and not any(
                i["address"] == address(ancestor) for i in unresolved
            ):
                issue(ancestor, "make_buy_unknown")
            continue
        policy = policies.get(path)
        decision = policy.decision if policy else "unknown"
        if decision == "unknown":
            issue(path, "make_buy_unknown")
        elif decision == "buy":
            boundaries.append({"address": address(path), "decision": "buy"})
            if purpose == "procurement":
                rows.append(row(path, node.revision, "buy_boundary", plan.quantity.amount))
        elif not any(p[:-1] == path for p in nodes) and not any(
            tuple(n.context_path) == path for n in plan.needs
        ):
            issue(path, "make_inputs_unspecified")
    if purpose != "assembly_contents":
        for need in plan.needs:
            path = tuple(need.context_path)
            if not selected(path):
                continue
            block = blocking(path, include_self=True)
            if block:
                ancestor, decision = block
                excluded_needs.append(
                    {
                        "need_id": need.local_id,
                        "address": address(path),
                        "boundary": address(ancestor),
                        "reason": f"ancestor_{decision}",
                    }
                )
                if decision == "unknown" and not any(
                    i["address"] == address(ancestor) for i in unresolved
                ):
                    issue(ancestor, "make_buy_unknown")
                continue
            if purpose == need.purpose or (
                purpose == "procurement" and need.purpose != "consumables"
            ):
                rows.append(
                    row(
                        path,
                        closure.revisions[need.revision_id],
                        "declared_process_need",
                        None,
                        need,
                    )
                )
    for item in rows:
        if item["quantity"]["status"] == "unknown":
            issue(tuple(item["address"]["path"]), "quantity_unknown", item["need_id"])
        if purpose != "assembly_contents" and item["required_quantity"]["status"] == "unknown":
            issue(tuple(item["address"]["path"]), "required_quantity_unknown", item["need_id"])
    return {
        "purpose": purpose,
        "rows": rows,
        "unresolved": unresolved,
        "boundaries": boundaries,
        "excluded_needs": excluded_needs,
        "status": "unknown" if unresolved else "resolved",
        "physical_qualification": "not_evaluated",
        "limitations": [
            "Demand units do not establish stock compatibility; sourcing and native PCB "
            "extraction are not evaluated.",
            "Waste is an explicit additive amount per root assembly. An undeclared "
            "allowance leaves gross required demand unknown.",
            "Process needs are explicit declarations, not validated PCB fabrication "
            "or population instructions.",
        ],
    }


def inspect_revision(user, revision_id, purpose="procurement"):
    revision, closure = read_revision(user, revision_id)
    return {
        "revision_id": str(revision.id),
        "snapshot_id": str(revision.snapshot_id),
        "sha256": revision.snapshot.sha256,
        "bom": closure.plan.model_dump(mode="json"),
        **project(closure, purpose),
    }
