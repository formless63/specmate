import base64

from django.http import HttpResponse
from ninja import Router

from specmate.operations import Context, execute
from specmate.releases.contracts import ReleaseRef


def download(request, payload: ReleaseRef):
    result = execute(
        "release.download",
        Context(user=request.user, via="api", request_id="release-download"),
        payload.model_dump(mode="json"),
    ).result
    response = HttpResponse(
        base64.b64decode(result["archive_base64"]), content_type="application/zip"
    )
    response["Content-Disposition"] = 'attachment; filename="release-package.zip"'
    response["Digest"] = f"sha-256={result['sha256']}"
    response["Cache-Control"] = "private, no-store"
    return response


def create_router():
    router = Router(tags=["releases"])
    router.post("/download")(download)
    return router
