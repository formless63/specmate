"""Permission-complete frozen inputs and purpose-specific, occurrence-preserving projections."""

import json

from pydantic import ValidationError

from specmate.access.permissions import Perm, authorize
from specmate.assemblies.queries import Closure as AssemblyClosure
from specmate.bom.contracts import BomPlan
from specmate.design.models import Revision
from specmate.operations import NotFound, ValidationFailed


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
            authorize(user, revision.definition.project_id, Perm.PROJECT_READ)
            self.revisions[rid] = revision
            pending.extend(revision.snapshot.dependencies.values_list("revision_id", flat=True))
        self.root = self.revisions[self.plan.assembly_revision_id]
        content = json.loads(bytes(self.root.snapshot.canonical))["content"]
        if self.root.definition.kind != "assembly":
            raise ValidationFailed("BOM root requires an exact assembly revision.")
        self.assembly = AssemblyClosure(user, content, kind="assembly", dependencies=self.revisions)
        self.revisions.update(self.assembly.revisions)
        for policy in self.plan.policies:
            node = self.assembly.nodes.get(tuple(policy.path))
            expected = node.revision.id if node else self.root.id if not policy.path else None
            if expected != policy.revision_id:
                raise ValidationFailed("Policy must match an exact contextual occurrence revision.")
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
    revision = (
        Revision.objects.select_related("definition", "snapshot").filter(id=revision_id).first()
    )
    if revision is None:
        raise NotFound("BOM plan unavailable.")
    authorize(user, revision.definition.project_id, Perm.PROJECT_READ)
    closure = Closure(
        user,
        json.loads(bytes(revision.snapshot.canonical))["content"],
        revision.definition.kind,
        revision.snapshot.dependencies.values_list("revision_id", flat=True),
    )
    if closure.plan is None:
        raise ValidationFailed("Revision is not a BOM plan.")
    return revision, closure


def project(closure, purpose):
    plan, root, nodes = closure.plan, closure.root, closure.assembly.nodes
    scopes = [tuple(p) for p in plan.scope_paths]
    policies = {tuple(p.path): p for p in plan.policies}
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
        return {
            "address": address(path),
            "revision_id": str(revision.id),
            "definition_id": str(revision.definition_id),
            "name": revision.definition.name,
            "quantity": {
                "status": "known" if amount is not None else "unknown",
                "amount": amount,
                "unit": "ea",
            },
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
                amount = (
                    None
                    if plan.quantity.amount is None or need.quantity.amount is None
                    else plan.quantity.amount * need.quantity.amount
                )
                rows.append(
                    row(
                        path,
                        closure.revisions[need.revision_id],
                        "declared_process_need",
                        amount,
                        need,
                    )
                )
    for item in rows:
        if item["quantity"]["status"] == "unknown":
            issue(tuple(item["address"]["path"]), "quantity_unknown", item["need_id"])
    return {
        "purpose": purpose,
        "rows": rows,
        "unresolved": unresolved,
        "boundaries": boundaries,
        "excluded_needs": excluded_needs,
        "status": "unknown" if unresolved else "resolved",
        "physical_qualification": "not_evaluated",
        "limitations": [
            "Counts only; stock lengths, mass, waste, sourcing and native PCB extraction "
            "are not evaluated.",
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
