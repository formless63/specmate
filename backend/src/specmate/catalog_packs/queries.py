"""Pack history is retained evidence, never a permanent permission grant."""

import json

from django.contrib.auth import get_user_model

from specmate.access.permissions import Perm, authorize
from specmate.catalog_packs.contracts import (
    SUPPORTED_CONTRACT_VERSIONS,
    PackManifest,
    PackResult,
    VersionResult,
)
from specmate.catalog_packs.models import CatalogPack, PackVersion
from specmate.operations import NotFound, PermissionDenied, Unauthenticated, ValidationFailed
from specmate.queries import get_bundle_revision, get_draft, get_revision


def current_actor(user):
    if user is None or not user.is_authenticated:
        raise Unauthenticated("Authentication required.")
    actor = get_user_model().objects.filter(pk=user.pk, is_active=True).first()
    if actor is None:
        raise Unauthenticated("Actor is not active.")
    return actor


def authorize_file(user, file):
    if file is not None:
        get_bundle_revision(user, file.revision_id)
        authorize(user, file.blob.workspace_id, Perm.WORKSPACE_READ)


def supported(manifest):
    return manifest.contract_version in SUPPORTED_CONTRACT_VERSIONS and any(
        declared in SUPPORTED_CONTRACT_VERSIONS
        for declared in manifest.compatible_contract_versions
    )


def manifest_of(version):
    body = json.loads(bytes(version.canonical))
    body.pop("signature_claim", None)  # retired field; legacy rows still read
    return PackManifest.model_validate(body)


def version_closure(user, versions):
    pending = list(versions)
    visited = set()
    while pending:
        version = pending.pop()
        if version.id in visited:
            continue
        if len(visited) >= 2000:
            raise ValidationFailed("Pack closure exceeds the supported inspection bound.")
        visited.add(version.id)
        authorize(user, version.pack.workspace_id, Perm.WORKSPACE_READ)
        authorize_file(user, version.manifest_source)
        for entry in version.entries.select_related("source_file__blob"):
            if entry.revision_id:
                get_revision(user, entry.revision_id)
            authorize_file(user, entry.source_file)
        pending.extend(
            pin.dependency
            for pin in version.dependencies.select_related(
                "dependency__pack", "dependency__manifest_source__blob"
            )
        )


def pack_rows(user, pack_id, *, edit=False, lock=False, permission=Perm.DESIGN_EDIT):
    user = current_actor(user)
    query = CatalogPack.objects.all()
    if lock:
        query = query.select_for_update()
    pack = query.filter(id=pack_id).first()
    if pack is None:
        raise NotFound("Catalog pack not found.")
    authorize(user, pack.workspace_id, Perm.WORKSPACE_READ)
    versions = list(
        pack.versions.select_related("pack", "manifest_source__blob").order_by("created_at", "id")
    )
    version_closure(user, versions)
    decisions = list(pack.decisions.select_related("version").order_by("sequence"))
    if edit:
        authorize(user, pack.workspace_id, permission)
    return pack, versions, decisions


def pack_state(decisions):
    return f"pack-v{decisions[-1].sequence if decisions else 0}"


def active_version(decisions):
    latest = next(
        (decision for decision in reversed(decisions) if decision.action != "adopt"), None
    )
    return latest.version_id if latest and latest.action == "install" else None


def requested_keys(manifest):
    return sorted(request.key for request in manifest.requested_authority)


def enabled_version(versions, decisions):
    active = active_version(decisions)
    return next((version for version in versions if version.id == active), None)


def latest_kind(versions):
    return manifest_of(versions[-1]).kind if versions else "catalog"


def pack_result(pack, versions, decisions):
    enabled = enabled_version(versions, decisions)
    result = {
        "pack_id": str(pack.id),
        "workspace_id": str(pack.workspace_id),
        "package_key": pack.package_key,
        "state": pack_state(decisions),
        "installed_version_id": str(active_version(decisions))
        if active_version(decisions)
        else None,
        "enabled": active_version(decisions) is not None,
        "versions": [
            {
                "version_id": str(version.id),
                "version": version.version,
                "label": manifest_of(version).label,
                "sha256": version.sha256,
            }
            for version in versions
        ],
        "kind": manifest_of(enabled).kind if enabled else latest_kind(versions),
        "enabled_needs": requested_keys(manifest_of(enabled)) if enabled else [],
        "consumer_adoption": "explicit_new_drafts_only",
    }
    return PackResult.model_validate(result).model_dump(mode="json")


def get_pack(user, pack_id):
    return pack_result(*pack_rows(user, pack_id))


