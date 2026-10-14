import hashlib

from specmate.access.permissions import Perm, authorize
from specmate.catalog_matching.queries import current_actor
from specmate.integrations.models import ExternalObservation, ImportRun, Integration
from specmate.inventory.queries import decimal_text
from specmate.operations import NotFound
from specmate.queries import get_revision


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def who(user):
    return {"id": user.pk, "username": user.get_username()}


def integration_result(i):
    return {
        "integration_id": str(i.id),
        "workspace_id": str(i.workspace_id),
        "name": i.name,
        "adapter": i.adapter,
        "ownership": i.ownership,
        "columns": i.columns,
        "enabled": i.enabled,
        "state": str(i.state),
        "created_by": who(i.created_by),
        "updated_by": who(i.updated_by),
        "created_at": i.created_at.isoformat(),
        "updated_at": i.updated_at.isoformat(),
    }


def import_result(run, *, duplicate=False):
    return {
        "run_id": str(run.id),
        "integration_id": str(run.integration_id),
        "field": run.field,
        "file_sha256": run.content_sha256,
        "row_count": run.row_count,
        "accepted_count": run.accepted_count,
        "rejected_count": run.row_count - run.accepted_count,
        "rejections": run.rejections,
        "duplicate_of_earlier_run": duplicate,
        "observations_are_not_engineering_facts": True,
        "ledger_written": False,
        "actor": who(run.actor),
        "created_at": run.created_at.isoformat(),
    }


def export_result(record, unresolved):
    return {
        "export_id": str(record.id),
        "integration_id": str(record.integration_id),
        "revision_id": str(record.plan_revision_id),
        "purpose": record.purpose,
        "file_format": record.file_format,
        "file_sha256": record.content_sha256,
        "row_count": record.row_count,
        "unresolved": unresolved,
        "content": record.content,
        "actor": who(record.actor),
        "created_at": record.created_at.isoformat(),
    }


def get_integration(user, integration_id, perm=Perm.WORKSPACE_READ):
    user = current_actor(user)
    integration = (
        Integration.objects.select_related("created_by", "updated_by")
        .filter(id=integration_id)
        .first()
    )
    if integration is None:
        raise NotFound("Integration not found.")
    authorize(user, integration.workspace_id, perm)
    return integration


def list_integrations(user, workspace_id):
    user = current_actor(user)
    authorize(user, workspace_id, Perm.WORKSPACE_READ)
    rows = Integration.objects.select_related("created_by", "updated_by").filter(
        workspace_id=workspace_id
    )
    return {
        "workspace_id": str(workspace_id),
        "integrations": [integration_result(i) for i in rows.order_by("name")],
    }


def list_runs(user, integration_id, *, offset=0, limit=50):
    integration = get_integration(user, integration_id)
    runs = ImportRun.objects.select_related("actor").filter(integration=integration)
    return {
        "integration_id": str(integration.id),
        "runs": [import_result(r) for r in runs.order_by("-created_at")[offset : offset + limit]],
        "exports": [
            {
                "export_id": str(e.id),
                "revision_id": str(e.plan_revision_id),
                "purpose": e.purpose,
                "file_sha256": e.content_sha256,
                "row_count": e.row_count,
                "unresolved_count": e.unresolved_count,
                "actor": who(e.actor),
                "created_at": e.created_at.isoformat(),
            }
            for e in integration.exports.select_related("actor").order_by("-created_at")[:limit]
        ],
        "offset": offset,
        "limit": limit,
    }


def list_observations(user, workspace_id, revision_id, *, kind=None):
    """Dated, attributed external claims about one revision; separate from the ledger."""
    user = current_actor(user)
    authorize(user, workspace_id, Perm.WORKSPACE_READ)
    get_revision(user, revision_id)
    query = ExternalObservation.objects.select_related("run__integration", "run__actor").filter(
        workspace_id=workspace_id, revision_id=revision_id
    )
    if kind:
        query = query.filter(kind=kind)
    out = []
    for o in query.order_by("-observed_on", "-created_at")[:200]:
        out.append(
            {
                "observation_id": str(o.id),
                "promoted_offer_id": str(o.promotion.offer_id) if hasattr(o, "promotion") else None,
                "kind": o.kind,
                "observed_on": o.observed_on.isoformat(),
                "valid_until": o.valid_until.isoformat() if o.valid_until else None,
                "external_ref": o.external_ref,
                "supplier": o.supplier,
                "price": None
                if o.price_amount is None and o.price_currency is None
                else {
                    "amount": None if o.price_amount is None else decimal_text(o.price_amount),
                    "currency": o.price_currency,
                    "per_unit": o.price_unit,
                },
                "availability": o.availability,
                "lead_time_days": o.lead_time_days,
                "quantity": None
                if o.kind != "stock_observation"
                else {"amount": decimal_text(o.quantity_amount), "unit": o.quantity_unit},
                "location_label": o.location_label,
                "attribution": {
                    "integration": o.run.integration.name,
                    "run_id": str(o.run_id),
                    "file_sha256": o.run.content_sha256,
                    "imported_by": who(o.run.actor),
                    "row_number": o.row_number,
                },
            }
        )
    return {
        "revision_id": str(revision_id),
        "label": "External observations (not reviewed)",
        "observations": out,
        "is_stock_ledger": False,
    }
