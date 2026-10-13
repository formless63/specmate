"""Keep attributed material usage bound to one actual linked unit."""

from importlib import import_module

from django.db import migrations

PREVIOUS = import_module("specmate.inventory.migrations.0004_consumption_guards").FORWARD
START = PREVIOUS.index("CREATE OR REPLACE FUNCTION specmate_inventory_entry_guard()")
END = PREVIOUS.index("$$ LANGUAGE plpgsql;", START) + len("$$ LANGUAGE plpgsql;")
ENTRY_GUARD = PREVIOUS[START:END]

ENTRY_GUARD = ENTRY_GUARD.replace(
    "  IF NEW.sequence != coalesce(seq, 0) + 1 OR NEW.before IS DISTINCT FROM prior",
    """  IF NEW.physical_unit_id IS NOT NULL AND NEW.kind NOT IN ('consumption', 'return') THEN
    RAISE EXCEPTION 'unit attribution requires material usage' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.sequence != coalesce(seq, 0) + 1 OR NEW.before IS DISTINCT FROM prior""",
)
ENTRY_GUARD = ENTRY_GUARD.replace(
    "    IF NEW.kind = 'consumption' THEN\n      SELECT r.quantity",
    """    IF NEW.kind = 'consumption' THEN
      IF NEW.physical_unit_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM physical_units_workunitlink link
          WHERE link.unit_id = NEW.physical_unit_id AND link.work_batch_id = NEW.work_batch_id
      ) THEN
        RAISE EXCEPTION 'unit usage must match linked work' USING ERRCODE = 'check_violation';
      END IF;
      SELECT r.quantity""",
)
ENTRY_GUARD = ENTRY_GUARD.replace(
    "      IF original.kind IS DISTINCT FROM 'consumption' OR original.account_id IS DISTINCT FROM NEW.account_id",
    """      IF NEW.physical_unit_id IS DISTINCT FROM original.physical_unit_id THEN
        RAISE EXCEPTION 'return unit must match consumption' USING ERRCODE = 'check_violation';
      END IF;
      IF original.kind IS DISTINCT FROM 'consumption' OR original.account_id IS DISTINCT FROM NEW.account_id""",
)
if "unit usage must match linked work" not in ENTRY_GUARD:
    raise RuntimeError("Cannot locate the prior inventory entry guard.")


class Migration(migrations.Migration):
    dependencies = [
        ("inventory", "0005_stockentry_physical_unit"),
        ("physical_units", "0002_identity_guards"),
    ]
    operations = [migrations.RunSQL(ENTRY_GUARD, PREVIOUS[START:END])]
