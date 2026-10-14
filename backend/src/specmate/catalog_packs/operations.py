import hashlib
import json

from pydantic import ValidationError as PydanticValidationError

from specmate.access.permissions import Perm
from specmate.catalog.scope import creation_workspace
from specmate.catalog_packs.contracts import (
    AdoptPack,
    DisablePack,
    InstallPack,
    RegisterPackVersion,
)
from specmate.catalog_packs.models import (
    AdoptionEntry,
    CatalogPack,
    PackDecision,
    PackVersion,
    VersionDependency,
    VersionEntry,
)
from specmate.catalog_packs.queries import (
    active_version,
    authorize_file,
    get_pack,
    get_version,
    manifest_of,
    pack_rows,
    pack_state,
    version_closure,
    version_result,
)
from specmate.design.models import Definition
from specmate.design.operations import (
    CreateDefinition,
    authorize_design_content,
    canonical_bytes,
    create_definition,
    validate_content,
)
from specmate.operations import (
    Conflict,
    Context,
    NotFound,
    Unsupported,
    ValidationFailed,
    operation,
)
from specmate.operations.models import IdempotencyRecord
from specmate.queries import get_bundle_revision, get_revision
from specmate.sources import blobstore
from specmate.sources.models import SourceBundleFile


def file_pin(user, pin):
    revision = get_bundle_revision(user, pin.source_bundle_revision_id)
    file = (
        SourceBundleFile.objects.select_related("blob")
        .filter(revision=revision, path=pin.source_path)
        .first()
    )
    if file is None:
        raise NotFound("Pack source file not found.")
    authorize_file(user, file)
    if file.blob.sha256 != pin.sha256 or file.rights != pin.rights:
        raise ValidationFailed(
            "Pack file hash or declared rights do not match the registered source."
        )
    return file


def registration_workspace(ctx, payload):
    """Registering an inert pack version imports new immutable records (item.create)."""
    return creation_workspace(ctx.user, payload.workspace_id, payload.project_id)


def registration_refs(ctx, payload):
    workspace = registration_workspace(ctx, payload)
    if payload.pack_id:
        pack, _, _ = pack_rows(ctx.user, payload.pack_id, edit=True, permission=Perm.ITEM_CREATE)
        if pack.workspace_id != workspace.id:
            raise ValidationFailed("Pack belongs to another workspace.")
        if pack.package_key != payload.manifest.package_key:
            raise ValidationFailed("A version must retain its pack's exact package identity.")
    pins = []
    for item in payload.manifest.entries:
        revision = get_revision(ctx.user, item.revision_id) if item.revision_id else None
        source = file_pin(ctx.user, item.source) if item.source else None
        if (revision and revision.definition.workspace_id != workspace.id) or (
            source and source.blob.workspace_id != workspace.id
        ):
            # A pack installs into one workspace; bringing material from elsewhere is an
            # explicit import, never a live cross-workspace pin. Foreign records are
            # indistinguishable from missing ones.
            raise NotFound("Not found.")
        if revision and revision.snapshot.sha256 != item.revision_sha256:
            raise ValidationFailed("Pack revision snapshot hash does not match its exact pin.")
        if item.category == "profile" and revision.definition.kind != "workshop_profile":
            raise ValidationFailed("Profile entries must pin workshop profile revisions.")
        pins.append((item, revision, source))
    dependencies = []
    for dependency_id in payload.manifest.dependencies:
        dependency = (
            PackVersion.objects.select_related("pack", "manifest_source__blob")
            .filter(id=dependency_id)
            .first()
        )
        if dependency is None:
            raise NotFound("Pack dependency version not found.")
        pack_rows(ctx.user, dependency.pack_id)
        if dependency.pack.workspace_id != workspace.id:
            raise NotFound("Not found.")
        dependencies.append(dependency)
    source = file_pin(ctx.user, payload.manifest_source) if payload.manifest_source else None
    if source and source.blob.workspace_id != workspace.id:
        raise NotFound("Not found.")
    return pins, dependencies, source


def authorize_retained(ctx, operation_name, scope, permission=Perm.DESIGN_EDIT):
    if ctx.idempotency_key:
        for record in IdempotencyRecord.objects.filter(
            actor=ctx.user,
            operation=operation_name,
            key=ctx.idempotency_key,
            scope=scope,
        ):
            pack_rows(
                ctx.user, record.result["pack_id"], edit=True, lock=True, permission=permission
            )


def register_scope(ctx, payload):
    registration_refs(ctx, payload)
    scope = f"workspace:{registration_workspace(ctx, payload).id}"
    authorize_retained(ctx, "catalog_pack.register", scope, Perm.ITEM_CREATE)
    return scope


