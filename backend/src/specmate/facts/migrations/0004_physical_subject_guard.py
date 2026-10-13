"""A physical fact subject must belong to its actual unit's project."""

from importlib import import_module

from django.db import migrations

PREVIOUS = import_module("specmate.facts.migrations.0002_assertion_invariants").FORWARD
START = PREVIOUS.index("CREATE FUNCTION specmate_facts_subject_guard()")
END = PREVIOUS.index("$$ LANGUAGE plpgsql;", START) + len("$$ LANGUAGE plpgsql;")
PRIOR_GUARD = PREVIOUS[START:END].replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION", 1)
NEW_GUARD = PRIOR_GUARD.replace(
    """      WHERE s.id = NEW.snapshot_id AND d.project_id = NEW.project_id
    )) THEN""",
    """      WHERE s.id = NEW.snapshot_id AND d.project_id = NEW.project_id
    )) OR (NEW.physical_unit_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM physical_units_physicalunit u
      WHERE u.id = NEW.physical_unit_id AND u.project_id = NEW.project_id
    )) THEN""",
)
if NEW_GUARD == PRIOR_GUARD:
    raise RuntimeError("Cannot locate the prior fact subject scope guard.")


class Migration(migrations.Migration):
    dependencies = [("facts", "0003_physical_unit_subject")]
    operations = [migrations.RunSQL(NEW_GUARD, PRIOR_GUARD)]
