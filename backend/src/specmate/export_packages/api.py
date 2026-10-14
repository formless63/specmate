import base64

from django.http import HttpResponse
from ninja import Router

from specmate.export_packages.contracts import Download
from specmate.operations import Context, execute


def download(request, payload: Download):
    result = execute(
        "export_package.download",
        Context(user=request.user, via="api", request_id="export-package-download"),
        payload.model_dump(mode="json"),
    ).result
    response = HttpResponse(
        base64.b64decode(result["archive_base64"]), content_type="application/zip"
    )
    response["Content-Disposition"] = 'attachment; filename="export-package.zip"'
    response["Digest"] = f"sha-256={result['sha256']}"
    response["Cache-Control"] = "private, no-store"
    return response


def create_router():
    router = Router(tags=["export-packages"])
    router.post("/download")(download)
    return router
