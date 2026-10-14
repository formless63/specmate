"""Consolidated pre-1.0 database guards (immutability, sequencing and same-workspace
relationships). Hand-maintained SQL; see docs/DOMAIN.md."""

from django.db import migrations

FORWARD = r"""
CREATE FUNCTION builds_immutable_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER build_attempt_immutable BEFORE UPDATE OR DELETE ON builds_buildattempt
FOR EACH ROW EXECUTE FUNCTION builds_immutable_evidence();

CREATE TRIGGER stage_output_immutable BEFORE UPDATE OR DELETE ON builds_stageoutput
FOR EACH ROW EXECUTE FUNCTION builds_immutable_evidence();

CREATE TRIGGER stage_event_immutable BEFORE UPDATE OR DELETE ON builds_stageevent
FOR EACH ROW EXECUTE FUNCTION builds_immutable_evidence();

CREATE FUNCTION builds_protect_stage_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.build_id IS DISTINCT FROM OLD.build_id
       OR (OLD.runner_id IS NOT NULL AND (
           NEW.runner_id IS DISTINCT FROM OLD.runner_id
           OR NEW.fencing_token IS DISTINCT FROM OLD.fencing_token))
       OR (OLD.receipt IS NOT NULL AND (
           NEW.receipt IS DISTINCT FROM OLD.receipt OR NEW.state IS DISTINCT FROM OLD.state))
    THEN
        RAISE EXCEPTION 'Stage execution identity and accepted receipts are immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER stage_identity_immutable BEFORE UPDATE ON builds_buildstage
FOR EACH ROW EXECUTE FUNCTION builds_protect_stage_identity();

CREATE FUNCTION specmate_build_input_workspace() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM sources_sourcebundlerevision r
      JOIN sources_sourcebundle b ON b.id = r.bundle_id
    WHERE r.id = NEW.source_revision_id AND b.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'build inputs must belong to the build workspace'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER builds_buildattempt_input_workspace BEFORE INSERT ON builds_buildattempt
FOR EACH ROW EXECUTE FUNCTION specmate_build_input_workspace();

CREATE TRIGGER builds_buildattempt_workspace_fixed BEFORE UPDATE ON builds_buildattempt
FOR EACH ROW EXECUTE FUNCTION specmate_preserve_workspace();

CREATE TRIGGER builds_runnercredential_workspace_fixed BEFORE UPDATE ON builds_runnercredential
FOR EACH ROW EXECUTE FUNCTION specmate_preserve_workspace();

CREATE TRIGGER builds_buildattempt_project_context BEFORE INSERT OR UPDATE ON builds_buildattempt
FOR EACH ROW EXECUTE FUNCTION specmate_project_context();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS builds_buildattempt_project_context ON builds_buildattempt;
DROP TRIGGER IF EXISTS builds_runnercredential_workspace_fixed ON builds_runnercredential;
DROP TRIGGER IF EXISTS builds_buildattempt_workspace_fixed ON builds_buildattempt;
DROP TRIGGER IF EXISTS builds_buildattempt_input_workspace ON builds_buildattempt;
DROP FUNCTION IF EXISTS specmate_build_input_workspace();
DROP TRIGGER IF EXISTS stage_identity_immutable ON builds_buildstage;
DROP FUNCTION IF EXISTS builds_protect_stage_identity();
DROP TRIGGER IF EXISTS stage_event_immutable ON builds_stageevent;
DROP TRIGGER IF EXISTS stage_output_immutable ON builds_stageoutput;
DROP TRIGGER IF EXISTS build_attempt_immutable ON builds_buildattempt;
DROP FUNCTION IF EXISTS builds_immutable_evidence();
"""


class Migration(migrations.Migration):
    dependencies = [
        ("builds", "0001_initial"),
        ("operations", "0002_guards"),
        ("sources", "0001_initial"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
