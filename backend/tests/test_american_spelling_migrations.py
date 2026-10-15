# ruff: noqa: F811
"""Pre-1.0 spelling migration: colour/behaviour/as_modelled/wire_colours become American.

Old-shape content is read through the new shape in memory, frozen bytes are never rewritten,
new writes use the new keys only, and editable drafts and stored preferences are upgraded by
one data migration per app.
"""

import copy
import importlib
import json

import pytest
from django.apps import apps as django_apps

from specmate.design.models import Draft, Revision
from specmate.interfaces import examples
from specmate.interfaces.contracts import Port
from specmate.interfaces.convention_contracts import ConductorConvention
from specmate.interfaces.queries import inspect_revision
from specmate.preferences.models import MakerPreferences
from specmate.printing.contracts import PrintPreparation

from .conftest import op
from .test_interface_conventions import create, freeze, frozen, kit  # noqa: F401
from .test_interface_ports import av  # noqa: F401
from .test_printing import create_preparation, part, preparation  # noqa: F401
from .test_printing import freeze as freeze_print
from .test_printing_orca import orca_body, orca_profiles  # noqa: F401


def snapshot_bytes(revision_id):
    return bytes(Revision.objects.get(id=revision_id).snapshot.canonical)


def legacy_convention(kit):
    value = examples.av_color_code(kit["signals"])
    value["schema_version"] = "0.1"
    value["scope"] = "colour_code"
    value["rules"] = [
        {
            ("colour" if k == "color" else "colour_hex" if k == "color_hex" else k): v
            for k, v in rule.items()
        }
        for rule in value["rules"]
    ]
    return value


def legacy_port(av):
    value = examples.console_port(av["variants"]["Console A AV"], "Console A AV out")
    value["schema_version"] = "0.1"
    value["pins"] = [
        {("behaviour" if k == "behavior" else k): v for k, v in pin.items()}
        for pin in value["pins"]
    ]
    return value


def test_old_convention_shape_validates_as_the_new_shape(kit):
    old = legacy_convention(kit)
    assert "colour_hex" in old["rules"][0]
    parsed = ConductorConvention.model_validate(old)
    dumped = parsed.model_dump(mode="json")
    assert dumped["schema_version"] == "0.2" and dumped["scope"] == "color_code"
    assert all("colour" not in rule and "colour_hex" not in rule for rule in dumped["rules"])
    assert dumped["rules"][0]["color"] == "Red"
    assert dumped["rules"][0]["color_hex"] == "#c0392b"
    # The old input is not mutated.
    assert old["scope"] == "colour_code"


def test_old_port_shape_validates_as_the_new_shape(av):
    old = legacy_port(av)
    assert any("behaviour" in pin for pin in old["pins"])
    dumped = Port.model_validate(old).model_dump(mode="json")
    assert dumped["schema_version"] == "0.2"
    assert all("behaviour" not in pin and "behavior" in pin for pin in dumped["pins"])
    assert [p["behavior"] for p in dumped["pins"]] == [p["behaviour"] for p in old["pins"]]


def test_old_print_orientation_validates_as_the_new_shape(users, workspace, part, orca_profiles):
    body = orca_body(part, orca_profiles)
    old = {**body, "schema_version": "1", "orientation": {**body["orientation"]}}
    old["orientation"]["status"] = "as_modelled"
    dumped = PrintPreparation.model_validate(old).model_dump(mode="json")
    assert dumped["schema_version"] == "2"
    assert dumped["orientation"]["status"] == "as_modeled"


def test_frozen_old_convention_stays_byte_identical_and_reads_in_the_new_shape(
    users,
    project,
    kit,
):
    owner = users["owner"]
    old = legacy_convention(kit)
    draft = create(owner, project, examples.av_color_code(kit["signals"]), "Legacy code")
    Draft.objects.filter(id=draft["draft_id"]).update(content={"interface": old})
    revision = freeze(owner, draft)["revision_id"]
    stored = snapshot_bytes(revision)
    content = json.loads(stored)["content"]["interface"]
    assert content["scope"] == "colour_code" and "colour_hex" in content["rules"][0]
    view = inspect_revision(users["viewer"], revision)["convention"]
    assert view["scope"] == "color_code"
    assert [r["color"] for r in view["rows"]] == ["Red", "Gray"]
    assert snapshot_bytes(revision) == stored


def test_frozen_old_port_stays_byte_identical_and_reads_in_the_new_shape(
    users,
    project,
    av,
):
    owner = users["owner"]
    old = legacy_port(av)
    draft = create(owner, project, examples.console_port(av["variants"]["Console A AV"], "x"), "P")
    Draft.objects.filter(id=draft["draft_id"]).update(content={"interface": old})
    revision = freeze(owner, draft)["revision_id"]
    stored = snapshot_bytes(revision)
    assert b"behaviour" in stored and b"behavior" not in stored
    view = inspect_revision(users["viewer"], revision)
    assert all("behaviour" not in str(row) for row in view["end"]["rows"])
    assert snapshot_bytes(revision) == stored


