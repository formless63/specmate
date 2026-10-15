"""Library search: ranked, bounded, workspace-scoped reads for the command palette."""

import pytest

from specmate.catalog.models import ManufacturerVariant, SourceIdentifier
from specmate.design.models import Draft, Revision
from specmate.operations import NotFound, PermissionDenied, ValidationFailed

from .conftest import op
from .test_project_references import part
from .test_transports import api, post_op


def search(user, query, **payload):
    return op(user, "library.search", {"query": query, **payload})


def labels(page):
    return [row["label"] for row in page["results"]]


def test_name_matches_rank_exact_then_prefix_then_substring(users, workspace):
    owner = users["owner"]
    for name in ("Big coax stock", "Coax", "Coaxial RG59", "Unrelated"):
        part(owner, workspace, name)
    page = search(users["viewer"], "coax")
    assert labels(page) == ["Coax", "Coaxial RG59", "Big coax stock"]
    assert [row["match"]["rank"] for row in page["results"]] == [0, 1, 2]
    assert all(row["match"]["field"] == "name" for row in page["results"])
    assert not page["truncated"]


def test_part_numbers_identifiers_and_kind_find_the_item(users, workspace):
    owner = users["owner"]
    item = part(owner, workspace, "Round shell", freeze=True)
    revision = Revision.objects.get(id=item["revision_id"])
    ManufacturerVariant.objects.create(
        revision=revision,
        manufacturer="Acme",
        part_number="AC-1234-X",
        association_basis="b",
        registered_by_id=owner.id,
    )
    SourceIdentifier.objects.create(
        revision=revision,
        rights_status="unknown",
        scheme="url",
        identifier="https://x.test/DS-77",
        label="Datasheet",
        rights="unknown",
        registered_by_id=owner.id,
    )
    by_pn = search(users["viewer"], "ac-1234")["results"]
    assert [(row["label"], row["match"]["field"], row["match"]["text"]) for row in by_pn] == [
        ("Round shell", "part_number", "AC-1234-X")
    ]
    assert by_pn[0]["match"]["rank"] == 1
    assert (
        by_pn[0]["latest_revision"] == 1 and by_pn[0]["latest_revision_id"] == item["revision_id"]
    )
    assert search(users["viewer"], "ds-77")["results"][0]["match"]["field"] == "identifier"
    by_kind = search(users["viewer"], "part")["results"]
    assert (
        by_kind and by_kind[0]["match"]["field"] == "kind" and by_kind[0]["match"]["text"] == "part"
    )


def test_connector_family_matches_frozen_and_draft_content(users, workspace):
    owner = users["owner"]
    din = op(
        owner,
        "definition.create",
        {"workspace_id": workspace, "kind": "connector_body", "name": "Console plug"},
    )
    Draft.objects.filter(id=din["draft_id"]).update(content={"family": "10-pin round DIN"})
    page = search(users["viewer"], "round din")
    assert [(r["label"], r["match"]["field"], r["match"]["rank"]) for r in page["results"]] == [
        ("Console plug", "connector_family", 2)
    ]
    assert search(users["viewer"], "scart")["results"] == []


def test_results_are_bounded_and_say_so(users, workspace):
    for index in range(5):
        part(users["owner"], workspace, f"Cable {index}")
    page = search(users["viewer"], "cable", limit=3)
    assert len(page["results"]) == 3 and page["truncated"]
    with pytest.raises(ValidationFailed):
        search(users["viewer"], "")
    with pytest.raises(ValidationFailed):
        search(users["viewer"], "x", limit=26)


def test_search_is_workspace_scoped_and_needs_read_access(users, workspace):
    part(users["owner"], workspace, "Private coax")
    foreign = op(users["outsider"], "project.create", {"name": "Foreign bench"})
    part(users["outsider"], foreign["workspace_id"], "Foreign coax")
    assert labels(search(users["viewer"], "coax")) == ["Private coax"]
    assert labels(search(users["outsider"], "coax")) == ["Foreign coax"]
    with pytest.raises((NotFound, PermissionDenied)):
        search(users["outsider"], "coax", workspace_id=workspace)
    assert post_op(api(), "library.search", {"query": "coax"}).status_code in (401, 403)
