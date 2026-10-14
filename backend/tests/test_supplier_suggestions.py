"""Exact asserted supplier identifiers suggest human review without identity merging."""

from uuid import UUID

import pytest

from specmate.catalog_matching import suppliers
from specmate.catalog_matching.models import MatchCandidate, MatchReview
from specmate.design.models import Draft, Snapshot
from specmate.operations import NotFound, Unauthenticated, ValidationFailed

from .conftest import op
from .scope_helpers import workspace_of
from .test_design import freeze
from .test_transports import api, post_op


@pytest.fixture
def pair(users, project, definition):
    source = freeze(users["owner"], definition["draft_id"], definition["state"])
    target = op(
        users["owner"],
        "definition.create",
        {
            "workspace_id": workspace_of(project),
            "name": "Independent supplier target",
            "kind": "part",
        },
    )
    return source, freeze(users["owner"], target["draft_id"], target["state"])


def variant(users, revision, *, manufacturer="Synthetic maker", part_number="SYN-PAIR", **extra):
    return op(
        users["owner"],
        "catalog.register_variant",
        {
            "revision_id": revision["revision_id"],
            "manufacturer": manufacturer,
            "part_number": part_number,
            "association_basis": "Synthetic unverified catalog assertion.",
            **extra,
        },
    )


@pytest.fixture
def associations(users, pair):
    source = variant(users, pair[0])
    target = variant(users, pair[1])
    return (
        source,
        target,
        {
            "source_revision_id": pair[0]["revision_id"],
            "source_variant_id": source["variant_id"],
        },
    )


def suggest(users, payload, actor="viewer", **context):
    return op(users[actor], "catalog.suggest_supplier_matches", payload, **context)


def test_exact_tuple_suggestions_preserve_identity_snapshots_and_no_reviews(
    users, pair, associations
):
    source, target, query = associations
    originals = {
        r["snapshot_id"]: bytes(Snapshot.objects.get(id=r["snapshot_id"]).canonical) for r in pair
    }
    result = suggest(users, query)
    assert result["meaning"] == "identifier_suggestions_only"
    assert result["source"]["revision_id"] == pair[0]["revision_id"]
    assert len(result["results"]) == 1
    row = result["results"][0]
    assert row["source_variant_id"] == source["variant_id"]
    assert row["target_variant_id"] == target["variant_id"]
    assert row["target"]["revision_id"] == pair[1]["revision_id"]
    assert row["target"]["definition_id"] != result["source"]["definition_id"]
    assert row["match_basis"] == "exact_manufacturer_and_part_number"
    assert row["review"] == "not_reviewed" and row["compatibility"] == "not_evaluated"
    assert row["source_association_basis"] == source["association_basis"]
    assert row["target_association_basis"] == target["association_basis"]
    assert not MatchCandidate.objects.exists() and not MatchReview.objects.exists()
    assert all(
        bytes(Snapshot.objects.get(id=key).canonical) == value for key, value in originals.items()
    )


def test_exact_pair_has_no_case_folding_part_only_or_same_definition_merge(
    users, pair, associations
):
    _, _, query = associations
    assert suggest(users, query)["results"]
    for changes in [
        {"manufacturer": "synthetic maker"},
        {"part_number": "syn-pair"},
        {"manufacturer": "Other synthetic maker"},
    ]:
        alternative = variant(users, pair[1], **changes)
        assert alternative["variant_id"] not in {
            r["target_variant_id"] for r in suggest(users, query)["results"]
        }
    own = variant(users, pair[0], manufacturer="Source-only maker")
    assert suggest(users, {**query, "source_variant_id": own["variant_id"]})["results"] == []


def test_supplied_association_and_cursor_must_match_the_exact_current_query(
    users, pair, associations
):
    _, target, query = associations
    with pytest.raises(NotFound):
        suggest(users, {**query, "source_variant_id": target["variant_id"]})
    other = variant(users, pair[1], manufacturer="Other maker")
    with pytest.raises(NotFound):
        suggest(users, {**query, "after": other["variant_id"]})
    with pytest.raises(NotFound):
        suggest(users, {**query, "after": str(UUID(int=0))})
    with pytest.raises(ValidationFailed):
        suggest(users, {**query, "limit": 0})
    with pytest.raises(NotFound):
        suggest(users, query, actor="outsider")


