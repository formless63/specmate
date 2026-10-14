"""Consolidated pre-1.0 database guards (immutability, sequencing and same-workspace
relationships). Hand-maintained SQL; see docs/DOMAIN.md."""

from django.db import migrations

FORWARD = r"""
CREATE TRIGGER design_snapshot_immutable BEFORE UPDATE OR DELETE ON design_snapshot FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE TRIGGER design_snapshotdependency_immutable BEFORE UPDATE OR DELETE ON design_snapshotdependency FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE TRIGGER design_revision_immutable BEFORE UPDATE OR DELETE ON design_revision FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE FUNCTION specmate_snapshot_dependency_workspace() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM design_snapshot s
      JOIN design_definition sd ON sd.id = s.definition_id
      JOIN design_revision r ON r.id = NEW.revision_id
      JOIN design_definition rd ON rd.id = r.definition_id
    WHERE s.id = NEW.snapshot_id AND sd.workspace_id = rd.workspace_id
  ) THEN
    RAISE EXCEPTION 'exact pins stay inside one workspace' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER design_snapshotdependency_workspace BEFORE INSERT
ON design_snapshotdependency FOR EACH ROW EXECUTE FUNCTION specmate_snapshot_dependency_workspace();

CREATE TRIGGER design_definition_workspace_fixed BEFORE UPDATE ON design_definition
FOR EACH ROW EXECUTE FUNCTION specmate_preserve_workspace();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS design_definition_workspace_fixed ON design_definition;
DROP TRIGGER IF EXISTS design_snapshotdependency_workspace ON design_snapshotdependency;
DROP FUNCTION IF EXISTS specmate_snapshot_dependency_workspace();
DROP TRIGGER IF EXISTS design_revision_immutable ON design_revision;
DROP TRIGGER IF EXISTS design_snapshotdependency_immutable ON design_snapshotdependency;
DROP TRIGGER IF EXISTS design_snapshot_immutable ON design_snapshot;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("design", "0001_initial"),
        ("operations", "0002_guards"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
