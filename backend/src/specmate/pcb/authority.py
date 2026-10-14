"""Explicit native ownership of board properties and reconciled extracted projections.

A governed property has exactly one designated owner: an exact preserved native file
in one source bundle of a lineage. Specmate keeps no editable copy. An edit goes through
the owning source (native editing handoff), is extracted by the pinned adapter, and is
deliberately reconciled into an immutable projection with exact provenance. Unsupported
coverage stays explicitly unknown; disagreeing evidence is preserved and never chosen.
"""

from __future__ import annotations

import hashlib
import json
from typing import Literal
from uuid import UUID

from django.db import IntegrityError, transaction
from pydantic import BaseModel, ConfigDict, Field, field_validator

from specmate.access.permissions import Perm, authorize
from specmate.catalog_matching.queries import current_actor
from specmate.contracts import check_package_path
from specmate.design.operations import canonical_bytes
from specmate.operations import (
    Conflict,
    Context,
    NotFound,
    Unsupported,
    ValidationFailed,
    operation,
)
from specmate.pcb.models import (
    PcbInterpretation,
    PropertyAuthority,
    PropertyOwnerChange,
    PropertyProjection,
)
from specmate.sources.authority import authorize_revision
from specmate.sources.models import SourceBundle, SourceBundleRevision

PROPERTY = PropertyAuthority.Property.BOARD_OUTLINE
EXTRACTOR = "kicad-intake-v1"
MAX_LINEAGE = 1000
MAX_EVIDENCE = 50
NO_EDITABLE_COPY = (
    "Specmate holds no editable copy of this property. Edit the owning native source and "
    "reconcile its accepted extraction."
)


# ---------------------------------------------------------------- lineage


def lineage_root(bundle: SourceBundle) -> SourceBundle:
    seen = set()
    while bundle.derived_from_id is not None:
        if bundle.id in seen or len(seen) >= MAX_LINEAGE:
            raise ValidationFailed("Source lineage exceeds the supported depth.")
        seen.add(bundle.id)
        bundle = SourceBundle.objects.get(revisions__id=bundle.derived_from_id)
    return bundle


def lineage_bundles(root: SourceBundle) -> list[SourceBundle]:
    found = [root]
    frontier = [root.id]
    while frontier and len(found) < MAX_LINEAGE:
        children = list(SourceBundle.objects.filter(derived_from__bundle_id__in=frontier))
        found.extend(children)
        frontier = [child.id for child in children]
    return found


def descends(revision: SourceBundleRevision, ancestor_id) -> bool:
    """Follow exact manifest ancestry; derivation, revision and edit parents are all listed."""
    pending, seen = [revision], set()
    while pending:
        current = pending.pop()
        if current.id == ancestor_id:
            return True
        if current.id in seen:
            continue
        seen.add(current.id)
        if len(seen) > MAX_LINEAGE:
            raise ValidationFailed("Source ancestry exceeds the supported depth.")
        parents = json.loads(bytes(current.manifest)).get("ancestry", [])
        pending.extend(SourceBundleRevision.objects.filter(id__in=parents))
    return False


def head_of(bundle_id) -> SourceBundleRevision:
    return (
        SourceBundleRevision.objects.select_related("bundle")
        .filter(bundle_id=bundle_id)
        .order_by("-number")
        .first()
    )


# ---------------------------------------------------------------- projections


def projected_value(report: dict) -> tuple[str, dict]:
    if report["coverage"]["outline"] == "closed-line-polygons":
        return "known", {"outline": report["outline"], "cutouts": report["cutouts"]}
    unsupported = [u for u in report["unsupported"] if "outline" in u.lower()]
    return "unknown", {
        "outline": None,
        "cutouts": None,
        "reason": unsupported or ["The extractor reported outline coverage as unsupported."],
    }


def _area(polygon) -> float:
    return (
        abs(
            sum(
                x1 * y2 - x2 * y1
                for (x1, y1), (x2, y2) in zip(polygon, polygon[1:] + polygon[:1], strict=True)
            )
        )
        / 2
    )


def summary(status: str, value: dict) -> dict:
    if status != "known":
        return {"status": "unknown", "reason": value["reason"]}
    points = [p for polygon in value["outline"] for p in polygon]
    return {
        "status": "known",
        "outline_polygons": len(value["outline"]),
        "cutouts": len(value["cutouts"]),
        "vertices": len(points),
        "bbox_mm": [
            min(x for x, _ in points),
            min(y for _, y in points),
            max(x for x, _ in points),
            max(y for _, y in points),
        ],
        "net_area_mm2": round(
            sum(_area(p) for p in value["outline"]) - sum(_area(p) for p in value["cutouts"]), 6
        ),
    }


