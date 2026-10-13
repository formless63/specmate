"""Current source and review authority precedes passive-model diagnostics."""

import json
from types import SimpleNamespace

from pydantic import ValidationError

from specmate.access.permissions import Perm, authorize
from specmate.catalog_matching.operations import evidence_fields
from specmate.catalog_matching.queries import authorize_file, current_actor, evidence_result
from specmate.copper.contracts import ReadGraph
from specmate.copper.queries import inspect_graph
from specmate.operations import ValidationFailed
from specmate.passive_passages.contracts import PassageModel, validate_assignments
from specmate.passive_passages.interpretation import interpret
from specmate.passive_passages.models import PassageReview
from specmate.queries import get_revision


def parse_content(content, kind=None):
    if "passages" not in content:
        if kind == "passage_model":
            raise ValidationFailed("Typed passive model content is required.")
        return None
    try:
        model = PassageModel.model_validate(content["passages"])
    except ValidationError:
        raise ValidationFailed("Invalid passive model content.") from None
    if kind is not None and kind != "passage_model":
        raise ValidationFailed("Passive model content requires a passage_model definition.")
    return model


def validate_content(kind, content):
    model = parse_content(content, kind)
    return {**content, "passages": model.model_dump(mode="json")} if model else content


def closure(user, content, kind=None, *, validate=True):
    user = current_actor(user)
    model = parse_content(content, kind)
    if model is None:
        return None, None
    # All passage files and the complete owning graph before terminal/boundary diagnostics.
    for passage in model.passages:
        evidence_fields(user, passage.evidence)
    graph = inspect_graph(user, ReadGraph(revision_id=model.root_revision_id))
    if validate:
        nodes = {node["id"] for node in graph["nodes"]}
        boundaries = {b["id"]: b for b in graph["boundaries"]}
        for passage in model.passages:
            terminals = {passage.from_terminal_id, passage.to_terminal_id}
            if not terminals <= nodes:
                raise ValidationFailed(
                    "Passage terminals must belong to the exact pinned root graph."
                )
            if passage.native_candidate_boundary_id:
                candidate = boundaries.get(passage.native_candidate_boundary_id)
                if candidate is None or not terminals <= set(candidate["members"]):
                    raise ValidationFailed(
                        "A native candidate link must identify an exact boundary containing"
                        "both selected terminals."
                    )
    return model, graph


def dependency_revisions(user, definition, content):
    model, _ = closure(user, content, definition.kind)
    return [model.root_revision_id] if model else []


def authorize_content(user, definition, content):
    closure(user, content, definition.kind)


def rows(user, revision_id, *, edit=False, lock=False):
    user = current_actor(user)
    revision = get_revision(user, revision_id)
    if lock:
        # Frozen design rows are immutable, but provide a serialization lock for reviews.
        type(revision).objects.select_for_update(of=("self",)).get(id=revision.id)
    model, graph = closure(
        user,
        json.loads(bytes(revision.snapshot.canonical))["content"],
        revision.definition.kind,
        validate=False,
    )
    reviews = list(
        PassageReview.objects.filter(model_revision=revision)
        .select_related("source_file__revision__bundle", "source_file__blob")
        .order_by("version")
    )
    for review in reviews:
        authorize_file(user, review.source_file)
    if edit:
        authorize(user, revision.definition.project_id, Perm.DESIGN_EDIT)
    if model is None:
        raise ValidationFailed("Revision is not a typed passive model.")
    # References were authorized completely; semantic validation can now run safely.
    closure(user, {"passages": model.model_dump(mode="json")}, "passage_model")
    return revision, model, graph, reviews


def state(reviews):
    return f"passage-review-v{reviews[-1].version if reviews else 0}"


def assertion_evidence(user, model):
    return [
        {
            "local_id": passage.local_id,
            "evidence": evidence_result(
                SimpleNamespace(**evidence_fields(user, passage.evidence))
            ).model_dump(mode="json"),
        }
        for passage in model.passages
    ]


def result(user, revision_id):
    revision, model, graph, reviews = rows(user, revision_id)
    return {
        "revision_id": str(revision.id),
        "definition_id": str(revision.definition_id),
        "snapshot_id": str(revision.snapshot_id),
        "sha256": revision.snapshot.sha256,
        "model": model.model_dump(mode="json"),
        "assertion_evidence": assertion_evidence(user, model),
        "graph": graph,
        "state": state(reviews),
        "decision": reviews[-1].decision if reviews else "unreviewed",
        "reviews": [
            {
                "review_id": str(r.id),
                "version": r.version,
                "decision": r.decision,
                "basis": r.basis,
                "evidence": evidence_result(r).model_dump(mode="json"),
                "reviewed_by_id": r.reviewed_by_id,
                "reviewed_at": r.created_at.isoformat(),
            }
            for r in reviews
        ],
        "physical_qualification": "not_evaluated",
    }


def interpret_model(user, payload):
    revision, model, graph, reviews = rows(user, payload.revision_id)
    try:
        validate_assignments(model.model_dump(mode="json"), payload)
    except ValueError as exc:
        raise ValidationFailed(str(exc)) from None
    nodes = {n["id"] for n in graph["nodes"]}
    if payload.from_terminal_id not in nodes or payload.to_terminal_id not in nodes:
        raise ValidationFailed("Query terminals must belong to the model's exact pinned graph.")
    latest = reviews[-1] if reviews else None
    if latest is None or latest.decision != "accepted":
        return {
            "revision_id": str(revision.id),
            "sha256": revision.snapshot.sha256,
            "review_state": state(reviews),
            "query": payload.query,
            "status": "unknown",
            "reason": "current_accepted_model_review_required",
            "paths": [],
            "physical_continuity": "not_evaluated",
            "signal_transfer": "not_evaluated",
            "physical_qualification": "not_evaluated",
        }
    resolved_model = model.model_dump(mode="json")
    resolved_evidence = {
        row["local_id"]: row["evidence"] for row in assertion_evidence(user, model)
    }
    for passage in resolved_model["passages"]:
        passage["evidence"] = resolved_evidence[passage["local_id"]]
    return {
        "revision_id": str(revision.id),
        "sha256": revision.snapshot.sha256,
        "root_revision_id": str(model.root_revision_id),
        "root_snapshot_sha256": graph["snapshot_sha256"],
        "review_id": str(latest.id),
        "review_state": state(reviews),
        **interpret(graph, resolved_model, payload),
    }
