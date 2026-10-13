from django.db import migrations

FORWARD = """
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
"""

REVERSE = """
DROP TRIGGER stage_identity_immutable ON builds_buildstage;
DROP FUNCTION builds_protect_stage_identity();
DROP TRIGGER stage_event_immutable ON builds_stageevent;
DROP TRIGGER stage_output_immutable ON builds_stageoutput;
DROP TRIGGER build_attempt_immutable ON builds_buildattempt;
DROP FUNCTION builds_immutable_evidence();
"""


class Migration(migrations.Migration):
    dependencies = [("builds", "0001_initial")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