def _report(interpretation: PcbInterpretation) -> dict:
    raw = bytes(interpretation.canonical)
    if hashlib.sha256(raw).hexdigest() != interpretation.sha256:
        raise ValidationFailed("Accepted interpretation no longer matches its hash.")
    return json.loads(raw)


def candidate(interpretation: PcbInterpretation) -> dict:
    report = _report(interpretation)
    status, value = projected_value(report)
    return {
        "interpretation_id": str(interpretation.id),
        "report_sha256": interpretation.sha256,
        "build_id": str(interpretation.attempt.build_id),
        "source_revision_id": str(interpretation.attempt.intake.source_revision_id),
        "source_path": interpretation.attempt.intake.board_path,
        "source_sha256": report["source_sha256"],
        "adapter": report["adapter"],
        "tool_version": report["tool_version"],
        "status": status,
        "value_sha256": hashlib.sha256(canonical_bytes(value)).hexdigest(),
        "summary": summary(status, value),
        "accepted_at": interpretation.created_at.isoformat(),
    }


def accepted_for(revision_id, path):
    return list(
        PcbInterpretation.objects.select_related("attempt__intake")
        .filter(attempt__intake__source_revision_id=revision_id, attempt__intake__board_path=path)
        .order_by("created_at")
    )


def projection_result(projection: PropertyProjection) -> dict:
    interpretation = projection.interpretation
    report = _report(interpretation)
    value = json.loads(bytes(projection.value))
    return {
        "projection_id": str(projection.id),
        "version": projection.version,
        "interpretation_id": str(interpretation.id),
        "attempt_id": str(interpretation.attempt_id),
        "build_id": str(interpretation.attempt.build_id),
        "output_id": str(interpretation.output_id),
        "adapter": report["adapter"],
        "tool_version": report["tool_version"],
        "native_format_version": report["native_format_version"],
        "source_revision_id": str(projection.source_revision_id),
        "source_number": projection.source_revision.number,
        "source_path": projection.source_path,
        "source_sha256": projection.source_sha256,
        "report_sha256": projection.report_sha256,
        "status": projection.status,
        "value": value,
        "value_sha256": projection.value_sha256,
        "summary": summary(projection.status, value),
        "previous_projection_id": str(projection.previous_id) if projection.previous_id else None,
        "changes": projection.changes,
        "basis": projection.basis,
        "reconciled_by": projection.reconciled_by.get_username(),
        "created_at": projection.created_at.isoformat(),
    }


def changes(previous: PropertyProjection | None, status: str, value: dict) -> dict:
    after = summary(status, value)
    if previous is None:
        return {"kind": "initial", "before": None, "after": after}
    old_value = json.loads(bytes(previous.value))
    before = summary(previous.status, old_value)
    if previous.status == "known" and status == "known":
        old = {tuple(p) for polygon in old_value["outline"] for p in polygon}
        new = {tuple(p) for polygon in value["outline"] for p in polygon}
        vertices = {"added": len(new - old), "removed": len(old - new)}
    else:
        vertices = None
    return {
        "kind": "unchanged" if old_value == value and previous.status == status else "changed",
        "before": before,
        "after": after,
        "vertices": vertices,
    }


# ---------------------------------------------------------------- authority


def authority_state(authority: PropertyAuthority) -> str:
    return f"authority-v{authority.version}"


def authorize_authority(user, authority: PropertyAuthority, permission=Perm.WORKSPACE_READ):
    """Fresh workspace authority; the owner lineage, projected sources and owner changes all
    live in the authority's workspace (database guards), so one check covers them."""
    return authorize(current_actor(user), authority.workspace_id, permission)


def authority_for(ctx, authority_id, permission=Perm.WORKSPACE_READ, lock=False):
    rows = PropertyAuthority.objects.select_related("owner_bundle")
    authority = rows.filter(id=authority_id).first()
    if authority is None:
        raise NotFound("Property authority not found.")
    authorize_authority(ctx.user, authority, permission)
    if lock:
        authority = rows.select_for_update(of=("self",)).get(id=authority_id)
        authorize_authority(ctx.user, authority, permission)
    return authority