def test_new_writes_use_only_the_new_spellings(users, project, kit):
    owner = users["owner"]
    old = legacy_convention(kit)
    draft = create(owner, project, old, "Submitted old shape")
    content = Draft.objects.get(id=draft["draft_id"]).content["interface"]
    assert content["schema_version"] == "0.2" and content["scope"] == "color_code"
    assert "colour" not in json.dumps(content)


def test_interface_draft_migration_upgrades_only_old_editable_content(
    users,
    project,
    kit,
    av,
):
    owner = users["owner"]
    convention = create(owner, project, examples.av_color_code(kit["signals"]), "Old code")
    port = create(
        owner, project, examples.console_port(av["variants"]["Console A AV"], "x"), "Old port"
    )
    current = create(owner, project, examples.av_color_code(kit["signals"]), "Current code")
    Draft.objects.filter(id=convention["draft_id"]).update(
        content={"interface": legacy_convention(kit)}
    )
    Draft.objects.filter(id=port["draft_id"]).update(content={"interface": legacy_port(av)})
    versions = {
        name: Draft.objects.get(id=d["draft_id"]).version
        for name, d in (("convention", convention), ("port", port), ("current", current))
    }
    current_content = copy.deepcopy(Draft.objects.get(id=current["draft_id"]).content)

    migration = importlib.import_module(
        "specmate.interfaces.migrations.0001_port_convention_content_0_2"
    )
    migration.upgrade_drafts(django_apps, None)

    upgraded = Draft.objects.get(id=convention["draft_id"])
    assert upgraded.version == versions["convention"] + 1
    assert upgraded.content["interface"]["scope"] == "color_code"
    assert upgraded.content["interface"]["rules"][0]["color_hex"] == "#c0392b"
    ported = Draft.objects.get(id=port["draft_id"])
    assert ported.version == versions["port"] + 1
    assert ported.content["interface"]["schema_version"] == "0.2"
    assert all("behavior" in pin for pin in ported.content["interface"]["pins"])
    untouched = Draft.objects.get(id=current["draft_id"])
    assert untouched.version == versions["current"] and untouched.content == current_content
    # A second run changes nothing.
    migration.upgrade_drafts(django_apps, None)
    assert Draft.objects.get(id=convention["draft_id"]).version == versions["convention"] + 1
    op(
        owner,
        "interface.freeze",
        {"draft_id": convention["draft_id"]},
        expected_state=f"draft-v{versions['convention'] + 1}",
    )


def test_print_draft_migration_and_frozen_read(users, workspace, part, orca_profiles):
    owner = users["editor"]
    body = orca_body(part, orca_profiles)
    created = create_preparation(owner, workspace, body)
    old = {**json.loads(PrintPreparation.model_validate(body).model_dump_json())}
    old["schema_version"] = "1"
    old["orientation"]["status"] = "as_modelled"
    Draft.objects.filter(id=created["draft_id"]).update(content={"print_preparation": old})
    version = Draft.objects.get(id=created["draft_id"]).version
    migration = importlib.import_module("specmate.printing.migrations.0001_preparation_content_2")
    migration.upgrade_drafts(django_apps, None)
    draft = Draft.objects.get(id=created["draft_id"])
    assert draft.version == version + 1
    assert draft.content["print_preparation"]["schema_version"] == "2"
    assert draft.content["print_preparation"]["orientation"]["status"] == "as_modeled"

    # A frozen schema 1 revision keeps its bytes and still reads.
    again = create_preparation(owner, workspace, body)
    Draft.objects.filter(id=again["draft_id"]).update(content={"print_preparation": old})
    refreshed = {**again, "state": f"draft-v{Draft.objects.get(id=again['draft_id']).version}"}
    revision = freeze_print(owner, "print_preparation.freeze", refreshed)["revision_id"]
    stored = snapshot_bytes(revision)
    assert b"as_modelled" in stored
    read = op(owner, "print_preparation.read", {"revision_id": revision})
    assert "as_modelled" not in json.dumps(read)
    assert snapshot_bytes(revision) == stored


@pytest.mark.django_db
def test_preferences_migration_renames_the_stored_key(users, workspace):
    owner = users["owner"]
    from specmate.access.models import Workspace

    ws = Workspace.objects.get(id=workspace)
    old = MakerPreferences.objects.create(
        workspace=ws,
        user=None,
        values={"wire_colours": ["red"], "default_length_unit": "mm"},
        updated_by=owner,
    )
    both = MakerPreferences.objects.create(
        workspace=ws,
        user=owner,
        values={"wire_colours": ["old"], "wire_colors": ["new"]},
        updated_by=owner,
    )
    clean = MakerPreferences.objects.create(
        workspace=ws, user=users["editor"], values={"wire_colors": ["blue"]}, updated_by=owner
    )
    migration = importlib.import_module("specmate.preferences.migrations.0002_wire_colors_key")
    migration.rename_key(django_apps, None)
    old.refresh_from_db()
    both.refresh_from_db()
    clean.refresh_from_db()
    assert old.values == {"wire_colors": ["red"], "default_length_unit": "mm"}
    assert old.version == 2
    assert both.values == {"wire_colors": ["new"]}
    assert clean.values == {"wire_colors": ["blue"]} and clean.version == 1
