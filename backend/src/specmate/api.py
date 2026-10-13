"""HTTP API root. Endpoints are thin adapters over the shared operation layer."""

from importlib.metadata import version

from ninja import NinjaAPI, Schema

api = NinjaAPI(title="Specmate", version="0", urls_namespace="api")


class Health(Schema):
    status: str
    version: str


@api.get("/health", response=Health, auth=None, tags=["system"])
def health(request):
    """Process liveness only. It does not report schema readiness or tool availability."""
    return {"status": "ok", "version": version("specmate")}
