"""HTTP API. Endpoints are thin adapters over the shared operation layer and queries."""

from importlib.metadata import version
from uuid import UUID

from django.http import HttpResponse
from ninja import File, Form, NinjaAPI, Schema
from ninja.files import UploadedFile
from ninja.security import django_auth

from specmate import queries
from specmate.access.api import router as access_router
from specmate.access.session import require_browser_request
from specmate.access.session_api import router as session_router
from specmate.assemblies.api import router as assemblies_router
from specmate.builds.api import artifacts_router
from specmate.builds.api import router as runner_router
from specmate.catalog.api import router as catalog_router
from specmate.contracts import OperationEnvelope
from specmate.facts.api import router as facts_router
from specmate.interfaces.api import router as interfaces_router
from specmate.inventory.api import router as inventory_router
from specmate.operations import Context, OperationError, OperationResult, execute, registry
from specmate.pcb.api import router as pcb_router
from specmate.wire_stock.api import router as stock_router
from specmate.workshop_profiles.api import router as workshop_profile_router

api = NinjaAPI(title="Specmate", version="0", urls_namespace="api", auth=django_auth)
api.add_router("/v0/access", access_router)
api.add_router("/v0/catalog", catalog_router)
api.add_router("/v0/facts", facts_router)
api.add_router("/v0/session", session_router)
api.add_router("/v0/inventory", inventory_router)
api.add_router("/v0/assemblies", assemblies_router)
api.add_router("/v0/interfaces", interfaces_router)
api.add_router("/v0/runner", runner_router)
api.add_router("/v0/builds", artifacts_router)
api.add_router("/v0/pcb", pcb_router)

api.add_router("/v0", stock_router)
api.add_router("/v0", workshop_profile_router)


@api.exception_handler(OperationError)
def operation_error(request, exc: OperationError):
    return api.create_response(request, {"error": exc.as_dict()}, status=exc.http_status)


class Health(Schema):
    status: str
    version: str


@api.get("/health", response=Health, auth=None, tags=["system"])
def health(request):
    """Process liveness only. It does not report schema readiness or tool availability."""
    return {"status": "ok", "version": version("specmate")}


@api.get("/ready", response={200: Health, 503: Health}, auth=None, tags=["system"])
def ready(request):
    """Application schema readiness; no secrets or database diagnostics are exposed."""
    from specmate.operations.startup import schema_ready

    available = schema_ready()
    return (200 if available else 503), {
        "status": "ready" if available else "unavailable",
        "version": version("specmate"),
    }


def _context(request, envelope: OperationEnvelope, **extra) -> Context:
    return Context(
        user=request.user if request.user.is_authenticated else None,
        via="api",
        request_id=envelope.request_id,
        idempotency_key=envelope.idempotency_key,
        expected_state=envelope.expected_state,
        request=request,
        **extra,
    )


@api.get("/v0/operations", tags=["operations"])
def list_operations(request):
    """Operations implemented by this instance, with their payload schemas."""
    return [
        {
            "operation": spec.name,
            "summary": spec.summary,
            "requires_expected_state": spec.requires_expected_state,
            "supports_idempotency": spec.supports_idempotency,
            "attachments": list(spec.attachments),
            "payload_schema": spec.payload.model_json_schema(),
        }
        for spec in sorted(registry.values(), key=lambda s: s.name)
        if not spec.public
    ]


@api.post("/v0/operations", response=OperationResult, tags=["operations"])
def run_operation(request, envelope: OperationEnvelope):
    spec = registry.get(envelope.operation)
    if spec is not None and (spec.public or spec.attachments):
        # Public and upload operations have dedicated endpoints.
        return api.create_response(
            request,
            {"error": {"code": "unsupported", "message": "Use the dedicated endpoint."}},
            status=404,
        )
    return execute(envelope.operation, _context(request, envelope), envelope.payload)


class ClaimOwnerRequest(Schema):
    request_id: str
    token: str
    username: str
    password: str


@api.post("/v0/setup/owner", response=OperationResult, auth=None, tags=["setup"])
def claim_owner(request, body: ClaimOwnerRequest):
    envelope = OperationEnvelope(operation="installation.claim_owner", request_id=body.request_id)
    ctx = _context(request, envelope)
    require_browser_request(ctx)
    payload = body.dict(exclude={"request_id"})
    return execute("installation.claim_owner", ctx, payload)


@api.post("/v0/projects/{project_id}/blobs", response=OperationResult, tags=["sources"])
def register_blob(
    request,
    project_id: UUID,
    request_id: Form[str],
    sha256: Form[str],
    size: Form[int],
    media_type: Form[str],
    content: File[UploadedFile],
    idempotency_key: Form[str | None] = None,
):
    envelope = OperationEnvelope(
        operation="source.register_blob", request_id=request_id, idempotency_key=idempotency_key
    )
    ctx = _context(request, envelope, attachments={"content": content})
    payload = {"project_id": project_id, "sha256": sha256, "size": size, "media_type": media_type}
    return execute("source.register_blob", ctx, payload)


@api.get("/v0/projects", tags=["projects"])
def list_projects(request):
    return queries.list_projects(request.user)


@api.get("/v0/projects/{project_id}/definitions", tags=["design"])
def list_definitions(request, project_id: UUID):
    return queries.list_definitions(request.user, project_id)


@api.get("/v0/drafts/{draft_id}", tags=["design"])
def get_draft(request, draft_id: UUID):
    return queries.get_draft(request.user, draft_id)


@api.get("/v0/revisions/{revision_id}", tags=["design"])
def get_revision(request, revision_id: UUID):
    revision = queries.get_revision(request.user, revision_id)
    return {
        "revision_id": str(revision.id),
        "definition_id": str(revision.definition_id),
        "number": revision.number,
        "snapshot_id": str(revision.snapshot_id),
        "sha256": revision.snapshot.sha256,
        "frozen_at": revision.frozen_at.isoformat(),
    }


@api.get("/v0/revisions/{revision_id}/snapshot", tags=["design"])
def get_revision_snapshot(request, revision_id: UUID):
    """Exact canonical bytes of the frozen state."""
    revision = queries.get_revision(request.user, revision_id)
    response = HttpResponse(bytes(revision.snapshot.canonical), content_type="application/json")
    response["Digest"] = f"sha-256={revision.snapshot.sha256}"
    return response


@api.get("/v0/bundle-revisions/{revision_id}/manifest", tags=["sources"])
def get_bundle_manifest(request, revision_id: UUID):
    revision = queries.get_bundle_revision(request.user, revision_id)
    return HttpResponse(bytes(revision.manifest), content_type="application/json")
