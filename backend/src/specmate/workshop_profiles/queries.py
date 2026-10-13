"""Scoped profile reads and exact construction/source-reference checks."""

import json
from uuid import UUID

from specmate.access.permissions import Perm, authorize
from specmate.design.models import Definition, Draft, Revision
from specmate.design.operations import draft_state, scoped_draft
from specmate.operations import Context, NotFound, ValidationFailed
from specmate.queries import get_bundle_revision, get_revision
from specmate.sources.models import SourceBundleFile
from specmate.workshop_profiles.schemas import SourceFile, WorkshopProfile


def _paths(node: dict, prefix: str = "") -> set[str]:
    path = f"{prefix}.{node['id']}" if prefix else node["id"]
    return {path}.union(*(_paths(child, path) for child in node.get("children", [])))


def authorize_profile_content(user, definition, content: dict) -> None:
    if "profile" not in content:
        return
    profile = WorkshopProfile.model_validate(content["profile"])
    stock = get_revision(user, profile.stock_revision_id)
    if (
        stock.definition.kind != "wire_stock"
        or stock.definition.project_id != definition.project_id
    ):
        raise ValidationFailed(
            "Profile construction must be an exact stock revision in this project."
        )
    stock_content = json.loads(bytes(stock.snapshot.canonical))["content"]["stock"]
    paths = _paths(stock_content["structure"])
    invalid = set(profile.element_rules) | set(profile.hidden_element_paths)
    if invalid - paths:
        raise ValidationFailed("A profile element path is absent from its stock revision.")
    for suggestion in _suggestions(profile):
        source = suggestion.source
        if not isinstance(source, SourceFile):
            continue
        revision = get_bundle_revision(user, source.bundle_revision_id)
        if revision.bundle.project_id != definition.project_id:
            raise ValidationFailed("Profile source must belong to its project.")
        file = (
            SourceBundleFile.objects.select_related("blob")
            .filter(revision=revision, path=source.path)
            .first()
        )
        if file is None:
            raise NotFound("Profile source file not found.")
        if file.blob.sha256 != source.sha256 or file.rights != source.rights:
            raise ValidationFailed(
                "Profile source digest or rights differ from registered evidence."
            )


def _suggestions(profile: WorkshopProfile):
    yield profile.foil_visibility
    yield profile.illustration_lay_length_mm
    yield profile.omit_occluded
    for rule in profile.element_rules.values():
        for end in (rule.a, rule.b):
            yield end.cutback_mm
            yield end.prepend_cut_mm
            if end.lead:
                yield end.lead.length_mm
                yield end.lead.diameter_mm
                yield end.lead.reach_mm
                yield end.lead.angle_deg


def dependency_revisions(user, definition, content: dict) -> list[UUID]:
    """Shared capture must pin the exact construction selected by a profile."""
    authorize_profile_content(user, definition, content)
    return [WorkshopProfile.model_validate(content["profile"]).stock_revision_id]


def list_profiles(user, project_id: UUID) -> list[dict]:
    authorize(user, project_id, Perm.PROJECT_READ)
    result = []
    for draft in (
        Draft.objects.select_related("definition")
        .filter(definition__project_id=project_id, definition__kind="workshop_profile")
        .order_by("definition__created_at", "id")
    ):
        authorize_profile_content(user, draft.definition, draft.content)
        result.append(
            {
                "definition_id": str(draft.definition_id),
                "name": draft.definition.name,
                **draft_state(draft),
            }
        )
    return result


def get_profile(user, draft_id: UUID) -> dict:
    draft = scoped_draft(
        Context(user=user, via="internal", request_id="profile-read"),
        draft_id,
        Perm.PROJECT_READ,
    )
    if draft.definition.kind != "workshop_profile":
        raise NotFound("Workshop profile draft not found.")
    authorize_profile_content(user, draft.definition, draft.content)
    return {
        "definition_id": str(draft.definition_id),
        "name": draft.definition.name,
        **draft_state(draft),
    }


def list_profile_revisions(user, definition_id: UUID) -> list[dict]:
    definition = Definition.objects.filter(id=definition_id, kind="workshop_profile").first()
    if definition is None:
        raise NotFound("Workshop profile definition not found.")
    authorize(user, definition.project_id, Perm.PROJECT_READ)
    revisions = (
        Revision.objects.select_related("definition", "snapshot")
        .filter(definition_id=definition_id, definition__kind="workshop_profile")
        .order_by("number")
    )
    return [revision_result(user, revision.id) for revision in revisions]


def revision_result(user, revision_id: UUID) -> dict:
    revision = get_revision(user, revision_id)
    if revision.definition.kind != "workshop_profile":
        raise NotFound("Workshop profile revision not found.")
    content = json.loads(bytes(revision.snapshot.canonical))["content"]
    authorize_profile_content(user, revision.definition, content)
    return {
        "revision_id": str(revision.id),
        "definition_id": str(revision.definition_id),
        "name": revision.definition.name,
        "number": revision.number,
        "sha256": revision.snapshot.sha256,
        "content": content,
    }
