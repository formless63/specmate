from uuid import UUID

from ninja import Router

from specmate.catalog_packs import queries

router = Router(tags=["catalog packs"])


@router.get("/source-files")
def source_files(
    request, workspace_id: UUID | None = None, after: int | None = None, limit: int = 50
):
    from specmate.catalog_matching.queries import list_evidence_files

    return list_evidence_files(request.user, workspace_id, after=after, limit=limit)


@router.get("/packs")
def packs(request, workspace_id: UUID | None = None, after: UUID | None = None, limit: int = 25):
    return queries.list_packs(request.user, workspace_id, after=after, limit=limit)


@router.get("/packs/{pack_id}")
def pack(request, pack_id: UUID):
    return queries.get_pack(request.user, pack_id)


@router.get("/versions/{version_id}")
def version(request, version_id: UUID):
    return queries.get_version(request.user, version_id)


@router.get("/packs/{pack_id}/history")
def history(request, pack_id: UUID, after: int = 0, limit: int = 25):
    return queries.history(request.user, pack_id, after=after, limit=limit)
