"""Typed design closures keep exact pins inside one workspace.

An actor who belongs to two workspaces can read revisions in both, but a typed draft,
capture or read may never combine them. A foreign revision reads exactly like a
missing one (``Not found.``) before any diagnostic or write, so the same-workspace
database guards never surface as a raw integrity error.
"""

import copy

import pytest

from specmate.design.models import Definition, Draft, Snapshot
from specmate.operations import NotFound, ValidationFailed

from .conftest import ensure_member, op
from .scope_helpers import workspace_of
from .test_bom import create as create_bom
from .test_bom import fixture as bom_fixture
from .test_cables import capture as capture_cable
from .test_cables import create as create_cable
from .test_cables import fixture as cable_fixture
from .test_end_preparation import create as create_end_profile
from .test_end_preparation import profile as end_profile
from .test_harnesses import create as create_harness
from .test_harnesses import fixture as harness_fixture
from .test_interfaces import create as create_interface
from .test_interfaces import freeze as freeze_interface
from .test_interfaces import pinout
from .test_material_accounting import create as create_material
from .test_material_accounting import fixture as material_fixture
from .test_preparation import create as create_profile
from .test_preparation import profile as cut_profile

NOT_FOUND = r"^Not found\.$"


@pytest.fixture
def dual(users, project, other_workspace):
    """The editor also reads the outsider's foreign workspace; returns a foreign project."""
    ensure_member(users["editor"], "viewer", workspace=other_workspace)
    remote = op(users["outsider"], "project.create", {"name": "Foreign bench"})["project_id"]
    return users["editor"], remote


def counts():
    return Definition.objects.count(), Draft.objects.count(), Snapshot.objects.count()


def foreign_stock(users, remote):
    *_, cable = cable_fixture(users["outsider"], remote)
    return cable["stock_revision_id"]


def test_typed_creates_reject_a_foreign_stock_pin_before_diagnostics(users, project, dual):
    editor, remote = dual
    stock = foreign_stock(users, remote)
    *_, cable = cable_fixture(users["owner"], project)
    _, _, _, harness = harness_fixture(users["owner"], project)
    mixed_cable = {**copy.deepcopy(cable), "stock_revision_id": stock}
    mixed_harness = copy.deepcopy(harness)
    mixed_harness["sections"][1]["stock_revision_id"] = stock
    before = counts()
    for action in (
        lambda: create_cable(editor, project, mixed_cable),
        lambda: create_harness(editor, project, mixed_harness),
        lambda: create_profile(editor, project, cut_profile(stock)),
        lambda: create_end_profile(editor, project, end_profile(stock)),
    ):
        with pytest.raises(NotFound, match=NOT_FOUND) as error:
            action()
        assert error.value.details == {}
    assert counts() == before


def test_typed_updates_and_generic_edits_reject_a_foreign_pin(users, project, dual):
    editor, remote = dual
    stock = foreign_stock(users, remote)
    *_, cable = cable_fixture(users["owner"], project)
    draft = create_cable(editor, project, cable)
    mixed = {**copy.deepcopy(cable), "stock_revision_id": stock}
    for name, payload in (
        ("cable.update", {"draft_id": draft["draft_id"], "cable": mixed}),
        ("draft.update", {"draft_id": draft["draft_id"], "changes": {"cable": mixed}}),
    ):
        with pytest.raises(NotFound, match=NOT_FOUND):
            op(editor, name, payload, expected_state=draft["state"])
    assert Draft.objects.get(id=draft["draft_id"]).state_token == draft["state"]
    # The unchanged draft still captures normally inside its own workspace.
    frozen = capture_cable(editor, draft)
    assert frozen["revision_id"]


def test_interface_bom_and_material_plans_reject_foreign_roots(users, project, dual):
    editor, remote = dual
    outsider = users["outsider"]
    foreign_body = freeze_interface(outsider, create_interface(outsider, remote))
    *_, foreign_plan = bom_fixture(outsider, remote)
    *_, local_plan = bom_fixture(users["owner"], project)
    _, foreign_subject, _, _ = material_fixture(outsider, remote)
    _, _, _, material = material_fixture(users["owner"], project)
    before = counts()
    for action in (
        lambda: create_interface(editor, project, pinout(foreign_body)),
        lambda: create_bom(
            editor,
            project,
            {**local_plan, "assembly_revision_id": foreign_plan["assembly_revision_id"]},
        ),
        lambda: create_material(
            editor, project, {**material, "subject_revision_id": foreign_subject["revision_id"]}
        ),
    ):
        with pytest.raises(NotFound, match=NOT_FOUND):
            action()
    assert counts() == before


def test_create_takes_a_workspace_and_never_a_project(users, project, workspace):
    *_, cable = cable_fixture(users["owner"], project)
    created = op(
        users["contributor"],
        "cable.create",
        {"workspace_id": workspace, "name": "Contributor cable", "cable": cable},
    )
    assert created["workspace_id"] == workspace
    # An omitted workspace is the actor's only one.
    omitted = op(users["contributor"], "cable.create", {"name": "Implicit", "cable": cable})
    assert omitted["workspace_id"] == workspace
    with pytest.raises(ValidationFailed, match="Invalid payload"):
        op(
            users["owner"],
            "cable.create",
            {"project_id": project, "name": "Old payload", "cable": cable},
        )
    assert workspace_of(project) == workspace