def current_projection(authority) -> PropertyProjection | None:
    return (
        authority.projections.select_related(
            "interpretation__attempt__intake", "source_revision", "reconciled_by"
        )
        .order_by("-version")
        .first()
    )


def _non_owner_evidence(user, authority, projection) -> dict:
    root = SourceBundle.objects.get(id=authority.lineage_root_id)
    bundles = [b.id for b in lineage_bundles(root) if b.id != authority.owner_bundle_id]
    rows = list(
        PcbInterpretation.objects.select_related("attempt__intake__source_revision__bundle")
        .filter(
            attempt__intake__source_revision__bundle_id__in=bundles,
            attempt__intake__board_path=authority.owner_path,
        )
        .order_by("created_at")[: MAX_EVIDENCE + 1]
    )
    # The overflow row contributes to the disclosed truncation flag too.
    for interpretation in rows:
        authorize_revision(user, interpretation.attempt.intake.source_revision)
    items = []
    for interpretation in rows[:MAX_EVIDENCE]:
        item = candidate(interpretation)
        item["bundle_id"] = str(interpretation.attempt.intake.source_revision.bundle_id)
        item["bundle_name"] = interpretation.attempt.intake.source_revision.bundle.name
        item["differs_from_projection"] = (
            None if projection is None else item["value_sha256"] != projection.value_sha256
        )
        items.append(item)
    return {"items": items, "truncated": len(rows) > MAX_EVIDENCE}


def read_authority(user, authority: PropertyAuthority) -> dict:
    user = current_actor(user)
    authority = PropertyAuthority.objects.select_related("owner_bundle").get(id=authority.id)
    authorize_authority(user, authority)
    head = head_of(authority.owner_bundle_id)
    file = head.files.select_related("blob").filter(path=authority.owner_path).first()
    projection = current_projection(authority)
    candidates = [candidate(i) for i in accepted_for(head.id, authority.owner_path)]
    agree = len({c["value_sha256"] for c in candidates}) <= 1 if candidates else None
    if candidates and not agree:
        status = "conflicting"
    elif projection is None:
        status = "unreconciled"
    elif projection.source_revision_id == head.id:
        status = "current"
    else:
        status = "stale"
    return {
        "authority_id": str(authority.id),
        "workspace_id": str(authority.workspace_id),
        "property": authority.property,
        "extractor": authority.extractor,
        "state": authority_state(authority),
        "version": authority.version,
        "basis": authority.basis,
        "lineage_root_bundle_id": str(authority.lineage_root_id),
        "owner": {
            "bundle_id": str(authority.owner_bundle_id),
            "name": authority.owner_bundle.name,
            "role": authority.owner_bundle.role,
            "path": authority.owner_path,
            "head_revision_id": str(head.id),
            "head_number": head.number,
            "head_manifest_sha256": head.manifest_sha256,
            "head_file_sha256": file.blob.sha256 if file else None,
            "head_file_rights": file.rights if file else None,
            "head_file_present": file is not None,
            "editable": authority.owner_bundle.role == SourceBundle.Role.DERIVATIVE,
            "handoff_url": f"/api/v0/sources/revisions/{head.id}/handoff",
        },
        "status": status,
        "projection": projection_result(projection) if projection else None,
        "head_candidates": candidates,
        "head_candidates_agree": agree,
        "non_owner_evidence": _non_owner_evidence(user, authority, projection),
        "history": [
            projection_result(p)
            for p in authority.projections.select_related(
                "interpretation__attempt__intake", "source_revision", "reconciled_by"
            ).order_by("-version")
        ],
        "owner_changes": [
            {
                "version": change.version,
                "owner_revision_id": str(change.owner_revision_id),
                "owner_bundle_id": str(change.owner_revision.bundle_id),
                "owner_path": change.owner_path,
                "basis": change.basis,
                "changed_by": change.changed_by.get_username(),
                "created_at": change.created_at.isoformat(),
            }
            for change in authority.owner_changes.select_related(
                "owner_revision", "changed_by"
            ).order_by("version")
        ],
        "editable_copy": NO_EDITABLE_COPY,
        "physical_qualification": False,
    }


