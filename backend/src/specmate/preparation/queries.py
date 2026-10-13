"""Current owning/source ancestry authority before recipe or application diagnostics."""

import json
from contextvars import ContextVar

from pydantic import ValidationError

from specmate.cables.queries import conductive_elements
from specmate.operations import NotFound, ValidationFailed
from specmate.preparation.contracts import PreparationProfile
from specmate.queries import get_bundle_revision, get_revision
from specmate.sources.authority import authorize_revision as authorize_source_revision
from specmate.sources.models import SourceBundleFile
from specmate.wire_stock.schemas import StockSpecification
from specmate.workshop_profiles.schemas import SourceFile

_ACTIVE = ContextVar("preparation_source_closure", default=frozenset())


def parse_content(content, kind=None):
    if "preparation_profile" not in content:
        if kind == "preparation_profile":
            raise ValidationFailed("Typed preparation profile content is required.")
        return None
    if kind is not None and kind != "preparation_profile":
        raise ValidationFailed("Preparation profile content requires its own definition kind.")
    try:
        return PreparationProfile.model_validate(content["preparation_profile"])
    except ValidationError:
        raise ValidationFailed("Invalid preparation profile content.") from None


def validate_content(kind, content):
    profile = parse_content(content, kind)
    return (
        {**content, "preparation_profile": profile.model_dump(mode="json")} if profile else content
    )


def closure(user, content, kind=None, *, authority_only=False):
    profile = parse_content(content, kind)
    if profile is None:
        return None, None, {}
    active = _ACTIVE.get()
    if profile.stock_revision_id in active or len(active) >= 32:
        raise ValidationFailed("Preparation reference cycle or nesting limit.")
    token = _ACTIVE.set(active | {profile.stock_revision_id})
    try:
        stock = get_revision(user, profile.stock_revision_id)
        sources = []
        for formula in profile.formulas:
            for allowance in formula.allowances:
                if isinstance(allowance.source, SourceFile):
                    revision = get_bundle_revision(user, allowance.source.bundle_revision_id)
                    authorize_source_revision(user, revision)
                    sources.append((allowance.source, revision))
        if authority_only:
            return profile, stock, {}
        # Only after ALL cited sources and their original/archive ancestors are authorized.
        for source, revision in sources:
            file = (
                SourceBundleFile.objects.select_related("blob")
                .filter(revision=revision, path=source.path)
                .first()
            )
            if file is None:
                raise NotFound("Preparation evidence file unavailable.")
            if file.blob.sha256 != source.sha256 or file.rights != source.rights:
                raise ValidationFailed("Preparation evidence digest or rights do not match.")
        stock_content = json.loads(bytes(stock.snapshot.canonical))["content"]
        if stock.definition.kind != "wire_stock" or "stock" not in stock_content:
            raise ValidationFailed("Preparation profile requires an exact typed stock revision.")
        elements = dict(
            conductive_elements(StockSpecification.model_validate(stock_content["stock"]).structure)
        )
        if any(
            f.element_path is not None and f.element_path not in elements for f in profile.formulas
        ):
            raise ValidationFailed("Preparation formula must select a conductive stock feature.")
        return profile, stock, elements
    finally:
        _ACTIVE.reset(token)


def authorize_content(user, definition, content):
    closure(user, content, definition.kind)


def dependency_revisions(user, definition, content):
    profile, _, _ = closure(user, content, definition.kind)
    return [profile.stock_revision_id] if profile else []


def profile_revision(user, revision_id):
    revision = get_revision(user, revision_id)
    if revision.definition.kind != "preparation_profile":
        raise ValidationFailed("An exact preparation profile revision is required.")
    profile, stock, elements = closure(
        user, json.loads(bytes(revision.snapshot.canonical))["content"], revision.definition.kind
    )
    return revision, profile, stock, elements


def inspect_profile(user, revision_id):
    revision, profile, stock, elements = profile_revision(user, revision_id)
    return {
        "revision_id": str(revision.id),
        "definition_id": str(revision.definition_id),
        "sha256": revision.snapshot.sha256,
        "profile": profile.model_dump(mode="json"),
        "stock_sha256": stock.snapshot.sha256,
        "conductive_features": [
            {"element_path": path, "kind": element.kind} for path, element in elements.items()
        ],
        "application": "read_only_suggestion",
        "physical_qualification": "not_evaluated",
    }
