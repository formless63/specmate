"""Run records are kept and their step log is append-only. Hand-maintained SQL."""

from django.db import migrations

FORWARD = r"""
CREATE TRIGGER agent_run_no_delete BEFORE DELETE ON agent_runs_agentrun
FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE TRIGGER agent_run_step_immutable BEFORE UPDATE OR DELETE ON agent_runs_agentrunstep
FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE FUNCTION specmate_agent_run_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.id != OLD.id OR NEW.workspace_id != OLD.workspace_id
     OR NEW.sponsor_id != OLD.sponsor_id OR NEW.agent_id != OLD.agent_id
     OR NEW.created_at != OLD.created_at
     OR NEW.actions_used < OLD.actions_used
     OR NEW.version < OLD.version
     OR OLD.status = 'cancelled' AND NEW.status != 'cancelled' THEN
    RAISE EXCEPTION 'run identity, sponsor, agent and consumed budget are fixed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_run_guard BEFORE UPDATE ON agent_runs_agentrun
FOR EACH ROW EXECUTE FUNCTION specmate_agent_run_guard();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS agent_run_guard ON agent_runs_agentrun;
DROP FUNCTION IF EXISTS specmate_agent_run_guard();
DROP TRIGGER IF EXISTS agent_run_step_immutable ON agent_runs_agentrunstep;
DROP TRIGGER IF EXISTS agent_run_no_delete ON agent_runs_agentrun;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("agent_runs", "0001_initial"),
        ("operations", "0002_guards"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