def change_scope(name):
    def resolve(ctx, payload):
        pack, _, _ = pack_rows(ctx.user, payload.pack_id, edit=True)
        if isinstance(payload, (InstallPack, AdoptPack)):
            version = (
                PackVersion.objects.select_related("pack", "manifest_source__blob")
                .filter(id=payload.version_id)
                .first()
            )
            if version is None:
                raise NotFound("Pack version not found.")
            version_closure(ctx.user, [version])
        scope = f"workspace:{pack.workspace_id}"
        authorize_retained(ctx, name, scope)
        return scope

    return resolve


def replay(ctx, payload, stored):
    registering = isinstance(payload, RegisterPackVersion)
    permission = Perm.ITEM_CREATE if registering else Perm.DESIGN_EDIT
    pack_rows(ctx.user, stored["pack_id"], edit=True, permission=permission)
    if registering:
        registration_refs(ctx, payload)
    elif isinstance(payload, (InstallPack, AdoptPack)):
        version = (
            PackVersion.objects.select_related("pack", "manifest_source__blob")
            .filter(id=payload.version_id)
            .first()
        )
        if version is None:
            raise NotFound("Pack version not found.")
        version_closure(ctx.user, [version])


@operation(
    "catalog_pack.register",
    RegisterPackVersion,
    summary="Register inert catalog manifest content with exact pins and no execution authority.",
    idempotency_scope=register_scope,
    authorize_replay=replay,
)
def register(ctx: Context, payload: RegisterPackVersion):
    pins, dependencies, source = registration_refs(ctx, payload)
    body = payload.manifest.model_dump(mode="json")
    canonical = canonical_bytes(body)
    if source:
        if source.blob.size > 256 * 1024:
            raise ValidationFailed("Manifest file exceeds the supported bounded JSON size.")
        try:
            with blobstore.blob_path(source.blob.sha256).open("rb") as stream:
                raw = stream.read(256 * 1024 + 1)
            if (
                len(raw) != source.blob.size
                or hashlib.sha256(raw).hexdigest() != source.blob.sha256
            ):
                raise ValidationFailed("Manifest source bytes do not match their registered hash.")
            from specmate.catalog_packs.contracts import PackManifest

            parsed = PackManifest.model_validate_json(raw)
            if canonical_bytes(parsed.model_dump(mode="json")) != canonical:
                raise ValidationFailed(
                    "Registered manifest source does not match the typed pack manifest."
                )
        except (OSError, PydanticValidationError):
            raise ValidationFailed(
                "Manifest source is unavailable or is not supported inert JSON."
            ) from None
    # Serialize identity/version duplicate diagnostics after authorizing all refs.
    workspace = registration_workspace(ctx, payload)
    workspace.__class__.objects.select_for_update().get(id=workspace.id)
    if payload.pack_id:
        pack, _, _ = pack_rows(
            ctx.user, payload.pack_id, edit=True, lock=True, permission=Perm.ITEM_CREATE
        )
    else:
        if CatalogPack.objects.filter(
            workspace=workspace, package_key=payload.manifest.package_key
        ).exists():
            raise Conflict("This package is registered; select it explicitly to add a version.")
        pack = CatalogPack.objects.create(
            workspace=workspace,
            package_key=payload.manifest.package_key,
            registered_by=ctx.user,
        )
    if pack.versions.filter(version=payload.manifest.version).exists():
        raise Conflict("This exact package version is already registered.")
    version = PackVersion.objects.create(
        pack=pack,
        version=payload.manifest.version,
        canonical=canonical,
        sha256=hashlib.sha256(canonical).hexdigest(),
        manifest_source=source,
        registered_by=ctx.user,
    )
    for item, revision, source_file in pins:
        VersionEntry.objects.create(
            version=version, key=item.key, revision=revision, source_file=source_file
        )
    for dependency in dependencies:
        VersionDependency.objects.create(version=version, dependency=dependency)
    return version_result(version)


def editable_state(ctx, pack_id):
    pack, versions, decisions = pack_rows(ctx.user, pack_id, edit=True, lock=True)
    if ctx.require_expected_state() != pack_state(decisions):
        raise Conflict("Pack decisions changed.", details={"current": get_pack(ctx.user, pack_id)})
    return pack, versions, decisions


def selected_version(ctx, versions, version_id):
    version = next((version for version in versions if version.id == version_id), None)
    if version is None:
        other = (
            PackVersion.objects.select_related("pack", "manifest_source__blob")
            .filter(id=version_id)
            .first()
        )
        if other is None:
            raise NotFound("Pack version not found.")
        version_closure(ctx.user, [other])
        raise ValidationFailed("Selected version does not belong to this pack.")
    if manifest_of(version).contract_version != "1":
        raise Unsupported("This pack contract version cannot be installed or adopted.")
    return version


