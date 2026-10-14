"""Pre-1.0 database guards: observations, runs and export records are immutable and stay
inside one workspace."""

from django.db import migrations

FORWARD = r"""
CREATE FUNCTION specmate_integrations_observation_guard() RETURNS trigger AS $$
DECLARE revision_workspace uuid; run_workspace uuid;
BEGIN
  SELECT d.workspace_id INTO revision_workspace FROM design_revision r
    JOIN design_definition d ON d.id = r.definition_id WHERE r.id = NEW.revision_id;
  SELECT workspace_id INTO run_workspace FROM integrations_importrun WHERE id = NEW.run_id;
  IF revision_workspace IS NULL OR revision_workspace != NEW.workspace_id
    OR run_workspace IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'observation revision and run must belong to the observation workspace'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER integrations_observation_guard BEFORE INSERT ON integrations_externalobservation
FOR EACH ROW EXECUTE FUNCTION specmate_integrations_observation_guard();

CREATE TRIGGER integrations_observation_immutable
BEFORE UPDATE OR DELETE ON integrations_externalobservation
FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE TRIGGER integrations_run_immutable BEFORE UPDATE OR DELETE ON integrations_importrun
FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE TRIGGER integrations_export_immutable BEFORE UPDATE OR DELETE ON integrations_exportrecord
FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS integrations_export_immutable ON integrations_exportrecord;
DROP TRIGGER IF EXISTS integrations_run_immutable ON integrations_importrun;
DROP TRIGGER IF EXISTS integrations_observation_immutable ON integrations_externalobservation;
DROP TRIGGER IF EXISTS integrations_observation_guard ON integrations_externalobservation;
DROP FUNCTION IF EXISTS specmate_integrations_observation_guard();
"""


class Migration(migrations.Migration):
    dependencies = [
        ("design", "0002_guards"),
        ("operations", "0002_guards"),
        ("integrations", "0001_initial"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
