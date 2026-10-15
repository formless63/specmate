"""Design list exact pins, pre-pagination filters, authority and batched reads."""

import json
import uuid

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from specmate.design.models import Definition, Draft, Revision, Snapshot
from specmate.operations import NotFound, ValidationFailed
from specmate.workspace.design_contracts import ListDesigns
from specmate.workspace.designs import list_designs

from .test_project_references import add
from .test_transports import api


def design(user, workspace, name, kind="cable", content=None, freeze=False):
    """Original minimal projection fixtures, without unrelated engineering setup."""
    definition = Definition.objects.create(
        workspace_id=workspace, kind=kind, name=name, created_by=user
    )
    draft = Draft.objects.create(definition=definition, content=content or {}, updated_by=user)
    revision = None
    if freeze:
        canonical = json.dumps({"content": draft.content}).encode()
        snapshot = Snapshot.objects.create(
            definition=definition,
            draft=draft,
            draft_version=1,
            canonical=canonical,
            sha256="0" * 64,
            created_by=user,
        )
        revision = Revision.objects.create(
            definition=definition, snapshot=snapshot, number=1, frozen_by=user
        )
    return definition, draft, revision


def page(user, **params):
    return list_designs(user, ListDesigns(**params))


def labels(result):
    return [row["label"] for row in result["results"]]


def test_exact_frozen_projection_wins_over_later_draft_and_resolves_intent_and_nested_boards(
    users, workspace
):
    owner = users["owner"]
    stock, _, sr = design(owner, workspace, "Blue stock", "wire_stock", freeze=True)
    board, _, br = design(owner, workspace, "Small adapter", "board", freeze=True)
    _, _, er = design(
        owner,
        workspace,
        "Board end",
        "end_assembly",
        {"interface": {"stack": {"layers": [{"board_revision_id": str(br.id)}]}}},
        True,
    )
    _, _, fr = design(owner, workspace, "Source output", "port", freeze=True)
    _, _, tr = design(owner, workspace, "Destination input", "port", freeze=True)
    _, _, ir = design(
        owner,
        workspace,
        "Connection goal",
        "cable_intent",
        {"interface": {"from_revision_id": str(fr.id), "to_revision_id": str(tr.id)}},
        True,
    )
    cable, draft, cr = design(
        owner,
        workspace,
        "Blue cable",
        content={
            "cable": {
                "stock_revision_id": str(sr.id),
                "intent_revision_id": str(ir.id),
                "review": "reviewed",
                "endpoints": [
                    {"end_assembly_revision_id": str(er.id), "label": "A"},
                    {"label": "B"},
                ],
            }
        },
        freeze=True,
    )
    draft.content = {"cable": {"review": "unreviewed"}}
    draft.save()
    result = page(users["viewer"])["results"][0]
    assert result["record_id"] == str(cable.id)
    metadata = result["design"]
    assert metadata["basis"] == "latest_frozen" and metadata["revision_id"] == str(cr.id)
    assert metadata["draft_id"] is None and metadata["review"] == "reviewed"
    assert metadata["from"] == {
        "label": "Source output",
        "basis": "intent_port",
        "revision_id": str(fr.id),
    }
    assert metadata["to"]["label"] == "Destination input"
    assert metadata["stocks"] == [
        {
            "definition_id": str(stock.id),
            "revision_id": str(sr.id),
            "revision": 1,
            "label": "Blue stock",
        }
    ]
    assert metadata["boards"] == [
        {
            "definition_id": str(board.id),
            "revision_id": str(br.id),
            "revision": 1,
            "label": "Small adapter",
        }
    ]
    assert metadata["checks"] == "not_evaluated"


def test_filters_apply_before_pagination_and_cursor_traverses_matches(users, workspace, project):
    owner = users["owner"]
    _, _, sr = design(owner, workspace, "Braided stock", "wire_stock", freeze=True)
    first, _, _ = design(
        owner,
        workspace,
        "Match one",
        content={
            "cable": {
                "stock_revision_id": str(sr.id),
                "review": "unreviewed",
                "endpoints": [{"label": "Source"}, {"label": "Sink"}],
            }
        },
    )
    design(
        owner,
        workspace,
        "Match two",
        content={
            "cable": {
                "stock_revision_id": str(sr.id),
                "review": "unreviewed",
                "endpoints": [{"label": "Source"}, {"label": "Sink"}],
            }
        },
    )
    for i in range(4):
        design(owner, workspace, f"Other {i}", kind="assembly")
    params = {
        "q": "match",
        "kind": "cable",
        "from": "sour",
        "to": "sink",
        "stock": "braid",
        "status": "draft_only",
        "limit": 1,
    }
    one = page(users["viewer"], **params)
    assert labels(one) == ["Match two"] and one["next_after"]
    two = page(users["viewer"], **params, after=one["next_after"])
    assert labels(two) == ["Match one"] and two["next_after"] is None
    add(owner, project, "definition", str(first.id))
    assert labels(page(users["viewer"], project_id=project)) == ["Match one"]
    assert labels(page(users["viewer"], status="unreviewed")) == ["Match two", "Match one"]
    assert page(users["viewer"], status="frozen")["results"] == []
    assert labels(page(users["viewer"], status="unknown")) == [
        "Other 3",
        "Other 2",
        "Other 1",
        "Other 0",
    ]


