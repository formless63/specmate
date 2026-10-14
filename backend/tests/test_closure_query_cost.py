"""Closure authorization cost does not grow with part count; denial semantics stay exact.

Every workspace member reads the whole workspace and database guards keep pins inside
one workspace, so authorizing a closure needs one membership read and per-level batched
rows. Query counts are deterministic; elapsed time is not measured or promised.
"""

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext

from specmate.design.models import Snapshot
from specmate.design.operations import authorize_snapshot, authorize_snapshots
from specmate.export_packages import operations  # noqa: F401
from specmate.operations import NotFound
from specmate.queries import get_revision

from .conftest import op
from .test_assemblies import create, freeze, occ, part
from .test_bom import assembly as bom_assembly
from .test_bom import capture as bom_capture
from .test_bom import create as bom_create
from .test_bom import part as bom_part
from .test_catalog_discovery import create_foreign_part

# Allowed difference between a 3-part and a 12-part assembly (not per part).
SLACK = 2


def system(owner, project, size):
    parts = [part(owner, project, name=f"Synthetic part {size}-{i}")[1] for i in range(size)]
    root = freeze(
        owner, create(owner, project, [occ(f"p{i}", p, f"J{i}") for i, p in enumerate(parts)])
    )
    return parts, root


def queries(action):
    with CaptureQueriesContext(connection) as captured:
        action()
    return len(captured)


@pytest.fixture
def systems(users, project):
    return {size: system(users["owner"], project, size) for size in (3, 12)}


def snapshot(revision):
    return Snapshot.objects.select_related("definition").get(pk=revision["snapshot_id"])


def test_snapshot_authorization_cost_does_not_grow_with_parts(users, systems):
    viewer = users["viewer"]
    small, large = (snapshot(systems[size][1]) for size in (3, 12))
    cost = {
        "small": queries(lambda: authorize_snapshot(viewer, small)),
        "large": queries(lambda: authorize_snapshot(viewer, large)),
    }
    assert cost["large"] <= cost["small"] + SLACK, cost
    revision_cost = [
        queries(lambda size=size: get_revision(viewer, systems[size][1]["revision_id"]))
        for size in (3, 12)
    ]
    assert revision_cost[1] <= revision_cost[0] + SLACK, revision_cost


def test_export_review_closure_cost_does_not_grow_with_parts(users, systems):
    viewer = users["viewer"]

    def review(size):
        payload = {"root_revision_id": systems[size][1]["revision_id"], "quantity": 1}
        return lambda: op(viewer, "export_package.review", payload)

    small, large = queries(review(3)), queries(review(12))
    assert large <= small + SLACK, (small, large)


def test_revision_labels_cost_does_not_grow_with_labels(users, systems):
    viewer = users["viewer"]

    def labels(size):
        parts, root = systems[size]
        ids = [p["revision_id"] for p in parts] + [root["revision_id"]]
        return lambda: op(viewer, "catalog.revision_labels", {"revision_ids": ids})

    small, large = queries(labels(3)), queries(labels(12))
    assert large <= small + SLACK, (small, large)


def test_bom_freeze_closure_cost_does_not_grow_with_parts(users, project):
    owner = users["owner"]
    cost = []
    for size in (3, 12):
        leaves = [bom_part(owner, project, f"Synthetic leaf {size}-{i}") for i in range(size)]
        root = bom_assembly(owner, project, [(f"l{i}", leaf) for i, leaf in enumerate(leaves)])
        draft = bom_create(owner, project, {"assembly_revision_id": root["revision_id"]})
        cost.append(queries(lambda draft=draft: bom_capture(owner, draft, "bom.freeze")))
    assert cost[1] <= cost[0] + SLACK, cost


def test_batched_authorization_denies_non_members_and_foreign_ids_identically(
    users, systems, other_workspace
):
    _, root = systems[3]
    own = snapshot(root)
    foreign = snapshot(create_foreign_part(users, other_workspace))
    completed = set()
    for actor, batch in (
        (users["outsider"], [own]),
        (users["viewer"], [own, foreign]),
        (users["viewer"], [foreign, own]),
    ):
        with pytest.raises(NotFound, match=r"^Not found\.$"):
            authorize_snapshots(actor, batch, _authorized=completed)
        # A failed batch publishes no partially completed authorization.
        assert completed == set()
    reached = authorize_snapshots(users["viewer"], [own], _authorized=completed)
    assert own.pk in completed
    assert {str(rid) for rid in reached} == {p["revision_id"] for p in systems[3][0]}


def test_mixed_label_batch_keeps_per_label_readability(users, systems, other_workspace):
    parts, _ = systems[3]
    foreign = create_foreign_part(users, other_workspace)
    ids = [parts[0]["revision_id"], foreign["revision_id"], parts[1]["revision_id"]]
    rows = op(users["viewer"], "catalog.revision_labels", {"revision_ids": ids})["labels"]
    assert [row["readable"] for row in rows] == [True, False, True]
    assert rows[1] == {"revision_id": foreign["revision_id"], "readable": False}
    # The membership memo never outlives one operation: a later outsider read is denied.
    hidden = op(users["outsider"], "catalog.revision_labels", {"revision_ids": ids[:1]})
    assert hidden["labels"] == [{"revision_id": ids[0], "readable": False}]
