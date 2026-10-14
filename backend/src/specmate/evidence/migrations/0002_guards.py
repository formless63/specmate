"""Recorded results are immutable snapshots; their pins stay inside the record workspace.
Hand-maintained SQL; see docs/modules/EVIDENCE.md."""

from django.db import migrations

FORWARD = r"""
CREATE TRIGGER evidence_recorded_result_immutable BEFORE UPDATE OR DELETE
ON evidence_recordedresult FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE TRIGGER evidence_recorded_pin_immutable BEFORE UPDATE OR DELETE
ON evidence_recordedpin FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE FUNCTION specmate_evidence_recorded_pin_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM evidence_recordedresult r
      JOIN design_revision v ON v.id = NEW.revision_id
      JOIN design_definition d ON d.id = v.definition_id
    WHERE r.id = NEW.record_id AND d.workspace_id = r.workspace_id
  ) THEN
    RAISE EXCEPTION 'recorded result pins stay inside the record workspace'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_recorded_pin_guard BEFORE INSERT ON evidence_recordedpin
FOR EACH ROW EXECUTE FUNCTION specmate_evidence_recorded_pin_guard();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS evidence_recorded_pin_guard ON evidence_recordedpin;
DROP FUNCTION IF EXISTS specmate_evidence_recorded_pin_guard();
DROP TRIGGER IF EXISTS evidence_recorded_pin_immutable ON evidence_recordedpin;
DROP TRIGGER IF EXISTS evidence_recorded_result_immutable ON evidence_recordedresult;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("design", "0002_guards"),
        ("evidence", "0001_initial"),
        ("operations", "0002_guards"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
