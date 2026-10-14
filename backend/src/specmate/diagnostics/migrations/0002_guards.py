"""Consolidated pre-1.0 database guards (immutability, sequencing and same-workspace
relationships). Hand-maintained SQL; see docs/DOMAIN.md."""

from django.db import migrations

FORWARD = r"""
CREATE FUNCTION diagnostics_immutable_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER work_control_event_immutable BEFORE UPDATE OR DELETE ON diagnostics_workcontrolevent
FOR EACH ROW EXECUTE FUNCTION diagnostics_immutable_history();

CREATE FUNCTION diagnostics_guard_work_control() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'The work control row cannot be deleted';
    END IF;
    IF NEW.version < OLD.version THEN
        RAISE EXCEPTION 'Work control versions only increase';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER work_control_guard BEFORE UPDATE OR DELETE ON diagnostics_workcontrol
FOR EACH ROW EXECUTE FUNCTION diagnostics_guard_work_control();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS work_control_guard ON diagnostics_workcontrol;
DROP FUNCTION IF EXISTS diagnostics_guard_work_control();
DROP TRIGGER IF EXISTS work_control_event_immutable ON diagnostics_workcontrolevent;
DROP FUNCTION IF EXISTS diagnostics_immutable_history();
"""


class Migration(migrations.Migration):
    dependencies = [
        ("diagnostics", "0001_initial"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