# ---------------------------------------------------------------- payloads


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Declare(Payload):
    owner_revision_id: UUID
    path: str = Field(max_length=512)
    property: Literal["pcb.board_outline"]
    basis: str = Field(min_length=1, max_length=2000)

    @field_validator("path")
    @classmethod
    def portable_path(cls, value):
        return check_package_path(value)


class AuthorityRef(Payload):
    authority_id: UUID


class Reconcile(AuthorityRef):
    interpretation_id: UUID
    basis: str = Field(min_length=1, max_length=2000)


class Transfer(AuthorityRef):
    new_owner_revision_id: UUID
    basis: str = Field(min_length=1, max_length=2000)


# ---------------------------------------------------------------- scope and replay


def _owner_revision(ctx, revision_id, permission=Perm.SOURCE_REGISTER):
    revision = SourceBundleRevision.objects.select_related("bundle").filter(id=revision_id).first()
    if revision is None:
        raise NotFound("Source revision not found.")
    authorize_revision(ctx.user, revision, permission)
    return revision


def _closure(ctx, p) -> str:
    if isinstance(p, Declare):
        return f"workspace:{_owner_revision(ctx, p.owner_revision_id).bundle.workspace_id}"
    authority = authority_for(ctx, p.authority_id, Perm.SOURCE_REGISTER)
    if isinstance(p, Reconcile):
        _interpretation(ctx, p.interpretation_id, authority)
    if isinstance(p, Transfer):
        _owner_revision(ctx, p.new_owner_revision_id)
    return f"workspace:{authority.workspace_id}"


def _replay(ctx, p, stored) -> None:
    _closure(ctx, p)
    authority = authority_for(ctx, stored["authority_id"], Perm.SOURCE_REGISTER)
    if isinstance(p, AuthorityRef) and str(p.authority_id) != stored["authority_id"]:
        raise NotFound("Property authority not found.")
    if (
        isinstance(p, Reconcile)
        and not authority.projections.filter(id=stored["projection_id"]).exists()
    ):
        raise NotFound("Property projection not found.")
    if (
        isinstance(p, (Declare, Transfer))
        and not authority.owner_changes.filter(version=stored["owner_version"]).exists()
    ):
        raise NotFound("Property owner change not found.")


def _scope(name):
    def resolve(ctx, p):
        from specmate.operations.models import IdempotencyRecord

        scope = _closure(ctx, p)
        # Current authority over a retained outcome precedes any keyed mismatch.
        prior = IdempotencyRecord.objects.select_for_update().filter(
            actor=ctx.user, operation=name, key=ctx.idempotency_key
        )
        retained = prior.filter(scope=scope).first()
        if retained is not None:
            _replay(ctx, p, retained.result)
        return scope

    return resolve


def _interpretation(ctx, interpretation_id, authority) -> PcbInterpretation:
    interpretation = (
        PcbInterpretation.objects.select_related("attempt__intake__source_revision__bundle")
        .filter(id=interpretation_id)
        .first()
    )
    if interpretation is None:
        raise NotFound("PCB interpretation not found.")
    source = interpretation.attempt.intake.source_revision
    authorize_revision(ctx.user, source, Perm.SOURCE_REGISTER)
    if source.bundle.workspace_id != authority.workspace_id:
        raise NotFound("PCB interpretation not found.")
    return interpretation


# ---------------------------------------------------------------- operations


@operation(
    "source_property.declare",
    Declare,
    summary="Designate one native source file as the only owner of a board property.",
    idempotency_scope=_scope("source_property.declare"),
    authorize_replay=_replay,
    access=Perm.SOURCE_REGISTER,
)
def declare(ctx: Context, p: Declare) -> dict:
    revision = _owner_revision(ctx, p.owner_revision_id)
    bundle = SourceBundle.objects.select_for_update().get(id=revision.bundle_id)
    head = head_of(bundle.id)
    authorize_revision(ctx.user, head, Perm.SOURCE_REGISTER)
    if head.id != revision.id:
        raise Conflict(
            "Declare ownership on the bundle's current revision.",
            details={"head_revision_id": str(head.id), "head_number": head.number},
        )
    if not p.path.lower().endswith(".kicad_pcb"):
        raise Unsupported("Board outline ownership is supported only for .kicad_pcb sources.")
    if not revision.files.filter(path=p.path).exists():
        raise ValidationFailed("The owning file is not in the selected revision.")
    root = lineage_root(bundle)
    existing = PropertyAuthority.objects.filter(
        lineage_root=root, owner_path=p.path, property=p.property
    ).first()
    if existing is not None:
        authorize_authority(ctx.user, existing, Perm.SOURCE_REGISTER)
        raise Conflict(
            "This property already has a designated owner in this source lineage. "
            "Transfer it deliberately instead of creating a competing owner.",
            details={"authority_id": str(existing.id), "state": authority_state(existing)},
        )
    try:
        with transaction.atomic():
            authority = PropertyAuthority.objects.create(
                workspace_id=bundle.workspace_id,
                property=p.property,
                lineage_root=root,
                owner_bundle=bundle,
                owner_path=p.path,
                extractor=EXTRACTOR,
                basis=p.basis,
                declared_by=ctx.user,
            )
    except IntegrityError:
        raise Conflict("A concurrent declaration designated this owner first.") from None
    PropertyOwnerChange.objects.create(
        authority=authority,
        version=1,
        owner_revision=revision,
        owner_path=p.path,
        basis=p.basis,
        changed_by=ctx.user,
    )
    return {
        "authority_id": str(authority.id),
        "state": authority_state(authority),
        "owner_version": 1,
        "owner_revision_id": str(revision.id),
    }


