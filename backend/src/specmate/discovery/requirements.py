"""Declared access requirements for registered operations.

The operation registry owns names, schemas and flags. The permission layer owns what a
role may do. This module only classifies each operation's *minimum workspace permission*
(a necessary condition: object-level checks, expected-state tokens and rights still
apply when the operation runs). It is deliberately a classification of the registry, not
a list of operations: names always come from the registry. An unclassifiable operation
(for example a new public one) is reported as "undeclared" with unknown availability, and
every answer carries its basis ("explicit" or the rule used) so a consumer can tell.

Rules, applied in order, keep the table small and reviewable:
  1. explicit ``EXPLICIT`` entries (non-member actors, creation, project, membership,
     build/source/inventory authority);
  2. ``*.freeze`` needs design.freeze;
  3. operations that do not support idempotency evaluate fresh without mutation
     (reads, reviews, computations) and need workspace.read;
  4. every remaining controlled mutation needs design.edit.
"""

from __future__ import annotations

from dataclasses import dataclass

from specmate.access.permissions import Perm

# Actor kinds that are not a workspace role.
PUBLIC = "public"  # no authentication (session login, first-owner claim)
AUTHENTICATED = "authenticated"  # any active signed-in account, no workspace scope
INSTALLATION_OWNER = "installation_owner"
RUNNER_CREDENTIAL = "runner_credential"  # scoped runner token, not an interactive actor
TRUSTED_JOB = "trusted_job"  # internal scheduler; no external actor may call it
OPERATOR = "operator"  # local installation operator (internal transport only)
WORKSPACE = "workspace"  # a permission of the actor's workspace role and grants


@dataclass(frozen=True)
class Requirement:
    kind: str
    permission: Perm | None = None


def _p(perm: Perm) -> Requirement:
    return Requirement(WORKSPACE, perm)


