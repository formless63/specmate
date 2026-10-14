"""Consolidated pre-1.0 database guards (immutability, sequencing and same-workspace
relationships). Hand-maintained SQL; see docs/DOMAIN.md."""

from django.db import migrations

FORWARD = r"""
CREATE TRIGGER configurations_resolved_immutable BEFORE UPDATE OR DELETE
ON configurations_resolvedconfiguration FOR EACH ROW
EXECUTE FUNCTION specmate_reject_mutation();

CREATE FUNCTION specmate_resolved_configuration_links() RETURNS trigger AS $$
BEGIN
  IF convert_from(NEW.resolution_canonical, 'UTF8')::jsonb IS DISTINCT FROM NEW.resolution
     OR encode(sha256(NEW.resolution_canonical), 'hex') IS DISTINCT FROM NEW.resolution_sha256
     OR NEW.resolution->>'status' IS DISTINCT FROM NEW.status
     OR NEW.resolution->'option_set'->>'revision_id'
        IS DISTINCT FROM NEW.option_set_revision_id::text
     OR NOT EXISTS (
       SELECT 1 FROM design_snapshot s
       JOIN design_definition d ON d.id = s.definition_id
       WHERE s.id = NEW.snapshot_id AND s.draft_id = NEW.draft_id
         AND s.draft_version = NEW.draft_version AND d.kind = 'configuration'
         AND d.workspace_id = NEW.workspace_id)
     OR NOT EXISTS (
       SELECT 1 FROM design_snapshotdependency p
       WHERE p.snapshot_id = NEW.snapshot_id AND p.revision_id = NEW.option_set_revision_id)
  THEN
    RAISE EXCEPTION 'resolved configuration evidence is inconsistent';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER configurations_resolved_links BEFORE INSERT
ON configurations_resolvedconfiguration
FOR EACH ROW EXECUTE FUNCTION specmate_resolved_configuration_links();

CREATE TRIGGER configurations_resolvedconfiguration_workspace_fixed BEFORE UPDATE ON configurations_resolvedconfiguration
FOR EACH ROW EXECUTE FUNCTION specmate_preserve_workspace();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS configurations_resolvedconfiguration_workspace_fixed ON configurations_resolvedconfiguration;
DROP TRIGGER IF EXISTS configurations_resolved_links ON configurations_resolvedconfiguration;
DROP FUNCTION IF EXISTS specmate_resolved_configuration_links();
DROP TRIGGER IF EXISTS configurations_resolved_immutable ON configurations_resolvedconfiguration;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("configurations", "0001_initial"),
        ("design", "0001_initial"),
        ("operations", "0002_guards"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
