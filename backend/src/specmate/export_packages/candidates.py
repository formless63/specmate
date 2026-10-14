"""Read-only choices for one root: retained outputs that could cite its exact closure.

Each candidate is reread through its own shared authority; anything the actor cannot
currently read, or whose stored evidence no longer validates, is silently not offered.
Listing a candidate is not a coherence decision; the package review still decides.
"""

import json
from types import SimpleNamespace

from specmate.catalog_matching.queries import current_actor
from specmate.design.models import Revision
from specmate.export_packages.queries import Scope, population_sources
from specmate.firmware_builds.contracts import CompileRef, FirmwareRef
from specmate.firmware_builds.operations import options as firmware_options
from specmate.firmware_builds.operations import scoped_build as firmware_scoped_build
from specmate.firmware_builds.operations import validate_outputs as validate_firmware
from specmate.operations import OperationError
from specmate.pcb_fabrication.operations import options as fabrication_options
from specmate.pcb_fabrication.operations import scoped_build, validate_outputs
from specmate.preparation_documents.models import DocumentSet
from specmate.preparation_documents.operations import authorized_set
from specmate.queries import get_revision
from specmate.shared_scene.drawing_operations import drawing_record
from specmate.shared_scene.models import SceneDrawing

LIMIT = 100


def readable(read, *args):
    try:
        return read(*args)
    except OperationError:
        return None


def candidates(ctx, p):
    scope = Scope(
        current_actor(ctx.user), SimpleNamespace(root_revision_id=p.root_revision_id, quantity=None)
    )
    user = scope.user
    revisions = set(scope.revisions)
    snapshots = {r.snapshot_id: r for r in scope.revisions.values()}
    drawings = []
    for row in SceneDrawing.objects.filter(snapshot_id__in=snapshots).order_by("-created_at", "id")[
        :LIMIT
    ]:
        if readable(drawing_record, user, row.id):
            revision = snapshots[row.snapshot_id]
            drawings.append(
                {
                    "drawing_id": str(row.id),
                    "revision_id": str(revision.id),
                    "name": revision.definition.name,
                    "renderer_version": row.renderer_version,
                    "created_at": row.created_at.isoformat(),
                }
            )
    document_sets = []
    for row in DocumentSet.objects.filter(root_revision_id__in=revisions).order_by(
        "-created_at", "id"
    )[:LIMIT]:
        if readable(authorized_set, user, row.id):
            document_sets.append(
                {
                    "document_set_id": str(row.id),
                    "root_revision_id": str(row.root_revision_id),
                    "name": row.root_revision.definition.name,
                    "quantity": row.configuration.get("quantity"),
                    "created_at": row.created_at.isoformat(),
                }
            )
    test_plans = []
    workspace = scope.root.definition.workspace_id
    for revision in (
        Revision.objects.select_related("definition", "snapshot")
        .filter(definition__workspace_id=workspace, definition__kind="cable_test_plan")
        .order_by("-frozen_at", "id")[: LIMIT * 4]
    ):
        plan = json.loads(bytes(revision.snapshot.canonical))["content"].get("test_plan", {})
        if str(plan.get("root_revision_id")) not in {str(r) for r in revisions}:
            continue
        if readable(get_revision, user, revision.id) and len(test_plans) < LIMIT:
            test_plans.append(
                {
                    "revision_id": str(revision.id),
                    "name": revision.definition.name,
                    "number": revision.number,
                    "root_revision_id": plan.get("root_revision_id"),
                    "occurrence_path": plan.get("occurrence_path", []),
                }
            )
    builds = []
    for intake_id in sorted({r["intake_id"] for r in population_sources(scope) if r["intake_id"]}):
        listed = readable(fabrication_options, ctx, intake_id)
        for row in (listed or {}).get("builds", []):
            if row["state"] != "succeeded":
                continue

            # Offer only builds whose registered output evidence currently validates.
            def check(intake_id=intake_id, build_id=row["build_id"]):
                _, file, build = scoped_build(ctx, intake_id, build_id)
                validate_outputs(file, build)
                return True

            if readable(check):
                builds.append({"intake_id": intake_id, "build_id": row["build_id"]})
    firmware = []
    refs = {(r.id, None, ()) for r in scope.of_kind("firmware")}
    if scope.closure:
        for path, node in scope.closure.nodes.items():
            assignment = scope.closure.assignments.get(path) or node.occurrence.assignments
            if assignment.firmware_revision_id is not None:
                refs.add((assignment.firmware_revision_id, scope.root.snapshot_id, path))
    for revision_id, snapshot_id, path in sorted(refs, key=lambda r: (str(r[0]), r[2])):
        ref = FirmwareRef(
            firmware_revision_id=revision_id,
            assembly_snapshot_id=snapshot_id,
            path=list(path),
        )
        listed = readable(firmware_options, ctx, ref)
        for row in (listed or {}).get("builds", []):
            if row["state"] != "succeeded" or len(firmware) >= LIMIT:
                continue

            # Offer only builds whose registered outputs currently validate.
            def check_firmware(ref=ref, build_id=row["build_id"]):
                _, spec, build = firmware_scoped_build(
                    ctx, CompileRef(**ref.model_dump(), build_id=build_id)
                )
                validate_firmware(spec, build)
                return True

            if readable(check_firmware):
                firmware.append(
                    {
                        "firmware_revision_id": str(revision_id),
                        "assembly_snapshot_id": str(snapshot_id) if snapshot_id else None,
                        "path": list(path),
                        "build_id": row["build_id"],
                    }
                )
    return {
        "root_revision_id": str(scope.root.id),
        "scene_drawings": drawings,
        "preparation_document_sets": document_sets,
        "test_plans": test_plans,
        "pcb_fabrication_builds": builds,
        "firmware_builds": firmware,
        "limit": LIMIT,
        "listing": "latest_candidates_no_hidden_total",
    }
