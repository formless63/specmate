"""OPS-007: demo data is created through operations on a marked or empty installation."""

import json
import uuid
from io import StringIO

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from specmate.access.models import Installation, Project, WorkspaceMember
from specmate.access.operations import provision_account
from specmate.design.models import Definition
from specmate.operations import registry

PASSWORD = "Demo-Account-Pass-12345"


@pytest.fixture
def admin(db):
    provision_account("demo-admin", PASSWORD, "admin")


def seed(*args, **options):
    out = StringIO()
    call_command("seed_demo", *args, stdout=out, **options)
    return out.getvalue()


def test_seed_populates_every_requested_area_through_operations(admin):
    users_before = WorkspaceMember.objects.count()
    out = seed(allow=True)
    assert "Seeded synthetic demo data as demo-admin" in out
    kinds = set(Definition.objects.values_list("kind", flat=True))
    assert {
        "part",
        "wire_stock",
        "cable",
        "harness",
        "assembly",
        "bom_plan",
        "material_plan",
        "option_set",
        "configuration",
        "development_need",
        "preparation_profile",
    } <= kinds
    assert all(n.startswith("Demo") for n in Definition.objects.values_list("name", flat=True))
    names = sorted(Project.objects.values_list("name", flat=True))
    assert names == ["Demo bench A", "Demo bench B"]
    assert WorkspaceMember.objects.count() == users_before


def test_seed_is_idempotent_and_refuses_when_already_seeded(admin):
    seed(allow=True)
    count = Definition.objects.count()
    with pytest.raises(CommandError, match="already present"):
        seed(allow=True)
    assert Definition.objects.count() == count


def test_seed_refuses_without_marker_or_allow_and_without_an_account(db, admin):
    with pytest.raises(CommandError, match="No disposable marker"):
        seed()
    assert Definition.objects.count() == 0
    WorkspaceMember.objects.all().delete()
    with pytest.raises(CommandError, match="creates no accounts"):
        seed(allow=True)


def test_allow_refuses_a_database_that_already_holds_items(admin):
    from specmate.operations import Context, execute

    owner = Installation.objects.get().owner
    execute(
        "definition.create",
        Context(user=owner, via="internal", request_id="x"),
        {
            "workspace_id": str(WorkspaceMember.objects.get().workspace_id),
            "kind": "part",
            "name": "Existing",
        },
    )
    with pytest.raises(CommandError, match="empty databases"):
        seed(allow=True)


def test_seed_runs_on_a_marked_installation_without_allow(admin, settings, tmp_path):
    root = tmp_path / "state" / "disposable"
    db = settings.DATABASES["default"]
    settings.SPECMATE_ARTIFACT_ROOT = str(root / "artifacts")
    marker = tmp_path / "marker.json"
    marker.write_text(
        json.dumps(
            {
                "schema": 1,
                "policy": "pre-1.0-disposable",
                "installation_id": str(Installation.objects.get().installation_id),
                "database": {"host": db["HOST"], "port": db["PORT"], "name": db["NAME"]},
                "state_root": str(root),
                "artifact_root": str(root / "artifacts"),
            }
        )
    )
    assert "Seeded synthetic demo data" in seed(marker=str(marker))
    # A marker for another installation is refused before anything is written.
    data = json.loads(marker.read_text())
    data["installation_id"] = str(uuid.uuid4())
    marker.write_text(json.dumps(data))
    with pytest.raises(CommandError, match="refused"):
        seed(marker=str(marker))


def test_every_operation_used_is_registered_and_no_raw_sql_is_issued():
    import inspect

    from specmate.operations import demo_seed

    source = inspect.getsource(demo_seed)
    assert "cursor" not in source and ".raw(" not in source and "execute_sql" not in source
    assert registry  # operations register on import of the app registry


def test_seed_content_covers_every_page(admin):
    from specmate.access.models import ProjectReference
    from specmate.agent_runs.models import AgentRun
    from specmate.catalog.models import ManufacturerVariant, Representation
    from specmate.evidence.models import SubjectTest
    from specmate.inventory.models import Reservation, StockAccount
    from specmate.knowledge.models import KnowledgeItem
    from specmate.physical_units.models import PhysicalUnit
    from specmate.preferences.models import MakerPreferences
    from specmate.releases.models import Release, ReleaseWarning
    from specmate.sourcing.models import SupplierOffer

    seed(allow=True)
    assert Representation.objects.count() >= 3 and ManufacturerVariant.objects.count() == 2
    assert PhysicalUnit.objects.count() == 2 and SubjectTest.objects.count() == 1
    assert StockAccount.objects.count() == 2 and Reservation.objects.count() == 1
    assert Release.objects.count() == 1 and ReleaseWarning.objects.count() == 1
    assert SupplierOffer.objects.count() == 1 and KnowledgeItem.objects.count() == 2
    assert MakerPreferences.objects.count() == 1
    run = AgentRun.objects.get()
    assert run.status == "completed" and run.sponsor_id == run.agent_id
    kinds = {r.kind for r in ProjectReference.objects.all()}
    assert kinds == {"definition", "revision"}  # floating and pinned
    assert Definition.objects.filter(kind="development_need").count() == 1
