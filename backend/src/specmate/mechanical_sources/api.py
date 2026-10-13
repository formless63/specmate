"""Read adapters; mutation entry points use the shared operation envelope."""

import json
from uuid import UUID

from ninja import Router

from specmate.access.permissions import Perm, authorize
from specmate.catalog.models import Representation
from specmate.catalog_matching.queries import current_actor
from specmate.design.models import Definition, Revision
from specmate.mechanical_sources.contracts import KIND, ReadMechanicalSource
from specmate.mechanical_sources.operations import mechanical_draft, read, read_revision
from specmate.operations import Context
from specmate.pcb.population import Population, scoped_interpretation
from specmate.pcb.report import Report
from specmate.queries import get_bundle_revision, get_revision

router = Router(tags=["mechanical-sources"])


def context(request):
    return Context(user=current_actor(request.user), via="api", request_id="read-mechanical-source")


@router.get("/drafts/{draft_id}")
def read_draft(request, draft_id: UUID):
    return read(context(request), ReadMechanicalSource(draft_id=draft_id))


@router.get("/revisions/{revision_id}")
def read_frozen(request, revision_id: UUID):
    return read_revision(current_actor(request.user), revision_id)


@router.get("/projects/{project_id}/records")
def list_records(request, project_id: UUID, after: UUID | None = None):
    ctx = context(request)
    authorize(ctx.user, project_id, Perm.PROJECT_READ)
    query = Definition.objects.filter(project_id=project_id, kind=KIND).order_by("id")
    if after:
        query = query.filter(id__gt=after)
    candidates = list(query.prefetch_related("drafts", "revisions")[:51])
    # Fully authorize selected drafts and retained revisions before names/cursors escape.
    for definition in candidates:
        for draft in definition.drafts.all():
            mechanical_draft(ctx, draft.id)
        for revision in definition.revisions.all():
            read_revision(ctx.user, revision.id)
    rows = [
        {
            "definition_id": str(d.id),
            "name": d.name,
            "drafts": [{"draft_id": str(v.id)} for v in d.drafts.all()],
            "revisions": [
                {"revision_id": str(v.id), "number": v.number} for v in d.revisions.all()
            ],
        }
        for d in candidates[:50]
    ]
    return {"records": rows, "next_after": str(candidates[49].id) if len(candidates) > 50 else None}


def target_result(user, revision):
    """Exact board source/geometry pins and model representations; bytes remain inert."""
    board = None
    components = []
    if revision.definition.kind == "pcb_population":
        population = Population.model_validate(
            json.loads(bytes(revision.snapshot.canonical))["content"]["pcb_population"]
        )
        interpretation = scoped_interpretation(
            user, revision.definition.project_id, population.interpretation_id
        )
        get_bundle_revision(user, population.source_revision_id)
        report = Report.model_validate_json(bytes(interpretation.canonical))
        board = {
            "interpretation_id": str(population.interpretation_id),
            "interpretation_sha256": population.interpretation_sha256,
            "source_revision_id": str(population.source_revision_id),
            "source_manifest_sha256": population.source_manifest_sha256,
            "options": [{"local_id": o.local_id, "name": o.name} for o in population.options],
        }
        components = [
            {"id": str(c.id), "reference": c.reference, "value": c.value} for c in report.components
        ]
    model_rows = []
    for model in (
        Representation.objects.select_related("source_file__revision__bundle", "source_file__blob")
        .filter(revision=revision, kind="model")
        .order_by("id")[:101]
    ):
        source = get_bundle_revision(user, model.source_file.revision_id)
        model_rows.append(
            {
                "representation_id": str(model.id),
                "label": model.label,
                "revision_id": str(revision.id),
                "snapshot_sha256": revision.snapshot.sha256,
                "source_revision_id": str(source.id),
                "source_manifest_sha256": source.manifest_sha256,
                "path": model.source_file.path,
                "sha256": model.source_file.blob.sha256,
                "rights": model.source_file.rights,
            }
        )
    return {
        "revision_id": str(revision.id),
        "snapshot_sha256": revision.snapshot.sha256,
        "name": revision.definition.name,
        "number": revision.number,
        "kind": revision.definition.kind,
        "board": board,
        "components": components,
        "models": model_rows[:100],
        "models_truncated": len(model_rows) > 100,
    }


@router.get("/targets/{revision_id}")
def read_target(request, revision_id: UUID):
    user = current_actor(request.user)
    return target_result(user, get_revision(user, revision_id))


@router.get("/projects/{project_id}/targets")
def list_targets(request, project_id: UUID, after: UUID | None = None):
    user = current_actor(request.user)
    authorize(user, project_id, Perm.PROJECT_READ)
    # Reuse may cross currently accessible projects; no copying or privilege grant implied.
    query = (
        Revision.objects.select_related("definition", "snapshot")
        .filter(definition__project__memberships__user=user)
        .order_by("id")
    )
    if after:
        query = query.filter(id__gt=after)
    candidates = list(query[:51])
    rows = []
    for candidate in candidates:
        revision = get_revision(user, candidate.id)
        rows.append(
            {
                "revision_id": str(revision.id),
                "snapshot_sha256": revision.snapshot.sha256,
                "name": revision.definition.name,
                "number": revision.number,
                "kind": revision.definition.kind,
                "board": None,
                "components": [],
                "models": [],
                "models_truncated": False,
            }
        )
    return {
        "targets": rows[:50],
        "next_after": str(candidates[49].id) if len(candidates) > 50 else None,
    }
