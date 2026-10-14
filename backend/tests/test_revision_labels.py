"""Display names for exact revisions follow current read authority and never leak."""

import uuid

import pytest

from specmate.access.models import WorkspaceMember
from specmate.operations import ValidationFailed

from .conftest import op, remove_member
from .scope_helpers import workspace_of
from .test_catalog_discovery import create_foreign_part, create_part
from .test_design import freeze
from .test_transports import api


def labels(user, *revision_ids):
    return op(user, "catalog.revision_labels", {"revision_ids": list(revision_ids)})["labels"]


def two_revisions(owner, project):
    item = create_part(owner, project, "Labelled bracket")
    first = freeze(owner, item["draft_id"], item["state"])
    update = op(
        owner,
        "draft.update",
        {"draft_id": item["draft_id"], "changes": {"description": "Second"}},
        expected_state=first["draft"]["state"],
    )
    return first, freeze(owner, item["draft_id"], update["state"])


def test_reader_gets_name_kind_and_number_in_request_order(users, project):
    first, second = two_revisions(users["owner"], project)
    rows = labels(users["viewer"], second["revision_id"], first["revision_id"])
    assert [r["revision_id"] for r in rows] == [second["revision_id"], first["revision_id"]]
    assert [r["number"] for r in rows] == [2, 1]
    assert all(r["readable"] and r["name"] == "Labelled bracket" for r in rows)
    assert all(r["kind"] == "part" for r in rows)


def test_outsider_and_missing_revisions_are_indistinguishable(users, project):
    first, _ = two_revisions(users["owner"], project)
    missing = str(uuid.uuid4())
    hidden = labels(users["outsider"], first["revision_id"], missing)
    assert hidden == [
        {"revision_id": first["revision_id"], "readable": False},
        {"revision_id": missing, "readable": False},
    ]
    WorkspaceMember.objects.filter(workspace__projects=project, user=users["viewer"]).delete()
    assert labels(users["viewer"], first["revision_id"]) == hidden[:1]


def test_workspace_labels_readable_and_foreign_or_lost_scope_indistinguishable(
    users, project, other_workspace
):
    owner = users["owner"]
    second = op(owner, "project.create", {"name": "Other bench"})["project_id"]
    dependency = create_part(owner, second, "Library dependency")
    library_revision = freeze(owner, dependency["draft_id"], dependency["state"])
    parent = create_part(owner, project, "Parent with library pin")
    pinned = freeze(owner, parent["draft_id"], parent["state"], [library_revision["revision_id"]])
    foreign = create_foreign_part(users, other_workspace)
    rows = labels(
        users["viewer"],
        library_revision["revision_id"],
        pinned["revision_id"],
        foreign["revision_id"],
        str(uuid.uuid4()),
    )
    assert [r["readable"] for r in rows] == [True, True, False, False]
    assert [r["name"] for r in rows[:2]] == ["Library dependency", "Parent with library pin"]
    assert all(set(r) == {"revision_id", "readable"} for r in rows[2:])
    remove_member(users["viewer"])
    lost = labels(users["viewer"], pinned["revision_id"])
    assert lost == [{"revision_id": pinned["revision_id"], "readable": False}]


def test_payload_is_bounded_and_unique_and_http_shares_the_operation(users, project):
    first, _ = two_revisions(users["owner"], project)
    rid = first["revision_id"]
    with pytest.raises(ValidationFailed):
        labels(users["owner"], rid, rid)
    with pytest.raises(ValidationFailed):
        labels(users["owner"])
    response = api(users["viewer"]).get(
        "/api/v0/catalog/revision-labels", {"revision_ids": [rid, str(uuid.uuid4())]}
    )
    assert response.status_code == 200
    body = response.json()["labels"]
    assert body[0]["name"] == "Labelled bracket" and body[1]["readable"] is False
    anonymous = api().get("/api/v0/catalog/revision-labels", {"revision_ids": [rid]})
    assert anonymous.status_code == 401


def source_label_rows(user, *ids):
    return op(user, "catalog.revision_labels", {"source_revision_ids": list(ids)})["source_labels"]


def test_source_revision_names_follow_source_read_authority(users, project):
    from .test_sources import ORIGINAL, files, register

    owner = users["owner"]
    register(owner, project, ORIGINAL)
    original = op(
        owner,
        "source.create_original_bundle",
        {
            "workspace_id": workspace_of(project),
            "name": "Labelled source",
            "files": files(ORIGINAL),
        },
    )
    revision_id = original["revision_id"]
    row = source_label_rows(users["viewer"], revision_id)[0]
    assert row["readable"] and row["name"] == "Labelled source"
    assert row["kind"] == "original" and row["number"] == 1
    missing = str(uuid.uuid4())
    hidden = source_label_rows(users["outsider"], revision_id, missing)
    assert hidden == [
        {"revision_id": revision_id, "readable": False},
        {"revision_id": missing, "readable": False},
    ]
    both = op(
        users["viewer"],
        "catalog.revision_labels",
        {"revision_ids": [revision_id], "source_revision_ids": [revision_id]},
    )
    # The two identifier namespaces are distinct: a source ID is not a design revision.
    assert both["labels"] == [{"revision_id": revision_id, "readable": False}]
    assert both["source_labels"][0]["readable"] is True


def test_label_lookup_queries_do_not_grow_with_the_number_of_labels(users, project):
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    owner = users["owner"]
    ids = []
    for index in range(12):
        item = create_part(owner, project, f"Labelled part {index}")
        ids.append(freeze(owner, item["draft_id"], item["state"])["revision_id"])
    with CaptureQueriesContext(connection) as one:
        labels(users["viewer"], ids[0])
    with CaptureQueriesContext(connection) as many:
        result = labels(users["viewer"], *ids)
    assert all(row["readable"] for row in result)
    revision_reads = [
        q
        for q in many.captured_queries
        if q["sql"].split(" FROM ")[-1].startswith('"design_revision" INNER')
    ]
    assert len(revision_reads) <= 1  # one batched read, not one per label
    # Authorization is still checked per label, with a bounded per-label cost.
    assert len(many.captured_queries) <= len(one.captured_queries) + 3 * 11 + 2