def append_decision(ctx, pack, version, decisions, action, basis):
    return PackDecision.objects.create(
        pack=pack,
        version=version,
        sequence=len(decisions) + 1,
        action=action,
        basis=basis,
        decided_by=ctx.user,
    )


@operation(
    "catalog_pack.install",
    InstallPack,
    summary="Deliberately select an installed catalog version, including update or downgrade.",
    requires_expected_state=True,
    idempotency_scope=change_scope("catalog_pack.install"),
    authorize_replay=replay,
)
def install(ctx: Context, payload: InstallPack):
    get_version(ctx.user, payload.version_id)
    pack, versions, decisions = editable_state(ctx, payload.pack_id)
    version = selected_version(ctx, versions, payload.version_id)
    append_decision(ctx, pack, version, decisions, "install", payload.basis)
    return get_pack(ctx.user, pack.id)


@operation(
    "catalog_pack.disable",
    DisablePack,
    summary="Disable new pack use while preserving exact versions, adopted drafts and consumers.",
    requires_expected_state=True,
    idempotency_scope=change_scope("catalog_pack.disable"),
    authorize_replay=replay,
)
def disable(ctx: Context, payload: DisablePack):
    pack, versions, decisions = editable_state(ctx, payload.pack_id)
    active = active_version(decisions)
    if active is None:
        raise Conflict("Pack has no enabled installed version.")
    version = next(version for version in versions if version.id == active)
    append_decision(ctx, pack, version, decisions, "disable", payload.basis)
    return get_pack(ctx.user, pack.id)


@operation(
    "catalog_pack.adopt",
    AdoptPack,
    summary="Adopt selected exact pack entries as fresh workspace drafts or inert references.",
    requires_expected_state=True,
    idempotency_scope=change_scope("catalog_pack.adopt"),
    authorize_replay=replay,
)
def adopt(ctx: Context, payload: AdoptPack):
    get_version(ctx.user, payload.version_id)
    pack, versions, decisions = editable_state(ctx, payload.pack_id)
    version = selected_version(ctx, versions, payload.version_id)
    if active_version(decisions) != version.id:
        raise Conflict("Install and enable this exact pack version before new adoption.")
    manifest = manifest_of(version)
    rows = {
        entry.key: entry
        for entry in version.entries.select_related("revision__definition", "revision__snapshot")
    }
    if any(key not in rows for key in payload.entry_keys):
        raise ValidationFailed("Selected pack entry not found.")
    if any(
        rows[key].revision_id and rows[key].revision.definition.workspace_id != pack.workspace_id
        for key in payload.entry_keys
    ):
        # Unreachable while registration and the entry guard hold; never disclose.
        raise NotFound("Not found.")
    for pin in version.dependencies.select_related("dependency__pack"):
        dependency_pack, _, dependency_decisions = pack_rows(ctx.user, pin.dependency.pack_id)
        if (
            dependency_pack.workspace_id != pack.workspace_id
            or active_version(dependency_decisions) != pin.dependency_id
        ):
            raise Conflict("Each exact dependency version must be enabled in this workspace.")
    plans = []
    for key in payload.entry_keys:
        entry = rows[key]
        item = next(item for item in manifest.entries if item.key == key)
        content = None
        if item.category in {"content", "profile"}:
            source = get_revision(ctx.user, entry.revision_id)
            content = json.loads(bytes(source.snapshot.canonical))["content"]
            prototype = Definition(
                workspace_id=pack.workspace_id,
                kind=source.definition.kind,
                name=item.label,
                created_by=ctx.user,
            )
            try:
                content = validate_content(prototype.kind, content)
                authorize_design_content(ctx.user, prototype, content)
            except (ValidationFailed, Unsupported, PydanticValidationError):
                raise Unsupported(
                    "A selected typed entry cannot be copied into this workspace.",
                    details={"entry_key": key},
                ) from None
        plans.append((entry, item, content))
    # All pins, current authority and copy semantics are checked before any materialization.
    decision = append_decision(ctx, pack, version, decisions, "adopt", payload.basis)
    for entry, item, content in plans:
        if content is None:
            AdoptionEntry.objects.create(decision=decision, entry=entry, status="inert_reference")
            continue
        created = create_definition(
            ctx,
            CreateDefinition(
                workspace_id=pack.workspace_id,
                kind=entry.revision.definition.kind,
                name=item.label,
                content=content,
            ),
        )
        AdoptionEntry.objects.create(
            decision=decision,
            entry=entry,
            definition_id=created["definition_id"],
            draft_id=created["draft_id"],
            initial_content=canonical_bytes(content),
            status="draft_created",
        )
    return get_pack(ctx.user, pack.id)
