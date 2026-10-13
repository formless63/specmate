"""Current source closure precedes endpoint, feature and preparation diagnostics."""

import json
from contextvars import ContextVar

from pydantic import ValidationError

from specmate.catalog_matching.queries import current_actor
from specmate.end_preparation.contracts import (
    BondExpectation,
    ContactTarget,
    EndPreparationProfile,
    FeatureTarget,
)
from specmate.interfaces.contracts import ConnectorBody
from specmate.interfaces.queries import parse_content as parse_interface
from specmate.operations import NotFound, ValidationFailed
from specmate.queries import get_bundle_revision, get_revision
from specmate.sources.authority import authorize_revision as authorize_source_revision
from specmate.sources.models import SourceBundleFile
from specmate.wire_stock.schemas import StockSpecification
from specmate.workshop_profiles.schemas import SourceFile

_ACTIVE = ContextVar("end_preparation_closure", default=frozenset())
LAYER_KINDS = {"dielectric", "insulation", "shield", "filler", "jacket", "web"}


def leaf_elements(node, prefix=""):
    path = f"{prefix}.{node.id}" if prefix else node.id
    if node.kind != "group":
        yield path, node
    for child in getattr(node, "children", []):
        yield from leaf_elements(child, path)


def parse_content(content, kind=None):
    if "end_preparation_profile" not in content:
        if kind == "end_preparation_profile":
            raise ValidationFailed("Typed end preparation profile content is required.")
        return None
    if kind is not None and kind != "end_preparation_profile":
        raise ValidationFailed("End preparation profile requires its own definition kind.")
    try:
        return EndPreparationProfile.model_validate(content["end_preparation_profile"])
    except ValidationError:
        raise ValidationFailed("Invalid end preparation profile content.") from None


def validate_content(kind, content):
    profile = parse_content(content, kind)
    return (
        {**content, "end_preparation_profile": profile.model_dump(mode="json")}
        if profile
        else content
    )


def closure(user, content, kind=None, *, authority_only=False):
    user = current_actor(user)
    profile = parse_content(content, kind)
    if profile is None:
        return None, None, {}, {}
    active = _ACTIVE.get()
    if profile.stock_revision_id in active or len(active) >= 32:
        raise ValidationFailed("End preparation reference cycle or nesting limit.")
    token = _ACTIVE.set(active | {profile.stock_revision_id})
    try:
        stock = get_revision(user, profile.stock_revision_id)
        instructions = [*profile.a.instructions, *profile.b.instructions]
        body_revisions = {
            i.target.body_revision_id: get_revision(user, i.target.body_revision_id)
            for i in instructions
            if isinstance(i, BondExpectation) and isinstance(i.target, ContactTarget)
        }
        sources = []
        for instruction in instructions:
            if isinstance(instruction.source, SourceFile):
                revision = get_bundle_revision(user, instruction.source.bundle_revision_id)
                authorize_source_revision(user, revision)
                sources.append((instruction.source, revision))
        if authority_only:
            return profile, stock, {}, body_revisions
        # File, feature and contact diagnostics only after the complete supplied closure.
        for source, revision in sources:
            file = (
                SourceBundleFile.objects.select_related("blob")
                .filter(revision=revision, path=source.path)
                .first()
            )
            if file is None:
                raise NotFound("End preparation evidence file unavailable.")
            if file.blob.sha256 != source.sha256 or file.rights != source.rights:
                raise ValidationFailed("End preparation evidence digest or rights do not match.")
        stock_content = json.loads(bytes(stock.snapshot.canonical))["content"]
        if stock.definition.kind != "wire_stock" or "stock" not in stock_content:
            raise ValidationFailed("End preparation requires an exact typed stock revision.")
        elements = dict(
            leaf_elements(StockSpecification.model_validate(stock_content["stock"]).structure)
        )
        bodies = {}
        for rid, revision in body_revisions.items():
            body = parse_interface(
                json.loads(bytes(revision.snapshot.canonical))["content"], revision.definition.kind
            )
            if not isinstance(body, ConnectorBody):
                raise ValidationFailed("Expected bond contact must pin a connector body revision.")
            bodies[rid] = body
        for instruction in instructions:
            element = elements.get(instruction.element_path)
            allowed = (
                LAYER_KINDS
                if instruction.kind == "layer_strip"
                else {"drain"}
                if instruction.kind == "drain_treatment"
                else {"shield"}
                if instruction.kind == "shield_lead"
                else {"shield", "drain"}
            )
            if element is None or element.kind not in allowed:
                raise ValidationFailed(
                    "Preparation instruction requires the exact applicable stock feature."
                )
            if isinstance(instruction, BondExpectation):
                if isinstance(instruction.target, FeatureTarget):
                    target = elements.get(instruction.target.element_path)
                    if target is None or target.kind not in {"shield", "drain", "conductor"}:
                        raise ValidationFailed(
                            "Expected bond target must be an exact conductive feature."
                        )
                if isinstance(instruction.target, ContactTarget):
                    if instruction.target.contact_id not in {
                        c.contact_id
                        for c in bodies[instruction.target.body_revision_id].contacts
                        if c.physical_role != "key"
                    }:
                        raise ValidationFailed(
                            "Expected bond must identify a physical contact or shell."
                        )
        return profile, stock, elements, body_revisions
    finally:
        _ACTIVE.reset(token)


def authorize_content(user, definition, content):
    closure(user, content, definition.kind)


def dependency_revisions(user, definition, content):
    profile, _, _, bodies = closure(user, content, definition.kind)
    return sorted({profile.stock_revision_id, *bodies}, key=str) if profile else []


def profile_revision(user, revision_id):
    user = current_actor(user)
    revision = get_revision(user, revision_id)
    if revision.definition.kind != "end_preparation_profile":
        raise ValidationFailed("An exact end preparation profile revision is required.")
    profile, stock, elements, bodies = closure(
        user, json.loads(bytes(revision.snapshot.canonical))["content"], revision.definition.kind
    )
    return revision, profile, stock, elements, bodies


def inspect_profile(user, revision_id):
    revision, profile, stock, elements, bodies = profile_revision(user, revision_id)
    return {
        "revision_id": str(revision.id),
        "definition_id": str(revision.definition_id),
        "sha256": revision.snapshot.sha256,
        "profile": profile.model_dump(mode="json"),
        "stock_sha256": stock.snapshot.sha256,
        "features": [
            {"element_path": path, "kind": element.kind, "label": element.label}
            for path, element in elements.items()
        ],
        "body_revisions": [
            {"revision_id": str(rid), "sha256": revision.snapshot.sha256}
            for rid, revision in bodies.items()
        ],
        "authority": "human_preparation_intent",
        "physical_qualification": "not_evaluated",
    }
