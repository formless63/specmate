import base64

from django.http import HttpResponse
from ninja import Router

from specmate.operations import Context, execute
from specmate.selected_packages.contracts import Download


def download(request, payload: Download):
    result = execute(
        "selected_package.download",
        Context(user=request.user, via="api", request_id="selected-package-download"),
        payload.model_dump(mode="json"),
    ).result
    response = HttpResponse(
        base64.b64decode(result["archive_base64"]), content_type="application/zip"
    )
    response["Content-Disposition"] = 'attachment; filename="selected-assembly-package.zip"'
    response["Digest"] = f"sha-256={result['sha256']}"
    response["Cache-Control"] = "private, no-store"
    return response


def create_router():
    router = Router(tags=["selected-packages"])
    router.post("/download")(download)
    return router


router = create_router()
