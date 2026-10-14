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
from .scope_helpers import workspace_of
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


def test_release_review_cost_does_not_grow_with_pinned_revisions(users, project):
    owner = users["owner"]

    def review(size):
        _, root = system(owner, project, size)
        payload = {"root_revision_id": root["revision_id"], "quantity": 1}
        return lambda: op(owner, "release.review", payload)

    small, large = queries(review(3)), queries(review(12))
    assert large <= small + SLACK, (small, large)


def test_release_review_still_reports_evidence_for_pinned_revisions(users, project):
    from .test_facts import append, fact, subject

    owner = users["owner"]
    parts, root = system(owner, project, 3)
    append(
        owner,
        subject(owner, {"kind": "revision", "revision_id": parts[1]["revision_id"]}),
        fact(
            "continuity_checked",
            role="actual",
            value={"kind": "boolean", "value": True},
            provenance={
                "method": "source_observation",
                "evidence": [{"kind": "citation", "citation": "Synthetic review note"}],
            },
        ),
    )
    review = op(owner, "release.review", {"root_revision_id": root["revision_id"], "quantity": 1})
    evidence = review["review"]["evidence"]
    assert [row["revision_id"] for row in evidence["items"]] == [parts[1]["revision_id"]]
    assert evidence["counts"] == {"exact_revision": 1}
    assert evidence["evaluated_revisions"] == 4


def test_interface_closure_cost_does_not_grow_with_assembly_parts(users, project):
    from .test_interfaces import create as create_interface
    from .test_interfaces import freeze as freeze_interface
    from .test_interfaces import pinout

    owner = users["owner"]
    body = freeze_interface(owner, create_interface(owner, project))
    pins = pinout(body)
    cost = []
    for size in (3, 12):
        _, assembly = system(owner, project, size)
        mapping = {
            "kind": "interface_map",
            "assembly_revision_id": assembly["revision_id"],
            "external_pinout_revision_id": freeze_interface(
                owner, create_interface(owner, project, pins)
            )["revision_id"],
            "passages": [],
        }
        cost.append(queries(lambda mapping=mapping: create_interface(owner, project, mapping)))
    assert cost[1] <= cost[0] + SLACK, cost


def test_configuration_history_cost_does_not_grow_with_resolved_records(users, project):
    from .test_configurations import capture as capture_configuration
    from .test_configurations import configuration as create_configuration
    from .test_configurations import frozen, option_set_content, select

    owner = users["owner"]
    parts = [frozen(owner, project, f"Synthetic sensor {n}") for n in "AB"]
    options = op(
        owner,
        "definition.create",
        {
            "workspace_id": workspace_of(project),
            "kind": "option_set",
            "name": "Synthetic options",
            "content": option_set_content(parts),
        },
    )
    frozen_options = op(
        owner, "draft.freeze", {"draft_id": options["draft_id"]}, expected_state=options["state"]
    )
    draft = create_configuration(owner, project, frozen_options["revision_id"])
    cost, recorded = [], 0
    for target in (3, 12):
        while recorded < target:
            choice = "ab"[recorded % 2]
            select(
                owner,
                draft,
                [
                    {"option_key": "sensor", "choice_key": choice},
                    {"option_key": "finish", "choice_key": "bead"},
                ],
            )
            capture_configuration(owner, draft["draft_id"], basis=f"Synthetic basis {recorded}")
            recorded += 1
        cost.append(
            queries(lambda: op(owner, "configuration.resolve", {"draft_id": draft["draft_id"]}))
        )
    assert cost[1] <= cost[0] + SLACK, cost


def test_harness_closure_cost_does_not_grow_with_sections(users, project):
    from .test_cables import STOCK
    from .test_cables import capture as capture_stock
    from .test_harnesses import create as create_harness
    from .test_harnesses import fixture as harness_fixture

    owner = users["owner"]
    _, _, _, base = harness_fixture(owner, project)
    cost = []
    for size in (3, 12):
        harness = {**base, "sections": list(base["sections"][:2])}
        for i in range(size - 2):
            stock = capture_stock(
                owner,
                op(
                    owner,
                    "wire_stock.create",
                    {
                        "workspace_id": workspace_of(project),
                        "name": f"Stock {size}-{i}",
                        "stock": STOCK,
                    },
                ),
                "wire_stock.freeze",
            )
            harness["sections"].append(
                {
                    "local_id": f"extra-{i}",
                    "stock_revision_id": stock["revision_id"],
                    "planned_cut_length_mm": 10,
                    "cut_basis": "Explicit extra cut",
                }
            )
        cost.append(queries(lambda harness=harness: create_harness(owner, project, harness)))
    assert cost[1] <= cost[0] + SLACK, cost