def test_unknowns_are_not_passes_and_query_count_does_not_grow_with_rows(users, workspace):
    owner = users["owner"]
    design(owner, workspace, "Untyped draft", kind="harness")
    with CaptureQueriesContext(connection) as small:
        row = page(users["viewer"])["results"][0]
    assert row["design"]["from"] == {"label": None, "basis": "unknown", "revision_id": None}
    assert row["design"]["stocks"] == row["design"]["boards"] == []
    assert row["design"]["review"] == "unknown"
    for i in range(8):
        design(owner, workspace, f"More {i}", kind="assembly")
    with CaptureQueriesContext(connection) as large:
        result = page(users["viewer"])
    assert len(result["results"]) == 9
    assert len(large) == len(small)


def test_authority_contracts_and_http(users, workspace, other_workspace, project):
    design(users["owner"], workspace, "Shared loom", "harness")
    response = api(users["viewer"]).get("/api/v0/workspace/designs", {"kind": "harness"})
    assert response.status_code == 200 and labels(response.json()) == ["Shared loom"]
    assert api().get("/api/v0/workspace/designs").status_code == 401
    with pytest.raises(NotFound) as hidden:
        page(users["outsider"], workspace_id=workspace)
    with pytest.raises(NotFound) as missing:
        page(users["outsider"], workspace_id=uuid.uuid4())
    assert str(hidden.value) == str(missing.value)
    with pytest.raises(NotFound):
        page(users["outsider"], project_id=project)
    with pytest.raises(ValidationFailed):
        page(users["viewer"], after="invalid")
    assert (
        api(users["viewer"]).get("/api/v0/workspace/designs", {"kind": "part"}).status_code == 422
    )


def test_board_filter_newest_draft_and_latest_revision_are_exact(users, workspace):
    owner = users["owner"]
    _, _, board = design(owner, workspace, "Carrier 100%", "board", freeze=True)
    root, old, _ = design(owner, workspace, "Newer content", kind="assembly")
    new = Draft.objects.create(
        definition=root,
        content={"assembly": {"occurrences": [{"revision_id": str(board.id)}]}},
        updated_by=owner,
    )
    design(owner, workspace, "Unrelated newer row", kind="assembly")
    row = page(users["viewer"], board="100%", limit=1)["results"][0]
    assert row["label"] == "Newer content"
    assert row["design"]["draft_id"] == str(new.id)
    assert row["design"]["boards"][0]["revision_id"] == str(board.id)
    # Literal '%' search cannot match every board, and a newer draft is authoritative
    # only while no frozen revision exists.
    assert page(users["viewer"], board="100_")["results"] == []
    snapshot = Snapshot.objects.create(
        definition=root,
        draft=old,
        draft_version=1,
        canonical=json.dumps({"content": {"assembly": {"occurrences": []}}}).encode(),
        sha256="1" * 64,
        created_by=owner,
    )
    Revision.objects.create(definition=root, snapshot=snapshot, number=1, frozen_by=owner)
    assert page(users["viewer"], board="Carrier")["results"] == []


def test_cross_workspace_pins_never_resolve_names(users, workspace, other_workspace):
    _, _, foreign = design(
        users["outsider"],
        other_workspace,
        "Foreign board",
        "board",
        freeze=True,
    )
    design(
        users["owner"],
        workspace,
        "Partial assembly",
        "assembly",
        {
            "assembly": {"occurrences": [{"revision_id": str(foreign.id)}]},
        },
    )
    row = page(users["viewer"])["results"][0]
    assert row["design"]["boards"] == []
    assert page(users["viewer"], board="Foreign")["results"] == []


@pytest.mark.parametrize("already_frozen", [False, True])
def test_competing_freeze_keeps_labels_and_metadata_on_the_selected_state(
    users, workspace, monkeypatch, already_frozen
):
    """Insert a real revision at the precise interleaving between the two read queries."""
    from specmate.workspace import designs

    owner = users["owner"]
    definition, draft, selected_revision = design(
        owner,
        workspace,
        "Changing cable",
        content={"cable": {"review": "unreviewed"}},
        freeze=already_frozen,
    )
    original_definitions = designs._definitions
    competing = []

    def freeze_before_label_read(*args):
        # A freeze committed by another request after the metadata SELECT would be
        # visible to this second read under READ COMMITTED. Reproduce that ordering
        # deterministically with actual database rows, without thread scheduling.
        draft.content = {"cable": {"review": "reviewed", "review_basis": "Synthetic review"}}
        draft.version += 1
        draft.save()
        snapshot = Snapshot.objects.create(
            definition=definition,
            draft=draft,
            draft_version=draft.version,
            canonical=json.dumps({"content": draft.content}).encode(),
            sha256="2" * 64,
            created_by=owner,
        )
        competing.append(
            Revision.objects.create(
                definition=definition,
                snapshot=snapshot,
                number=2 if already_frozen else 1,
                frozen_by=owner,
            )
        )
        return original_definitions(*args)

    monkeypatch.setattr(designs, "_definitions", freeze_before_label_read)
    row = page(users["viewer"], status="unreviewed")["results"][0]
    assert len(competing) == 1
    assert Revision.objects.filter(definition=definition).count() == (2 if already_frozen else 1)
    expected_number = selected_revision.number if selected_revision else None
    expected_id = str(selected_revision.id) if selected_revision else None
    assert row["latest_revision"] == row["design"]["revision"] == expected_number
    assert row["latest_revision_id"] == row["design"]["revision_id"] == expected_id
    assert row["design"]["review"] == "unreviewed"
    assert row["design"]["basis"] == ("latest_frozen" if already_frozen else "newest_draft")
    assert row["design"]["draft_id"] == (None if already_frozen else str(draft.id))