def foreign_target(users):
    """An identically labelled revision in the outsider's separate workspace."""
    child = op(
        users["outsider"],
        "definition.create",
        {"name": "Foreign target", "kind": "part"} | {"workspace_id": foreign_workspace_id(users)},
    )
    return freeze(users["outsider"], child["draft_id"], child["state"])


def foreign_workspace_id(users):
    from specmate.access.models import WorkspaceMember

    return str(WorkspaceMember.objects.get(user=users["outsider"]).workspace_id)


def foreign_variant(users, revision):
    return op(
        users["outsider"],
        "catalog.register_variant",
        {
            "revision_id": revision["revision_id"],
            "manufacturer": "Synthetic maker",
            "part_number": "SYN-PAIR",
            "association_basis": "Synthetic unverified catalog assertion.",
        },
    )


def test_same_workspace_reuse_and_foreign_workspace_never_suggested(
    users, project, workspace, associations
):
    _, target, query = associations
    result = suggest(users, query)
    assert result["workspace_id"] == workspace
    # A second same-workspace definition with the exact pair is suggested to every member.
    reused = op(
        users["owner"],
        "definition.create",
        {"workspace_id": workspace_of(project), "name": "Library reuse target", "kind": "part"},
    )
    reused_revision = freeze(users["owner"], reused["draft_id"], reused["state"])
    second = variant(users, reused_revision)
    assert {r["target_variant_id"] for r in suggest(users, query)["results"]} == {
        target["variant_id"],
        second["variant_id"],
    }
    # The outsider's identical assertion stays invisible, and is no cursor.
    hidden = foreign_variant(users, foreign_target(users))
    assert hidden["variant_id"] not in {
        r["target_variant_id"] for r in suggest(users, query, actor="owner")["results"]
    }
    with pytest.raises(NotFound):
        suggest(users, {**query, "after": hidden["variant_id"], "limit": 0})


def test_foreign_source_and_wrong_association_are_not_found_before_diagnostics(users, associations):
    _, _, query = associations
    foreign = foreign_target(users)
    hidden = foreign_variant(users, foreign)
    for changes in [
        {"source_revision_id": foreign["revision_id"]},
        {"source_variant_id": hidden["variant_id"]},
    ]:
        with pytest.raises(NotFound):
            suggest(users, {**query, **changes, "limit": 0})


def test_page_continuations_and_explicit_inspection_bound(users, pair, associations, monkeypatch):
    _, target, query = associations
    second = variant(users, pair[0], manufacturer="Second maker", part_number="SECOND")
    # Repeating the same pair on a second exact revision remains a separate candidate.
    draft = Draft.objects.get(base_revision_id=pair[1]["revision_id"])
    later = freeze(users["owner"], str(draft.id), draft.state_token)
    other = variant(users, later)
    page = suggest(users, {**query, "limit": 1})
    assert len(page["results"]) == 1 and page["next_after"]
    next_page = suggest(users, {**query, "limit": 1, "after": page["next_after"]})
    assert {
        page["results"][0]["target_variant_id"],
        next_page["results"][0]["target_variant_id"],
    } == {target["variant_id"], other["variant_id"]}
    assert next_page["next_after"] is None
    monkeypatch.setattr(suppliers, "MAX_INSPECTED_VARIANTS", 1)
    bounded = suggest(users, query)
    assert bounded["inspection_truncated"] is True and len(bounded["results"]) == 1
    assert bounded["next_after"] == bounded["results"][0]["target_variant_id"]
    assert second["variant_id"] not in {r["target_variant_id"] for r in bounded["results"]}


def test_http_jobs_and_current_actor_match_shared_read_authority(users, associations):
    _, _, query = associations
    expected = suggest(users, query, actor="owner")
    client = api(users["owner"])
    response = client.get(
        f"/api/v0/catalog-matching/revisions/{query['source_revision_id']}/supplier-suggestions",
        {"source_variant_id": query["source_variant_id"]},
    )
    assert response.status_code == 200 and response.json() == expected
    assert (
        post_op(client, "catalog.suggest_supplier_matches", query, idempotency_key=None).status_code
        == 200
    )
    users["owner"].is_active = False
    users["owner"].save(update_fields=["is_active"])
    with pytest.raises(Unauthenticated):
        suggest(users, query, actor="owner")
