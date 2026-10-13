"""Authorize the entire supplied graph before accounting or evidence diagnostics."""

import json
from contextvars import ContextVar
from uuid import UUID

from pydantic import ValidationError

from specmate.access.permissions import Perm, authorize
from specmate.catalog_matching.queries import current_actor
from specmate.design.models import Revision
from specmate.inventory.queries import get_consumption
from specmate.material_accounting.contracts import MaterialPlan
from specmate.operations import NotFound, ValidationFailed
from specmate.queries import get_bundle_revision, get_revision
from specmate.sources.authority import authorize_revision as authorize_source
from specmate.sources.models import SourceBundleFile
from specmate.workshop_profiles.schemas import SourceFile

_ACTIVE = ContextVar("material_plan_closure", default=frozenset())


def parse_content(content, kind=None):
    if "material_plan" not in content:
        if kind == "material_plan":
            raise ValidationFailed("Typed material plan content is required.")
        return None
    if kind is not None and kind != "material_plan":
        raise ValidationFailed("Material plans require their own definition kind.")
    try:
        return MaterialPlan.model_validate(content["material_plan"])
    except ValidationError:
        raise ValidationFailed("Invalid material plan content.") from None


def validate_content(kind, content):
    plan = parse_content(content, kind)
    return {**content, "material_plan": plan.model_dump(mode="json")} if plan else content


def references(value, *, source_only=False):
    """Read typed plan pins, or only registered-source pins within dependency content.

    Frozen design dependencies own engineering references. Arbitrary fact fields in a
    generic material revision are not interpreted as another engineering graph.
    """
    if isinstance(value, dict):
        for key, child in value.items():
            if key.endswith("revision_id") and child is not None:
                is_source = key.endswith("bundle_revision_id") or (
                    key == "source_revision_id"
                    and (value.get("kind") == "source_file" or "source_manifest_sha256" in value)
                )
                if is_source or not source_only:
                    yield ("source" if is_source else "design"), UUID(str(child))
            else:
                yield from references(child, source_only=source_only)
    elif isinstance(value, list):
        for child in value:
            yield from references(child, source_only=source_only)


def preauthorize(user, content, extra=()):
    pending = [*references(content), *extra]
    seen = set()
    while pending:
        kind, rid = pending.pop()
        if (kind, rid) in seen:
            continue
        if len(seen) >= 4096:
            raise ValidationFailed("Material dependency closure exceeds its bounded limit.")
        seen.add((kind, rid))
        if kind == "source":
            authorize_source(user, get_bundle_revision(user, rid))
        else:
            revision = (
                Revision.objects.select_related("definition", "snapshot").filter(id=rid).first()
            )
            if revision is None:
                raise NotFound("Revision unavailable.")
            authorize(user, revision.definition.project_id, Perm.PROJECT_READ)
            pending.extend(
                references(
                    json.loads(bytes(revision.snapshot.canonical))["content"], source_only=True
                )
            )
            pending.extend(
                ("design", r)
                for r in revision.snapshot.dependencies.values_list("revision_id", flat=True)
            )


def sources(plan):
    for row in [*plan.pieces, *plan.consumables]:
        if hasattr(row, "installed"):
            yield row.installed.source
            yield row.extra_waste.source
        else:
            yield row.source
        if row.reconciliation:
            yield row.reconciliation.source


def closure(user, content, kind=None, *, authority_only=False):
    user = current_actor(user)
    plan = parse_content(content, kind)
    if plan is None:
        return None
    active = _ACTIVE.get()
    if plan.subject_revision_id in active or len(active) >= 32:
        raise ValidationFailed("Material plan reference cycle or nesting limit.")
    token = _ACTIVE.set(active | {plan.subject_revision_id})
    try:
        # Inventory evidence is included in the SAME authority phase, before any amount,
        # stock compatibility, cut, endpoint or missing-file diagnostic.
        from specmate.inventory.models import StockEntry

        entries = {}
        extra = []
        for row in [*plan.pieces, *plan.consumables]:
            if row.reconciliation:
                for cid in row.reconciliation.consumption_ids:
                    entry = (
                        StockEntry.objects.select_related(
                            "account__location", "account__lot", "work_batch"
                        )
                        .filter(id=cid)
                        .first()
                    )
                    if entry is None:
                        raise NotFound("Inventory evidence unavailable.")
                    authorize(user, entry.account.location.project_id, Perm.PROJECT_READ)
                    extra.append(("design", entry.account.lot.revision_id))
                    if entry.work_batch_id:
                        extra.append(("design", entry.work_batch.revision_id))
                    latest = entry.account.entries.order_by("-sequence").first()
                    if latest and latest.work_batch_id:
                        extra.append(("design", latest.work_batch.revision_id))
                    entries[cid] = entry
        preauthorize(user, content, extra)
        if authority_only:
            return plan
        evidence = []
        for source in sources(plan):
            if isinstance(source, SourceFile):
                revision = get_bundle_revision(user, source.bundle_revision_id)
                file = (
                    SourceBundleFile.objects.select_related("blob")
                    .filter(revision=revision, path=source.path)
                    .first()
                )
                if file is None:
                    raise NotFound("Material evidence file unavailable.")
                if file.blob.sha256 != source.sha256 or file.rights != source.rights:
                    raise ValidationFailed("Material evidence digest or rights do not match.")
                evidence.append(file)
        subject = get_revision(user, plan.subject_revision_id)
        if subject.definition.kind not in {"cable", "harness"}:
            raise ValidationFailed("Material plans require an exact cable or harness revision.")
        for consumable in plan.consumables:
            get_revision(user, consumable.revision_id)
        for cid in entries:
            get_consumption(user, cid)
        # Shared projections validate profile stock/end mapping and all quantities.
        from specmate.material_accounting.projection import project

        project(user, plan)
        return plan
    finally:
        _ACTIVE.reset(token)


def authorize_content(user, definition, content):
    closure(user, content, definition.kind)


def dependency_revisions(user, definition, content):
    plan = closure(user, content, definition.kind)
    if plan is None:
        return []
    ids = {rid for kind, rid in references(plan.model_dump(mode="json")) if kind == "design"}
    # Pin inventory work and lot designs as well; ledger events themselves are immutable IDs.
    for row in [*plan.pieces, *plan.consumables]:
        if row.reconciliation:
            for cid in row.reconciliation.consumption_ids:
                entry = get_consumption(user, cid)
                ids.update([entry.account.lot.revision_id, entry.work_batch.revision_id])
    return sorted(ids, key=str)


def inspect_revision(user, revision_id):
    user = current_actor(user)
    revision = get_revision(user, revision_id)
    if revision.definition.kind != "material_plan":
        raise ValidationFailed("An exact material plan revision is required.")
    content = json.loads(bytes(revision.snapshot.canonical))["content"]
    plan = closure(user, content, revision.definition.kind)
    from specmate.material_accounting.projection import project

    return {
        "revision_id": str(revision.id),
        "sha256": revision.snapshot.sha256,
        "plan": plan.model_dump(mode="json"),
        **project(user, plan),
    }
