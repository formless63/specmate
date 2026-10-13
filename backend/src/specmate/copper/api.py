from uuid import UUID

from ninja import Router

from specmate.copper.contracts import ReadGraph
from specmate.copper.operations import graph
from specmate.operations import Context

router = Router(tags=["copper"])


@router.get("/revisions/{revision_id}")
def revision(request, revision_id: UUID):
    return graph(
        Context(user=request.user, via="api", request_id="read"), ReadGraph(revision_id=revision_id)
    )
