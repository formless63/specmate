"""Exact family declarations using the shared operation and snapshot authority."""

import json

from django.core import signing
from django.db.models import OuterRef, Subquery
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from pydantic import ValidationError

from specmate.access.permissions import Perm, authorize
from specmate.catalog.scope import library_scope, references_revision
from specmate.catalog_matching.queries import current_actor
from specmate.design.closure_reads import (
    authorized_revision,
    closure_reads,
    prefetch_origins,
    remember_authorized_revision,
)
from specmate.design.models import Definition, Draft, Revision
from specmate.design.pins import check_pin
from specmate.operations import Context, NotFound, OperationError, ValidationFailed, operation
from specmate.parts.queries import readable_revisions
from specmate.products.contracts import (
    LineupQuery,
    LineupResult,
    ProductFamily,
    VersionsQuery,
    VersionsResult,
)
from specmate.queries import get_revision

SALT = "products-lineup-v1"
SCAN_LIMIT = 50
DESIGN_KINDS = {"cable", "harness", "assembly"}


def typed(kind, content):
    if kind != "product_family" or "product_family" not in content:
        raise ValidationFailed("A product family requires its typed family declaration.")
    try:
        return ProductFamily.model_validate(content["product_family"])
    except ValidationError as error:
        raise ValidationFailed(
            "Invalid product family.",
            details={
                "errors": [
                    {"path": list(row["loc"]), "message": row["msg"]}
                    for row in error.errors(include_input=False)
                ]
            },
        ) from None


def validate_content(kind, content):
    return {**content, "product_family": typed(kind, content).model_dump(mode="json")}


def dependency_revisions(user, definition, content):
    family = typed(definition.kind, content)
    ids = {variant.design_revision_id for variant in family.variants}
    if not ids:
        return []
    from specmate.design.operations import authorize_snapshots

    with closure_reads():
        known = {rid: authorized_revision(user, rid) for rid in ids}
        missing = [rid for rid, revision in known.items() if revision is None]
        rows = list(
            Revision.objects.filter(id__in=missing).select_related(
                "definition", "snapshot__definition"
            )
        )
        found = {
            **{rid: revision for rid, revision in known.items() if revision},
            **{revision.id: revision for revision in rows},
        }
        if set(found) != ids:
            raise NotFound("Not found.")
        for revision in found.values():
            check_pin(user, revision, definition.workspace_id)
        prefetch_origins(row.definition_id for row in rows)
        authorize_snapshots(user, [row.snapshot for row in rows])
        # Current full closure authority precedes kind diagnostics.
        if any(row.definition.kind not in DESIGN_KINDS for row in found.values()):
            raise ValidationFailed(
                "Product variants require an exact cable, harness or assembly revision."
            )
        for revision in rows:
            remember_authorized_revision(user, revision)
        return sorted(ids, key=str)


def position(query, user):
    binding = {"actor": str(user.pk), **query.model_dump(mode="json", exclude={"after"})}
    if query.after is None:
        return binding, timezone.now(), 0, 0
    try:
        cursor = signing.loads(query.after, salt=SALT, max_age=86400)
        anchor = parse_datetime(cursor["anchor"])
        if (
            cursor["binding"] != binding
            or type(cursor["version"]) is not int
            or cursor["version"] != 1
            or anchor is None
            or timezone.is_naive(anchor)
            or anchor > timezone.now()
            or type(cursor["family"]) is not int
            or not 0 <= cursor["family"] <= 1_000_000
            or type(cursor["variant"]) is not int
            or not 0 <= cursor["variant"] < 100
        ):
            raise ValueError
        return binding, anchor, cursor["family"], cursor["variant"]
    except (signing.BadSignature, KeyError, ValueError, TypeError):
        raise ValidationFailed("Invalid lineup cursor.") from None


def identity(revision):
    return {
        "definition_id": str(revision.definition_id),
        "revision_id": str(revision.id),
        "name": revision.definition.name,
        "kind": revision.definition.kind,
        "number": revision.number,
        "sha256": revision.snapshot.sha256,
    }


