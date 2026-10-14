"""Consolidated pre-1.0 database guards (immutability, sequencing and same-workspace
relationships). Hand-maintained SQL; see docs/DOMAIN.md."""

from django.db import migrations

FORWARD = r"""
CREATE FUNCTION specmate_project_reference_guard() RETURNS trigger AS $$
DECLARE project_workspace uuid; target_workspace uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Reference history is retired, not erased; only deleting its project removes it.
    IF current_setting('specmate.deleting_project', true) IS DISTINCT FROM OLD.project_id::text THEN
      RAISE EXCEPTION 'project references are retired, not deleted'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL
       OR (to_jsonb(NEW) - 'removed_at' - 'removed_by_id' - 'removal_request_id' - 'removal_reason')
          IS DISTINCT FROM
          (to_jsonb(OLD) - 'removed_at' - 'removed_by_id' - 'removal_request_id' - 'removal_reason')
    THEN
      RAISE EXCEPTION 'a project reference is removed once and otherwise immutable'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'invalid project reference state' USING ERRCODE = 'check_violation';
  END IF;
  SELECT workspace_id INTO project_workspace FROM access_project WHERE id = NEW.project_id;
  target_workspace := CASE NEW.kind
    WHEN 'definition' THEN
      (SELECT workspace_id FROM design_definition WHERE id = NEW.definition_id)
    WHEN 'revision' THEN
      (SELECT d.workspace_id FROM design_revision r
         JOIN design_definition d ON d.id = r.definition_id WHERE r.id = NEW.revision_id)
    WHEN 'source_bundle' THEN
      (SELECT workspace_id FROM sources_sourcebundle WHERE id = NEW.source_bundle_id)
    WHEN 'physical_unit' THEN
      (SELECT workspace_id FROM physical_units_physicalunit WHERE id = NEW.physical_unit_id)
    WHEN 'work_batch' THEN
      (SELECT d.workspace_id FROM inventory_workbatch b
         JOIN design_revision r ON r.id = b.revision_id
         JOIN design_definition d ON d.id = r.definition_id WHERE b.id = NEW.work_batch_id)
  END;
  IF target_workspace IS NULL OR target_workspace IS DISTINCT FROM project_workspace THEN
    RAISE EXCEPTION 'project reference target must belong to the project workspace'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER access_project_reference_guard BEFORE INSERT OR UPDATE OR DELETE
ON access_projectreference FOR EACH ROW EXECUTE FUNCTION specmate_project_reference_guard();

CREATE TRIGGER access_project_workspace_fixed BEFORE UPDATE ON access_project
FOR EACH ROW EXECUTE FUNCTION specmate_preserve_workspace();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS access_project_workspace_fixed ON access_project;
DROP TRIGGER IF EXISTS access_project_reference_guard ON access_projectreference;
DROP FUNCTION IF EXISTS specmate_project_reference_guard();
"""


class Migration(migrations.Migration):
    dependencies = [
        ("access", "0002_projectreference"),
        ("design", "0001_initial"),
        ("inventory", "0002_stockentry_physical_unit"),
        ("operations", "0002_guards"),
        ("physical_units", "0001_initial"),
        ("sources", "0001_initial"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