EXPLICIT: dict[str, Requirement] = {
    "session.login": Requirement(PUBLIC),
    "installation.claim_owner": Requirement(PUBLIC),
    "session.logout": Requirement(AUTHENTICATED),
    "project.create": _p(Perm.PROJECT_EDIT),
    "account.create": Requirement(INSTALLATION_OWNER),
    "collaboration.inbox": Requirement(AUTHENTICATED),
    "collaboration.notification": Requirement(AUTHENTICATED),
    "collaboration.mark_read": Requirement(AUTHENTICATED),
    "project.rename": _p(Perm.PROJECT_EDIT),
    "project.archive": _p(Perm.PROJECT_EDIT),
    "project.delete": _p(Perm.PROJECT_EDIT),
    "project.add_reference": _p(Perm.PROJECT_EDIT),
    "project.remove_reference": _p(Perm.PROJECT_EDIT),
    "workspace.access": _p(Perm.WORKSPACE_READ),
    "workspace.set_member": _p(Perm.WORKSPACE_ADMIN),
    "workspace.remove_member": _p(Perm.WORKSPACE_ADMIN),
    "definition.create": _p(Perm.ITEM_CREATE),
    "firmware.create": _p(Perm.ITEM_CREATE),
    "mechanical_source.create": _p(Perm.ITEM_CREATE),
    "mechanical_proposal.create": _p(Perm.ITEM_CREATE),
    "pcb_disagreement.create": _p(Perm.ITEM_CREATE),
    # Typed design items are workspace collection items: creating one is additive.
    "assembly.create": _p(Perm.ITEM_CREATE),
    "bom.create": _p(Perm.ITEM_CREATE),
    "cable.create": _p(Perm.ITEM_CREATE),
    "cable_test_plan.create": _p(Perm.ITEM_CREATE),
    "end_preparation.create": _p(Perm.ITEM_CREATE),
    "harness.create": _p(Perm.ITEM_CREATE),
    "interface.create": _p(Perm.ITEM_CREATE),
    "material_plan.create": _p(Perm.ITEM_CREATE),
    "preparation.create": _p(Perm.ITEM_CREATE),
    # Additive library registrations and imports: contributors are never blocked.
    "catalog.register_variant": _p(Perm.ITEM_CREATE),
    "catalog.register_representation": _p(Perm.ITEM_CREATE),
    "catalog.register_lot": _p(Perm.ITEM_CREATE),
    "catalog.propose_match": _p(Perm.ITEM_CREATE),
    "catalog_pack.register": _p(Perm.ITEM_CREATE),
    "wire_stock.create": _p(Perm.ITEM_CREATE),
    "workshop_profile.create": _p(Perm.ITEM_CREATE),
    "runner.lease": Requirement(RUNNER_CREDENTIAL),
    "runner.heartbeat": Requirement(RUNNER_CREDENTIAL),
    "runner.reconcile": Requirement(RUNNER_CREDENTIAL),
    "runner.input": Requirement(RUNNER_CREDENTIAL),
    "runner.output": Requirement(RUNNER_CREDENTIAL),
    "runner.complete": Requirement(RUNNER_CREDENTIAL),
    "runner.enroll": Requirement(OPERATOR, Perm.WORKSPACE_ADMIN),
    "runner.revoke": Requirement(OPERATOR),
    "build.dispatch": Requirement(TRUSTED_JOB),
    "build.poll": Requirement(TRUSTED_JOB),
    "build.request": _p(Perm.BUILD_EXECUTE),
    "build.cancel": _p(Perm.WORKSPACE_READ),  # requester may cancel; others need build.execute
    "build.get": _p(Perm.WORKSPACE_READ),
    "build.output": _p(Perm.WORKSPACE_READ),
    "build.retry": _p(Perm.BUILD_EXECUTE),
    "build.abandon": _p(Perm.WORKSPACE_READ),  # requester may abandon; others need build.execute
    "diagnostics.installation": Requirement(OPERATOR),
    "installation.safe_stop": Requirement(OPERATOR),
    "installation.resume": Requirement(OPERATOR),
    "installation.reconcile": Requirement(OPERATOR),
    # Project-less reads: authorization is per returned object, not a project role.
    "catalog.revision_labels": Requirement(AUTHENTICATED),
    "evidence.taxonomy": Requirement(AUTHENTICATED),
    # Recording a derived result adds a workspace evidence record (contributor level).
    "evidence.record_interface_assessment": _p(Perm.ITEM_CREATE),
    "evidence.record_firmware_impact": _p(Perm.ITEM_CREATE),
    "firmware_build.request": _p(Perm.BUILD_EXECUTE),
    "pcb.request_extraction": _p(Perm.BUILD_EXECUTE),
    "pcb_disagreement.request_native": _p(Perm.BUILD_EXECUTE),
    "pcb_fabrication.request": _p(Perm.BUILD_EXECUTE),
    "pcb.register_intake": _p(Perm.SOURCE_REGISTER),
    "pcb.accept_extraction": _p(Perm.SOURCE_REGISTER),
    "pcb_disagreement.accept_native": _p(Perm.SOURCE_REGISTER),
    "source.register_blob": _p(Perm.SOURCE_REGISTER),
    "source.create_original_bundle": _p(Perm.SOURCE_REGISTER),
    "source.derive_bundle": _p(Perm.SOURCE_REGISTER),
    "source.expand_zip": _p(Perm.SOURCE_REGISTER),
    "source.revise_bundle": _p(Perm.SOURCE_REGISTER),
    "source.submit_edit": _p(Perm.SOURCE_REGISTER),
    "source_property.declare": _p(Perm.SOURCE_REGISTER),
    "source_property.reconcile": _p(Perm.SOURCE_REGISTER),
    "source_property.transfer": _p(Perm.SOURCE_REGISTER),
    # Additive records: contributors may append. Revising or linking an existing note
    # needs design.edit, or authorship as an object-level rule.
    "knowledge.create": _p(Perm.ITEM_CREATE),
    "facts.register_subject": _p(Perm.ITEM_CREATE),
    "facts.append": _p(Perm.ITEM_CREATE),
    "inventory.reserve": _p(Perm.INVENTORY_RESERVE),
    "inventory.release": _p(Perm.INVENTORY_RESERVE),
    "inventory.adjust": _p(Perm.INVENTORY_MANAGE),
    "inventory.consume": _p(Perm.INVENTORY_MANAGE),
    "inventory.create_location": _p(Perm.INVENTORY_MANAGE),
    "inventory.create_work_batch": _p(Perm.INVENTORY_MANAGE),
    "inventory.establish_quantity": _p(Perm.INVENTORY_MANAGE),
    "inventory.open_stock": _p(Perm.INVENTORY_MANAGE),
    "inventory.receive": _p(Perm.INVENTORY_MANAGE),
    "inventory.record_work_completion": _p(Perm.INVENTORY_MANAGE),
    "inventory.return_unused": _p(Perm.INVENTORY_MANAGE),
    "physical_units.link_work": _p(Perm.INVENTORY_MANAGE),
    "physical_units.register": _p(Perm.INVENTORY_MANAGE),
}

# Non-interactive actors cannot satisfy a user's workspace role.
NON_USER_KINDS = frozenset({RUNNER_CREDENTIAL, TRUSTED_JOB, OPERATOR})


def requirement_for(
    name: str, *, supports_idempotency: bool, public: bool
) -> tuple[Requirement, str] | None:
    """Return (requirement, basis), or None when the operation is not classified."""
    if name in EXPLICIT:
        return EXPLICIT[name], "explicit"
    if public:
        return None
    if name.endswith((".freeze", "_freeze")):
        return _p(Perm.DESIGN_FREEZE), "rule:freeze"
    if not supports_idempotency:
        return _p(Perm.WORKSPACE_READ), "rule:fresh-evaluation"
    return _p(Perm.DESIGN_EDIT), "rule:controlled-mutation"