def lineup(user, query):
    user = current_actor(user)
    workspace, project = library_scope(user, query.workspace_id, query.project_id)
    binding, anchor, offset, variant_offset = position(query, user)
    latest = Revision.objects.filter(
        definition_id=OuterRef("definition_id"), frozen_at__lte=anchor
    ).order_by("-number")
    candidates = (
        Revision.objects.filter(
            definition__workspace=workspace,
            definition__kind="product_family",
            frozen_at__lte=anchor,
            id=Subquery(latest.values("id")[:1]),
        )
        .select_related("definition", "snapshot__definition")
        .order_by("definition_id")
    )
    if project:
        candidates = candidates.annotate(
            in_project=references_revision(project, "id", "definition_id")
        )
    batch = list(candidates[offset : offset + SCAN_LIMIT + 1])
    results, next_position = [], None
    with closure_reads():
        readable = readable_revisions(user, batch[:SCAN_LIMIT])
        for index, revision in enumerate(batch[:SCAN_LIMIT]):
            start = variant_offset if index == 0 else 0
            if revision.id not in readable:
                continue
            family = typed(
                "product_family", json.loads(bytes(revision.snapshot.canonical))["content"]
            )
            for number, variant in enumerate(family.variants[start:], start=start):
                design = authorized_revision(user, variant.design_revision_id) or get_revision(
                    user, variant.design_revision_id
                )
                row = {
                    "family": identity(revision),
                    "family_number": family.number,
                    "variant": variant.model_dump(mode="json"),
                    "selected_options": [
                        {
                            "axis_id": axis.local_id,
                            "axis_label": axis.label,
                            "value_id": value.local_id,
                            "value_label": value.label,
                        }
                        for axis in family.options
                        for value in axis.values
                        if variant.options.get(axis.local_id) == value.local_id
                    ],
                    "design": identity(design),
                }
                if project:
                    row["in_project"] = bool(revision.in_project)
                results.append(row)
                if len(results) == query.limit:
                    next_position = (
                        (offset + index, number + 1)
                        if number + 1 < len(family.variants)
                        else (offset + index + 1, 0)
                    )
                    break
            if next_position:
                break
    if next_position is None and len(batch) > SCAN_LIMIT:
        next_position = offset + SCAN_LIMIT, 0
    if (
        next_position
        and next_position[1] == 0
        and not candidates[next_position[0] : next_position[0] + 1].exists()
    ):
        next_position = None
    return LineupResult.model_validate(
        {
            "results": results,
            "as_of": anchor.isoformat(),
            "basis": "latest_frozen_family_at_page_anchor_current_authority",
            "next_after": signing.dumps(
                {
                    "version": 1,
                    "binding": binding,
                    "anchor": anchor.isoformat(),
                    "family": next_position[0],
                    "variant": next_position[1],
                },
                salt=SALT,
                compress=True,
            )
            if next_position
            else None,
        }
    ).model_dump(mode="json", exclude_unset=True)


@operation(
    "products.lineup",
    LineupQuery,
    supports_idempotency=False,
    summary="Read bounded exact frozen product variants with current closure authority.",
    access=Perm.WORKSPACE_READ,
)
def read_lineup(ctx: Context, payload: LineupQuery):
    return lineup(ctx.user, payload)


@operation(
    "products.versions",
    VersionsQuery,
    supports_idempotency=False,
    summary="List bounded individually authorized family revision and draft choices.",
    access=Perm.WORKSPACE_READ,
)
def read_versions(ctx: Context, payload: VersionsQuery):
    from specmate.catalog.queries import draft_summary
    from specmate.catalog_packs.authoring import authorize_origin

    user = current_actor(ctx.user)
    definition = Definition.objects.filter(id=payload.definition_id).first()
    if definition is None:
        raise NotFound("Not found.")
    authorize(user, definition.workspace_id, Perm.WORKSPACE_READ)
    authorize_origin(user, definition)
    if definition.kind != "product_family":
        raise ValidationFailed("Choose a product family.")
    start, stop = payload.offset, payload.offset + payload.limit + 1
    revisions = list(
        Revision.objects.filter(definition=definition)
        .select_related("definition", "snapshot__definition")
        .order_by("-number")[start:stop]
    )
    drafts = list(
        Draft.objects.filter(definition=definition)
        .select_related("definition", "base_revision__snapshot")
        .order_by("-updated_at", "id")[start:stop]
    )
    choices = []
    with closure_reads():
        readable = readable_revisions(user, revisions[: payload.limit])
        for draft in drafts[: payload.limit]:
            try:
                draft_summary(user, draft)
            except OperationError:
                continue
            choices.append(
                {
                    "draft_id": draft.id,
                    "version": draft.version,
                    "label": f"Working draft v{draft.version} · {draft.updated_at.isoformat()}",
                }
            )
    return VersionsResult(
        revisions=[identity(r) for r in revisions[: payload.limit] if r.id in readable],
        drafts=choices,
        next_offset=payload.offset + payload.limit
        if max(len(revisions), len(drafts)) > payload.limit
        else None,
    ).model_dump(mode="json")