def _locked(ctx, p, permission=Perm.SOURCE_REGISTER):
    authority = authority_for(ctx, p.authority_id, permission, lock=True)
    # Match source writers' bundle lock and keep all disclosed heads stable through CAS.
    bundle_ids = {authority.owner_bundle_id}
    if isinstance(p, Transfer):
        bundle_ids.add(_owner_revision(ctx, p.new_owner_revision_id).bundle_id)
    list(SourceBundle.objects.select_for_update().filter(id__in=bundle_ids).order_by("id"))
    authorize_authority(ctx.user, authority, permission)
    if isinstance(p, Transfer):
        for bundle_id in bundle_ids:
            authorize_revision(ctx.user, head_of(bundle_id), permission)
    if ctx.expected_state != authority_state(authority):
        raise Conflict(
            "The property authority changed since it was reviewed.",
            details={"state": authority_state(authority)},
        )
    return authority


@operation(
    "source_property.reconcile",
    Reconcile,
    summary="Reconcile an owned property to the accepted extraction of its owner's current "
    "source; never edits or merges geometry.",
    requires_expected_state=True,
    idempotency_scope=_scope("source_property.reconcile"),
    authorize_replay=_replay,
    access=Perm.SOURCE_REGISTER,
)
def reconcile(ctx: Context, p: Reconcile) -> dict:
    authority = _locked(ctx, p)
    interpretation = _interpretation(ctx, p.interpretation_id, authority)
    # Serialize with source writers so the reconciled head cannot move underneath.
    SourceBundle.objects.select_for_update().get(id=authority.owner_bundle_id)
    head = head_of(authority.owner_bundle_id)
    authorize_revision(ctx.user, head, Perm.SOURCE_REGISTER)
    intake = interpretation.attempt.intake
    if (
        intake.source_revision.bundle_id != authority.owner_bundle_id
        or intake.board_path != authority.owner_path
    ):
        raise ValidationFailed(
            "Only an extraction of the designated owning source can reconcile this property. "
            "Other evidence stays preserved and non-authoritative."
        )
    if intake.source_revision_id != head.id:
        raise Conflict(
            "The owning source has a newer revision. Extract and reconcile its current head.",
            details={"head_revision_id": str(head.id), "head_number": head.number},
        )
    report = _report(interpretation)
    if report["adapter"] != authority.extractor:
        raise ValidationFailed("The extraction adapter is not the declared extractor.")
    file = head.files.select_related("blob").get(path=authority.owner_path)
    if report["source_sha256"] != file.blob.sha256:
        raise ValidationFailed("The extraction refers to different owner bytes.")
    others = [candidate(i) for i in accepted_for(head.id, authority.owner_path)]
    if len({c["value_sha256"] for c in others}) > 1:
        raise Conflict(
            "Accepted extractions of the owner's current source disagree. Nothing was chosen; "
            "resolve the extraction evidence first.",
            details={"candidates": others},
        )
    previous = current_projection(authority)
    if previous is not None and previous.source_revision_id == head.id:
        raise ValidationFailed("The projection already reflects the owner's current source.")
    status, value = projected_value(report)
    encoded = canonical_bytes(value)
    authority.version += 1
    authority.save(update_fields=["version"])
    projection = PropertyProjection.objects.create(
        authority=authority,
        version=authority.version,
        interpretation=interpretation,
        source_revision=head,
        source_path=authority.owner_path,
        source_sha256=file.blob.sha256,
        report_sha256=interpretation.sha256,
        status=status,
        value=encoded,
        value_sha256=hashlib.sha256(encoded).hexdigest(),
        previous=previous,
        changes=changes(previous, status, value),
        basis=p.basis,
        reconciled_by=ctx.user,
    )
    return {
        "authority_id": str(authority.id),
        "state": authority_state(authority),
        "projection_id": str(projection.id),
        "status": status,
        "value_sha256": projection.value_sha256,
        "changes": projection.changes,
    }


