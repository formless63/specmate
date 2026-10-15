"""Selected-root document previews reuse authoritative projection without retaining artifacts."""

import pytest

from specmate.operations import NotFound, PermissionDenied
from specmate.operations.models import IdempotencyRecord
from specmate.preparation_documents.models import DocumentOutput, DocumentSet

from .conftest import ensure_member, op, remove_member
from .test_preparation import cable, evidence, profile
from .test_preparation import create as create_cuts
from .test_preparation import freeze as freeze_cuts
from .test_preparation_documents import configuration
from .test_transports import api, post_op


def test_defaults_are_explicit_unknowns_and_exact_contexts_without_workspace_history(
    users, project
):
    _, root = cable(users["owner"], project)
    payload = {"root_revision_id": root["revision_id"]}
    before = IdempotencyRecord.objects.count()
    defaults = op(users["viewer"], "preparation_documents.defaults", payload)
    config = defaults["configuration"]
    assert config["root_revision_id"] == root["revision_id"]
    assert config["quantity"] == 1
    assert config["standalone_decision"] == "unknown"
    assert config["standalone_basis"] is None
    assert config["output_rights"] == "unknown"
    assert config["rights_reviews"] == [] and config["bindings"] == []
    assert config["bom_plan_revision_id"] is None
    assert "document_settings" not in config
    assert defaults["root"]["revision_id"] == root["revision_id"]
    assert defaults["context_pins"][0]["address"]["revision_id"] == root["revision_id"]
    assert defaults["context_pins"][0]["address"]["path"] == []
    assert defaults["rights_subjects"]
    response = post_op(api(users["viewer"]), "preparation_documents.defaults", payload)
    assert response.status_code == 200
    assert response.json()["result"] == defaults
    assert IdempotencyRecord.objects.count() == before
    assert not DocumentSet.objects.exists() and not DocumentOutput.objects.exists()
    remove_member(users["viewer"])
    with pytest.raises(NotFound):
        op(users["viewer"], "preparation_documents.defaults", payload)


def test_preview_matches_review_hash_and_keeps_authoritative_nullable_quantities(users, project):
    user = users["owner"]
    value, root = cable(user, project)
    recipe = freeze_cuts(user, create_cuts(user, project, profile(value["stock_revision_id"])))
    config = configuration(
        root,
        quantity=2,
        bindings=[{"cut_profiles": [{"profile_revision_id": recipe["revision_id"]}]}],
    )
    reviewed = op(user, "preparation_documents.review", config)
    before = IdempotencyRecord.objects.count()
    preview = op(users["viewer"], "preparation_documents.preview", config)
    assert preview["manifest"] == reviewed["manifest"]
    assert preview["state"] == reviewed["state"]
    rows = preview["sections"]["cut_preparation"]
    physical = next(row for row in rows if row["row_kind"] == "declared_physical_piece")
    assert physical["design_piece_count"] == 2
    assert physical["design_total_mm"] == "2140"
    assert preview["sections"]["terminations"][0]["design_assignment_count"] == 4
    response = post_op(api(users["viewer"]), "preparation_documents.preview", config)
    assert response.status_code == 200 and response.json()["result"] == preview
    unknown = op(user, "preparation_documents.preview", {**config, "quantity": None})
    physical = next(
        row
        for row in unknown["sections"]["cut_preparation"]
        if row["row_kind"] == "declared_physical_piece"
    )
    assert physical["design_piece_count"] is None and physical["design_total_mm"] is None
    assert IdempotencyRecord.objects.count() == before
    assert not DocumentSet.objects.exists() and not DocumentOutput.objects.exists()


def test_preview_reauthorizes_supplementary_source_closure_before_returning_cached_rows(
    users, project
):
    user = users["owner"]
    value, root = cable(user, project)
    foreign = op(user, "project.create", {"name": "Synthetic preview source owner"})["project_id"]
    _, source = evidence(user, foreign)
    rules = profile(value["stock_revision_id"])
    rules["formulas"][0]["allowances"][0]["source"] = source
    recipe = freeze_cuts(user, create_cuts(user, project, rules))
    config = configuration(
        root, bindings=[{"cut_profiles": [{"profile_revision_id": recipe["revision_id"]}]}]
    )
    preview = op(user, "preparation_documents.preview", config)
    remove_member(user, project=foreign)
    with pytest.raises((NotFound, PermissionDenied)):
        op(user, "preparation_documents.preview", config)
    assert post_op(api(user), "preparation_documents.preview", config).status_code in (403, 404)
    ensure_member(user, "owner", project=foreign)
    assert op(user, "preparation_documents.preview", config) == preview
    assert not DocumentSet.objects.exists() and not DocumentOutput.objects.exists()
