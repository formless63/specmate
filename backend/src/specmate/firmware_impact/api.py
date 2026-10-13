from ninja import Router

from specmate.firmware_impact.contracts import CompareImpact
from specmate.firmware_impact.operations import compare
from specmate.operations import Context

router = Router(tags=["firmware-impact"])


@router.post("/compare")
def compare_impact(request, payload: CompareImpact):
    return compare(Context(user=request.user, via="api", request_id="read-impact"), payload)
