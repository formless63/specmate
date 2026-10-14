"""Current-authority reads for actual units and their planned-work associations."""

from django.db import transaction

from specmate.access.permissions import Perm, authorize
from specmate.inventory.queries import get_work_batch, work_batch_result
from specmate.operations import NotFound
from specmate.physical_units.contracts import PhysicalUnitResult, WorkUnitLinkResult
from specmate.physical_units.models import PhysicalUnit, WorkUnitLink
from specmate.queries import get_revision


def get_unit(user, unit_id, *, lock=False):
    query = PhysicalUnit.objects.select_related("revision__definition", "lot", "variant")
    if lock:
        query = query.select_for_update(of=("self",))
    unit = query.filter(id=unit_id).first()
    if unit is None:
        raise NotFound("Physical unit not found.")
    authorize(user, unit.workspace_id, Perm.WORKSPACE_READ)
    get_revision(user, unit.revision_id)
    if unit.lot_id:
        get_revision(user, unit.lot.revision_id)
    if unit.variant_id:
        get_revision(user, unit.variant.revision_id)
    return unit


def unit_result(unit):
    work_link = WorkUnitLink.objects.filter(unit=unit).first()
    return PhysicalUnitResult(
        unit_id=unit.id,
        workspace_id=unit.workspace_id,
        revision_id=unit.revision_id,
        definition_id=unit.revision.definition_id,
        serial=unit.serial,
        origin=unit.origin,
        lot_id=unit.lot_id,
        variant_id=unit.variant_id,
        assertion_source=unit.assertion_source,
        assertion_status=unit.assertion_status,
        registered_by_id=unit.registered_by_id,
        request_id=unit.request_id,
        created_at=unit.created_at.isoformat(),
        work_batch_id=work_link.work_batch_id if work_link else None,
    ).model_dump(mode="json")


def link_result(link):
    return WorkUnitLinkResult(
        link_id=link.id,
        unit_id=link.unit_id,
        work_batch_id=link.work_batch_id,
        assertion_source=link.assertion_source,
        assertion_status=link.assertion_status,
        linked_by_id=link.linked_by_id,
        request_id=link.request_id,
        created_at=link.created_at.isoformat(),
    ).model_dump(mode="json")


@transaction.atomic
def list_units(user, project_id, *, offset=0, limit=50):
    workspace = authorize(user, project_id, Perm.WORKSPACE_READ)
    units = list(
        PhysicalUnit.objects.select_related("revision__definition", "lot", "variant")
        .filter(workspace=workspace)
        .order_by("created_at", "id")[offset : offset + limit]
    )
    for unit in units:
        get_unit(user, unit.id)
        link = WorkUnitLink.objects.filter(unit=unit).first()
        if link:
            get_work_batch(user, link.work_batch_id)
    return {
        "project_id": str(project_id),
        "workspace_id": str(workspace.id),
        "units": [unit_result(unit) for unit in units],
        "offset": offset,
        "limit": limit,
    }


@transaction.atomic
def unit_detail(user, unit_id, *, offset=0, limit=50):
    unit = get_unit(user, unit_id)
    link = WorkUnitLink.objects.filter(unit=unit).first()
    if link:
        get_work_batch(user, link.work_batch_id)
    from specmate.inventory.models import StockEntry
    from specmate.inventory.queries import entry_result, get_account

    usage = list(
        StockEntry.objects.filter(physical_unit=unit).order_by("created_at", "id")[
            offset : offset + limit
        ]
    )
    for entry in usage:
        get_account(user, entry.account_id)
    return {
        "unit": unit_result(unit),
        "work_link": link_result(link) if link else None,
        "usage": [entry_result(entry) for entry in usage],
        "offset": offset,
        "limit": limit,
    }


@transaction.atomic
def work_units(user, work_batch_id, *, offset=0, limit=50):
    batch = get_work_batch(user, work_batch_id)
    links = list(
        WorkUnitLink.objects.select_related(
            "unit__revision__definition", "unit__lot", "unit__variant"
        )
        .filter(work_batch=batch)
        .order_by("created_at", "id")[offset : offset + limit]
    )
    for link in links:
        get_unit(user, link.unit_id)
    return {
        "work_batch": work_batch_result(batch),
        "linked_unit_count": WorkUnitLink.objects.filter(work_batch=batch).count(),
        "units": [unit_result(link.unit) for link in links],
        "offset": offset,
        "limit": limit,
    }
