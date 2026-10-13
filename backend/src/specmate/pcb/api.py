import json
from uuid import UUID

from django.http import FileResponse
from django.utils.http import content_disposition_header
from ninja import Router

from specmate.access.permissions import Perm, authorize
from specmate.catalog.models import Representation
from specmate.design.models import Definition, Draft, Revision
from specmate.design.operations import authorize_design_content, authorize_snapshot
from specmate.operations import Context, NotFound
from specmate.pcb.models import PcbIntake, PcbInterpretation
from specmate.pcb.operations import IntakeRef, get_intake, intake_for
from specmate.pcb.population import closure, review_payload
from specmate.queries import get_draft, get_revision
from specmate.sources import blobstore

router = Router(tags=["pcb"])


@router.get("/projects/{project_id}/intakes")
def list_intakes(request, project_id: UUID):
    authorize(request.user, project_id, Perm.PROJECT_READ)
    return [
        {
            "intake_id": str(i.id),
            "board_path": i.board_path,
            "source_revision_id": str(i.source_revision_id),
        }
        for i in PcbIntake.objects.filter(source_revision__bundle__project_id=project_id).order_by(
            "created_at"
        )
    ]


@router.get("/intakes/{intake_id}")
def read_intake(request, intake_id: UUID):
    return get_intake(
        Context(user=request.user, via="api", request_id="read-pcb"), IntakeRef(intake_id=intake_id)
    )


@router.get("/intakes/{intake_id}/original")
def read_original(request, intake_id: UUID, path: str):
    intake = intake_for(
        Context(user=request.user, via="api", request_id="read-original"), intake_id
    )
    file = intake.source_revision.files.select_related("blob").filter(path=path).first()
    if file is None:
        raise NotFound("Preserved file not found.")
    response = FileResponse(
        blobstore.open_blob(file.blob.sha256), content_type="application/octet-stream"
    )
    response["Content-Disposition"] = content_disposition_header(True, file.path.rsplit("/", 1)[-1])
    response["X-Content-Type-Options"] = "nosniff"
    response["Digest"] = f"sha-256={file.blob.sha256}"
    return response


@router.get("/intakes/{intake_id}/populations")
def list_populations(request, intake_id: UUID):
    intake = intake_for(
        Context(user=request.user, via="api", request_id="list-pcb-populations"), intake_id
    )
    rows = []
    interpretation_ids = {
        str(i)
        for i in PcbInterpretation.objects.filter(attempt__intake=intake).values_list(
            "id", flat=True
        )
    }
    definitions = Definition.objects.filter(
        project_id=intake.source_revision.bundle.project_id, kind="pcb_population"
    ).prefetch_related("drafts", "revisions")
    for definition in definitions:
        for draft in definition.drafts.all():
            content = draft.content
            if content.get("pcb_population", {}).get("interpretation_id") not in interpretation_ids:
                continue
            authorize_design_content(request.user, definition, content)
            closure(request.user, definition, content)
            for revision in definition.revisions.all():
                authorize_snapshot(request.user, revision.snapshot)
            rows.append(
                {
                    "definition_id": str(definition.id),
                    "name": definition.name,
                    "draft_id": str(draft.id),
                    "state": draft.state_token,
                    "content": content,
                    "revisions": [
                        {"revision_id": str(r.id), "number": r.number}
                        for r in definition.revisions.all()
                    ],
                }
            )
    return rows


@router.get("/population-drafts/{draft_id}/review")
def read_population_draft(request, draft_id: UUID):
    get_draft(request.user, draft_id)
    draft = Draft.objects.select_related("definition").get(id=draft_id)
    if draft.definition.kind != "pcb_population":
        raise NotFound("PCB population draft not found.")
    return {
        "draft_id": str(draft.id),
        "definition_id": str(draft.definition_id),
        "name": draft.definition.name,
        "state": draft.state_token,
        **review_payload(request.user, draft.definition, draft.content),
    }


@router.get("/population-revisions/{revision_id}/review")
def read_population_revision(request, revision_id: UUID):
    revision = get_revision(request.user, revision_id)
    if revision.definition.kind != "pcb_population":
        raise NotFound("PCB population revision not found.")
    canonical = json.loads(bytes(revision.snapshot.canonical))
    return {
        "revision_id": str(revision.id),
        "definition_id": str(revision.definition_id),
        "name": revision.definition.name,
        "number": revision.number,
        "snapshot_id": str(revision.snapshot_id),
        "snapshot_sha256": revision.snapshot.sha256,
        "frozen_at": revision.frozen_at.isoformat(),
        **review_payload(request.user, revision.definition, canonical["content"]),
    }


@router.get("/projects/{project_id}/association-targets")
def association_targets(request, project_id: UUID):
    """Offer exact selectable revisions/representations from the authorized project."""
    authorize(request.user, project_id, Perm.PROJECT_READ)
    revision_rows = list(
        Revision.objects.select_related("definition", "snapshot")
        .filter(definition__project_id=project_id)
        .exclude(definition__kind="pcb_population")
        .order_by("definition__name", "number")[:2001]
    )
    revisions = []
    for revision in revision_rows[:2000]:
        authorize_snapshot(request.user, revision.snapshot)
        content = json.loads(bytes(revision.snapshot.canonical))["content"]
        contacts = []
        if revision.definition.kind == "pinout":
            body_id = content.get("interface", {}).get("body_revision_id")
            body = (
                Revision.objects.select_related("definition", "snapshot").filter(id=body_id).first()
            )
            if body is not None:
                authorize_snapshot(request.user, body.snapshot)
                body_content = json.loads(bytes(body.snapshot.canonical))["content"]
                contacts = [
                    row["contact_id"]
                    for row in body_content.get("interface", {}).get("contacts", [])
                    if row.get("physical_role") != "key"
                ]
        revisions.append(
            {
                "revision_id": str(revision.id),
                "kind": revision.definition.kind,
                "name": revision.definition.name,
                "number": revision.number,
                "contacts": contacts,
            }
        )
    model_rows = list(
        Representation.objects.select_related(
            "revision__definition", "source_file__revision__bundle", "source_file__blob"
        )
        .filter(revision__definition__project_id=project_id, kind="model")
        .order_by("label")[:2001]
    )
    models = []
    for representation in model_rows[:2000]:
        authorize_snapshot(request.user, representation.revision.snapshot)
        authorize(
            request.user, representation.source_file.revision.bundle.project_id, Perm.PROJECT_READ
        )
        models.append(
            {
                "representation_id": str(representation.id),
                "revision_id": str(representation.revision_id),
                "label": representation.label,
                "rights": representation.source_file.rights,
                "sha256": representation.source_file.blob.sha256,
            }
        )
    return {
        "revisions": revisions,
        "models": models,
        "truncated": {"revisions": len(revision_rows) > 2000, "models": len(model_rows) > 2000},
    }


@router.get("/projects/{project_id}/property-authorities")
def list_property_authorities(request, project_id: UUID):
    from specmate.catalog_matching.queries import current_actor
    from specmate.pcb.authority import list_authorities

    return {"authorities": list_authorities(current_actor(request.user), project_id)}


@router.get("/property-authorities/{authority_id}")
def read_property_authority(request, authority_id: UUID):
    from specmate.catalog_matching.queries import current_actor
    from specmate.pcb.authority import authority_for, read_authority

    user = current_actor(request.user)
    context = Context(user=user, via="api", request_id="read-property-authority")
    return read_authority(user, authority_for(context, authority_id))
