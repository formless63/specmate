"""Database guards for append-only proposal review decisions."""

from django.db import migrations

FORWARD = r"""
CREATE TRIGGER proposal_decision_immutable BEFORE UPDATE OR DELETE
ON mechanical_proposals_proposaldecision FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE FUNCTION specmate_proposal_decision_guard() RETURNS trigger AS $$
DECLARE rev_workspace uuid; last_version int; last_decision text; def_workspace uuid; draft_def uuid;
BEGIN
  SELECT workspace_id INTO rev_workspace FROM mechanical_proposals_proposalrevision
    WHERE id = NEW.revision_id;
  IF NEW.workspace_id IS DISTINCT FROM rev_workspace THEN
    RAISE EXCEPTION 'a proposal decision must share its retained proposal workspace'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT version, decision INTO last_version, last_decision
    FROM mechanical_proposals_proposaldecision
    WHERE revision_id = NEW.revision_id ORDER BY version DESC LIMIT 1;
  IF NEW.version != COALESCE(last_version, 0) + 1 THEN
    RAISE EXCEPTION 'proposal decisions are sequential' USING ERRCODE = 'check_violation';
  END IF;
  IF last_decision = 'accepted' THEN
    RAISE EXCEPTION 'an accepted proposal decision is final' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.linked_draft_id IS NOT NULL THEN
    SELECT d.workspace_id, dr.definition_id INTO def_workspace, draft_def
      FROM design_draft dr JOIN design_definition d ON d.id = dr.definition_id
      WHERE dr.id = NEW.linked_draft_id;
    IF def_workspace IS DISTINCT FROM NEW.workspace_id
       OR draft_def IS DISTINCT FROM NEW.linked_definition_id THEN
      RAISE EXCEPTION 'a linked draft must belong to the linked definition in this workspace'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER proposal_decision_guard BEFORE INSERT
ON mechanical_proposals_proposaldecision FOR EACH ROW
EXECUTE FUNCTION specmate_proposal_decision_guard();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS proposal_decision_guard ON mechanical_proposals_proposaldecision;
DROP FUNCTION IF EXISTS specmate_proposal_decision_guard();
DROP TRIGGER IF EXISTS proposal_decision_immutable ON mechanical_proposals_proposaldecision;
"""


class Migration(migrations.Migration):
    dependencies = [("mechanical_proposals", "0003_decisions")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
