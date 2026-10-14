"""Revision changes offer scoped impact evidence while existing pins remain immutable."""

import pytest

from specmate.design.models import Snapshot
from specmate.operations import NotFound, ValidationFailed

from .conftest import op, remove_member
from .test_catalog_discovery import create_foreign_part, create_part
from .test_design import freeze
from .test_transports import api


def revisions(owner, project):
    item = create_part(owner, project, "Revisioned bracket")
    old = freeze(owner, item["draft_id"], item["state"])
    update = op(
        owner,
        "draft.update",
        {"draft_id": item["draft_id"], "changes": {"description": "Revised mounting pattern"}},
        expected_state=old["draft"]["state"],
    )
    new = freeze(owner, item["draft_id"], update["state"])
    return old, new


def test_impact_keeps_existing_snapshot_bytes_and_pins_and_shares_http(users, project):
    owner = users["owner"]
    old, new = revisions(owner, project)
    parent = create_part(owner, project, "Retained consumer")
    frozen = freeze(owner, parent["draft_id"], parent["state"], [old["revision_id"]])
    snapshot = Snapshot.objects.get(id=frozen["snapshot_id"])
    before = bytes(snapshot.canonical)
    payload = {"revision_id": old["revision_id"], "candidate_revision_id": new["revision_id"]}
    result = op(users["viewer"], "catalog.revision_impact", payload)
    assert result["current_number"] == 1 and result["candidate_number"] == 2
    assert result["content_changed"] is True
    assert result["dependency_pins_changed"] is False
    assert result["adoption"] == "new_owning_draft_required"
    assert result["compatibility"] == "not_evaluated"
    assert result["existing_pins"] == "retained"
    assert [row["snapshot_id"] for row in result["results"]] == [frozen["snapshot_id"]]
    snapshot.refresh_from_db()
    assert bytes(snapshot.canonical) == before
    assert list(map(str, snapshot.dependencies.values_list("revision_id", flat=True))) == [
        old["revision_id"]
    ]
    client = api(users["viewer"])
    response = client.get("/api/v0/catalog/revision-impact", payload)
    assert response.status_code == 200 and response.json() == result
    assert api(users["outsider"]).get("/api/v0/catalog/revision-impact", payload).status_code == 404


def test_impact_authorizes_candidate_before_comparison_and_rechecks_cursor(
    users, project, other_workspace
):
    owner, viewer = users["owner"], users["viewer"]
    old, new = revisions(owner, project)
    foreign = create_foreign_part(users, other_workspace)
    with pytest.raises(NotFound):
        op(
            viewer,
            "catalog.revision_impact",
            {"revision_id": old["revision_id"], "candidate_revision_id": foreign["revision_id"]},
        )
    for candidate in (old["revision_id"],):
        with pytest.raises(ValidationFailed):
            op(
                viewer,
                "catalog.revision_impact",
                {"revision_id": old["revision_id"], "candidate_revision_id": candidate},
            )
    wrong = create_part(owner, project, "Different identity")
    wrong_revision = freeze(owner, wrong["draft_id"], wrong["state"])
    with pytest.raises(ValidationFailed):
        op(
            viewer,
            "catalog.revision_impact",
            {
                "revision_id": old["revision_id"],
                "candidate_revision_id": wrong_revision["revision_id"],
            },
        )
    # A consumer that also pins a revision created from another project is a normal use.
    other = op(owner, "project.create", {"name": "Library source scope"})["project_id"]
    library_part = create_part(owner, other, "Library candidate")
    library = freeze(owner, library_part["draft_id"], library_part["state"])
    parents = []
    for index, deps in enumerate(
        ([old["revision_id"]], [old["revision_id"], library["revision_id"]])
    ):
        part = create_part(owner, project, f"Consumer {index}")
        parents.append(freeze(owner, part["draft_id"], part["state"], deps))
    expected = sorted(parent["snapshot_id"] for parent in parents)
    payload = {
        "revision_id": old["revision_id"],
        "candidate_revision_id": new["revision_id"],
        "limit": 1,
    }
    result = op(viewer, "catalog.revision_impact", payload)
    assert [row["snapshot_id"] for row in result["results"]] == expected[:1]
    assert result["next_after"] == expected[0]
    rest = op(viewer, "catalog.revision_impact", {**payload, "after": result["next_after"]})
    assert [row["snapshot_id"] for row in rest["results"]] == expected[1:]
    with pytest.raises(NotFound):
        op(viewer, "catalog.revision_impact", {**payload, "after": foreign["snapshot_id"]})
    remove_member(viewer)
    with pytest.raises(NotFound):
        op(viewer, "catalog.revision_impact", payload)


def test_same_content_revision_is_not_a_semantic_content_change(users, project):
    part = create_part(users["owner"], project, "Unchanged bracket")
    old = freeze(users["owner"], part["draft_id"], part["state"])
    new = freeze(users["owner"], part["draft_id"], old["draft"]["state"])
    result = op(
        users["viewer"],
        "catalog.revision_impact",
        {"revision_id": old["revision_id"], "candidate_revision_id": new["revision_id"]},
    )
    assert result["content_changed"] is False
    assert result["current_sha256"] == result["candidate_sha256"]


def test_membership_loss_denies_even_an_invalid_comparison(users, project):
    owner, viewer = users["owner"], users["viewer"]
    part = create_part(owner, project, "Candidate with controlled dependency")
    old = freeze(owner, part["draft_id"], part["state"])
    remote = op(owner, "project.create", {"name": "Controlled dependency project"})["project_id"]
    source = create_part(owner, remote, "Controlled source fixture")
    dependency = freeze(owner, source["draft_id"], source["state"])
    new = freeze(owner, part["draft_id"], old["draft"]["state"], [dependency["revision_id"]])
    payload = {"revision_id": old["revision_id"], "candidate_revision_id": new["revision_id"]}
    assert op(viewer, "catalog.revision_impact", payload)["dependency_pins_changed"] is True
    remove_member(viewer)
    with pytest.raises(NotFound):
        op(viewer, "catalog.revision_impact", payload)
    with pytest.raises(NotFound):
        op(
            viewer,
            "catalog.revision_impact",
            {
                "revision_id": old["revision_id"],
                "candidate_revision_id": new["revision_id"],
                "after": "00000000-0000-0000-0000-000000000000",
            },
        )