@operation(
    "source_property.transfer",
    Transfer,
    summary="Move ownership to a source that already contains the current owner's latest "
    "revision; never creates a competing owner.",
    requires_expected_state=True,
    idempotency_scope=_scope("source_property.transfer"),
    authorize_replay=_replay,
    access=Perm.SOURCE_REGISTER,
)
def transfer(ctx: Context, p: Transfer) -> dict:
    authority = _locked(ctx, p)
    revision = _owner_revision(ctx, p.new_owner_revision_id)
    bundles = SourceBundle.objects.select_for_update().filter(
        id__in=[authority.owner_bundle_id, revision.bundle_id]
    )
    list(bundles.order_by("id"))
    if revision.bundle_id == authority.owner_bundle_id:
        raise ValidationFailed("The selected revision is already in the owning bundle.")
    if revision.bundle.workspace_id != authority.workspace_id:
        raise NotFound("Source revision not found.")
    head = head_of(revision.bundle_id)
    authorize_revision(ctx.user, head, Perm.SOURCE_REGISTER)
    if head.id != revision.id:
        raise Conflict(
            "Transfer ownership to the new bundle's current revision.",
            details={"head_revision_id": str(head.id), "head_number": head.number},
        )
    if lineage_root(revision.bundle).id != authority.lineage_root_id:
        raise ValidationFailed("The new owner is outside this property's source lineage.")
    if not revision.files.filter(path=authority.owner_path).exists():
        raise ValidationFailed("The new owner does not contain the owning file path.")
    owner_head = head_of(authority.owner_bundle_id)
    authorize_revision(ctx.user, owner_head, Perm.SOURCE_REGISTER)
    if not descends(revision, owner_head.id):
        raise Conflict(
            "The new owner does not contain the current owner's latest revision, so it "
            "would compete with it. Edit from the current owner instead.",
            details={"owner_head_revision_id": str(owner_head.id)},
        )
    authority.owner_bundle_id = revision.bundle_id
    authority.version += 1
    authority.save(update_fields=["owner_bundle", "version"])
    PropertyOwnerChange.objects.create(
        authority=authority,
        version=authority.version,
        owner_revision=revision,
        owner_path=authority.owner_path,
        basis=p.basis,
        changed_by=ctx.user,
    )
    return {
        "authority_id": str(authority.id),
        "state": authority_state(authority),
        "owner_version": authority.version,
        "owner_revision_id": str(revision.id),
    }


@operation(
    "source_property.read",
    AuthorityRef,
    summary="Read an owned property's designated source, reconciled projection, candidates, "
    "preserved non-owner evidence and history.",
    supports_idempotency=False,
    access=Perm.WORKSPACE_READ,
)
def read(ctx: Context, p: AuthorityRef) -> dict:
    return read_authority(ctx.user, authority_for(ctx, p.authority_id))


def list_authorities(user, workspace_id) -> list[dict]:
    user = current_actor(user)
    workspace = authorize(user, workspace_id, Perm.WORKSPACE_READ)
    result = []
    rows = PropertyAuthority.objects.select_related("owner_bundle").filter(workspace=workspace)
    for authority in rows.order_by("created_at")[:200]:
        authorize_authority(user, authority)
        head = head_of(authority.owner_bundle_id)
        projection = current_projection(authority)
        result.append(
            {
                "authority_id": str(authority.id),
                "property": authority.property,
                "owner_bundle_name": authority.owner_bundle.name,
                "owner_path": authority.owner_path,
                "state": authority_state(authority),
                "head_revision_id": str(head.id),
                "projection_current": projection is not None
                and projection.source_revision_id == head.id,
                "projection_status": projection.status if projection else None,
            }
        )
    return result