def version_result(version):
    manifest = manifest_of(version)
    source = version.manifest_source
    result = {
        "version_id": str(version.id),
        "pack_id": str(version.pack_id),
        "sha256": version.sha256,
        "manifest": manifest.model_dump(mode="json"),
        "manifest_source": {
            "source_bundle_revision_id": str(source.revision_id),
            "source_path": source.path,
            "sha256": source.blob.sha256,
            "rights": source.rights,
        }
        if source
        else None,
        "compatibility": "supported_contract" if supported(manifest) else "unsupported_contract",
        "declared_needs": requested_keys(manifest),
        "dependency_versions": [
            {
                "version_id": str(pin.dependency_id),
                "package_key": pin.dependency.pack.package_key,
                "version": pin.dependency.version,
                "sha256": pin.dependency.sha256,
                "enabled": pin.dependency_id
                in {active_version(list(pin.dependency.pack.decisions.order_by("sequence")))},
            }
            for pin in version.dependencies.select_related("dependency__pack")
        ],
        "registered_by_id": version.registered_by_id,
        "registered_at": version.created_at.isoformat(),
        "entries": [
            entry_result(entry, manifest)
            for entry in version.entries.select_related(
                "revision__definition", "revision__snapshot", "source_file__blob"
            ).order_by("key")
        ],
    }
    return VersionResult.model_validate(result).model_dump(mode="json")


def entry_result(entry, manifest):
    item = next(item for item in manifest.entries if item.key == entry.key)
    return {
        **item.model_dump(mode="json"),
        "engineering": {
            "definition_id": str(entry.revision.definition_id),
            "revision_id": str(entry.revision_id),
            "name": entry.revision.definition.name,
            "kind": entry.revision.definition.kind,
            "number": entry.revision.number,
            "sha256": entry.revision.snapshot.sha256,
        }
        if entry.revision_id
        else None,
        "interpretation": "draft_copy_available"
        if item.category in {"content", "profile"}
        else "inert_unparsed_not_executed",
    }


def get_version(user, version_id):
    version = (
        PackVersion.objects.select_related("pack", "manifest_source__blob")
        .filter(id=version_id)
        .first()
    )
    if version is None:
        raise NotFound("Pack version not found.")
    pack_rows(user, version.pack_id)
    return version_result(version)


def list_packs(user, workspace_id=None, *, after=None, limit=25):
    """Installed and registered packs of the workspace library."""
    from specmate.catalog.scope import library_scope

    user = current_actor(user)
    workspace, _ = library_scope(user, workspace_id)
    if not 1 <= limit <= 100:
        raise ValidationFailed("Limit must be between 1 and 100.")
    query = CatalogPack.objects.filter(workspace=workspace).order_by("id")
    if after is not None:
        if not query.filter(id=after).exists():
            raise NotFound("Pack cursor not found.")
        query = query.filter(id__gt=after)
    rows = [get_pack(user, pack.id) for pack in query[: limit + 1]]
    return {
        "workspace_id": str(workspace.id),
        "results": rows[:limit],
        "next_after": rows[limit - 1]["pack_id"] if len(rows) > limit else None,
    }


def history(user, pack_id, *, after=0, limit=25):
    pack, versions, decisions = pack_rows(user, pack_id)
    if after < 0 or not 1 <= limit <= 100:
        raise ValidationFailed("Invalid history pagination.")
    if after and not any(row.sequence == after for row in decisions):
        raise NotFound("Pack history cursor not found.")
    rows = [row for row in decisions if row.sequence > after][: limit + 1]
    by_id = {version.id: version for version in versions}
    return {
        "pack_id": str(pack.id),
        "state": pack_state(decisions),
        "results": [
            {
                "decision_id": str(row.id),
                "sequence": row.sequence,
                "action": row.action,
                "version_id": str(row.version_id),
                "version": by_id[row.version_id].version,
                "basis": row.basis,
                "decided_by_id": row.decided_by_id,
                "decided_at": row.created_at.isoformat(),
                "adoptions": [
                    {
                        "key": adoption.entry.key,
                        "source_revision_id": str(adoption.entry.revision_id)
                        if adoption.entry.revision_id
                        else None,
                        "definition_id": str(adoption.definition_id)
                        if adoption.definition_id
                        else None,
                        "draft_id": str(adoption.draft_id) if adoption.draft_id else None,
                        "initial_content": json.loads(bytes(adoption.initial_content))
                        if adoption.initial_content is not None
                        else None,
                        "status": adoption.status,
                    }
                    for adoption in visible_adoptions(user, row)
                ],
            }
            for row in rows[:limit]
        ],
        "next_after": rows[limit - 1].sequence if len(rows) > limit else None,
    }


def visible_adoptions(user, decision):
    for adoption in decision.adoptions.select_related("entry", "definition"):
        if adoption.draft_id:
            try:
                get_draft(user, adoption.draft_id)
            except (NotFound, PermissionDenied):
                continue
        yield adoption
