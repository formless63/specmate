"""Display names for exact revisions follow current read authority and never leak."""

import uuid

import pytest

from specmate.access.models import WorkspaceMember
from specmate.operations import ValidationFailed

from .conftest import op
from .test_catalog_discovery import create_part
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


def test_cross_project_dependency_hides_parent_name_but_not_other_labels(users, project):
    owner = users["owner"]
    remote = op(owner, "project.create", {"name": "Other private bench"})["project_id"]
    dependency = create_part(owner, remote, "Remote dependency")
    remote_revision = freeze(owner, dependency["draft_id"], dependency["state"])
    parent = create_part(owner, project, "Parent with remote pin")
    pinned = freeze(owner, parent["draft_id"], parent["state"], [remote_revision["revision_id"]])
    plain = create_part(owner, project, "Plain readable")
    readable = freeze(owner, plain["draft_id"], plain["state"])
    rows = labels(
        users["viewer"],
        remote_revision["revision_id"],
        pinned["revision_id"],
        readable["revision_id"],
    )
    assert [r["readable"] for r in rows] == [False, False, True]
    assert all(set(r) == {"revision_id", "readable"} for r in rows[:2])
    assert rows[2]["name"] == "Plain readable"
    assert labels(owner, pinned["revision_id"])[0]["name"] == "Parent with remote pin"


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
        {"project_id": project, "name": "Labelled source", "files": files(ORIGINAL)},
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
