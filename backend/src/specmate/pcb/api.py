import json
from uuid import UUID

from django.http import FileResponse
from django.utils.http import content_disposition_header
from ninja import Router

from specmate.access.models import ProjectReference
from specmate.access.permissions import Perm, authorize, context_project
from specmate.catalog.models import Representation
from specmate.design.models import Definition, Draft, Revision
from specmate.design.operations import authorize_design_content, authorize_snapshot
from specmate.operations import Context, NotFound
from specmate.pcb.models import PcbFormatUpgrade, PcbIntake, PcbInterpretation
from specmate.pcb.operations import IntakeRef, get_intake, intake_for
from specmate.pcb.population import closure, review_payload
from specmate.queries import get_draft, get_revision
from specmate.sources import blobstore

router = Router(tags=["pcb"])


@router.get("/workspaces/{workspace_id}/intakes")
def list_intakes(request, workspace_id: UUID, project_id: UUID | None = None):
    """Workspace intakes with navigation hints; nothing is hidden or filtered.

    `referenced_by_project` is true when the optional context project actively references
    the intake's source bundle (always false without a context). `superseded_by_intake_id`
    names the accepted upgraded derivative of an original intake, if any.
    """
    workspace = authorize(request.user, workspace_id, Perm.WORKSPACE_READ)
    project = context_project(project_id, workspace)
    upgraded = dict(
        PcbFormatUpgrade.objects.filter(revision__bundle__workspace=workspace).values_list(
            "revision_id", "from_kicad_major"
        )
    )
    superseded = dict(
        PcbFormatUpgrade.objects.filter(revision__bundle__workspace=workspace).values_list(
            "attempt__intake_id", "intake_id"
        )
    )
    referenced = (
        set(
            ProjectReference.objects.filter(
                project=project, kind=ProjectReference.Kind.SOURCE_BUNDLE, removed_at__isnull=True
            ).values_list("source_bundle_id", flat=True)
        )
        if project
        else set()
    )
    return [
        {
            "intake_id": str(i.id),
            "board_path": i.board_path,
            "source_revision_id": str(i.source_revision_id),
            "upgraded_from_kicad": upgraded.get(i.source_revision_id),
            "referenced_by_project": i.source_revision.bundle_id in referenced,
            "superseded_by_intake_id": str(superseded[i.id]) if i.id in superseded else None,
        }
        for i in PcbIntake.objects.filter(source_revision__bundle__workspace=workspace)
        .select_related("source_revision")
        .order_by("created_at")
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
        workspace_id=intake.source_revision.bundle.workspace_id, kind="pcb_population"
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


@router.get("/workspaces/{workspace_id}/association-targets")
def association_targets(request, workspace_id: UUID):
    """Offer exact selectable revisions/representations from the authorized workspace."""
    workspace = authorize(request.user, workspace_id, Perm.WORKSPACE_READ)
    revision_rows = list(
        Revision.objects.select_related("definition", "snapshot")
        .filter(definition__workspace=workspace)
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
        .filter(revision__definition__workspace=workspace, kind="model")
        .order_by("label")[:2001]
    )
    models = []
    for representation in model_rows[:2000]:
        authorize_snapshot(request.user, representation.revision.snapshot)
        authorize(
            request.user,
            representation.source_file.revision.bundle.workspace_id,
            Perm.WORKSPACE_READ,
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


@router.get("/workspaces/{workspace_id}/property-authorities")
def list_property_authorities(request, workspace_id: UUID):
    from specmate.catalog_matching.queries import current_actor
    from specmate.pcb.authority import list_authorities

    return {"authorities": list_authorities(current_actor(request.user), workspace_id)}


@router.get("/property-authorities/{authority_id}")
def read_property_authority(request, authority_id: UUID):
    from specmate.catalog_matching.queries import current_actor
    from specmate.pcb.authority import authority_for, read_authority

    user = current_actor(request.user)
    context = Context(user=user, via="api", request_id="read-property-authority")
    return read_authority(user, authority_for(context, authority_id))


@router.get("/workspaces/{workspace_id}/firmware")
def list_project_firmware(request, workspace_id: UUID):
    from specmate.catalog_matching.queries import current_actor
    from specmate.pcb.firmware import list_firmware

    return {"firmware": list_firmware(current_actor(request.user), workspace_id)}


@router.get("/firmware-drafts/{draft_id}")
def read_firmware_draft(request, draft_id: UUID):
    from specmate.catalog_matching.queries import current_actor
    from specmate.pcb.firmware import ReadFirmware, read_firmware

    user = current_actor(request.user)
    context = Context(user=user, via="api", request_id="read-firmware")
    return read_firmware(context, ReadFirmware(draft_id=draft_id))


@router.get("/firmware-revisions/{revision_id}")
def read_firmware_revision(request, revision_id: UUID):
    from specmate.catalog_matching.queries import current_actor
    from specmate.pcb.firmware import read_revision

    return read_revision(current_actor(request.user), revision_id)


@router.get("/assemblies/{snapshot_id}/firmware-review")
def read_firmware_assignment_review(request, snapshot_id: UUID):
    from specmate.catalog_matching.queries import current_actor
    from specmate.pcb.firmware import assignment_review

    return assignment_review(current_actor(request.user), snapshot_id)


@router.get("/workspaces/{workspace_id}/firmware-targets")
def list_firmware_targets(request, workspace_id: UUID):
    from specmate.catalog_matching.queries import current_actor
    from specmate.pcb.firmware import list_targets

    return {"targets": list_targets(current_actor(request.user), workspace_id)}
