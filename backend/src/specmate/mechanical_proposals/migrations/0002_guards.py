"""Consolidated pre-1.0 database guards (immutability, sequencing and same-workspace
relationships). Hand-maintained SQL; see docs/DOMAIN.md."""

from django.db import migrations

FORWARD = r"""
CREATE TRIGGER proposal_revision_immutable BEFORE UPDATE OR DELETE
ON mechanical_proposals_proposalrevision FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE TRIGGER proposal_draft_no_delete BEFORE DELETE
ON mechanical_proposals_proposaldraft FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE FUNCTION specmate_proposal_draft_guard() RETURNS trigger AS $$
DECLARE board_workspace uuid;
BEGIN
  SELECT b.workspace_id INTO board_workspace
    FROM pcb_pcbinterpretation i
    JOIN pcb_pcbextractionattempt a ON a.id = i.attempt_id
    JOIN pcb_pcbintake t ON t.id = a.intake_id
    JOIN sources_sourcebundlerevision r ON r.id = t.source_revision_id
    JOIN sources_sourcebundle b ON b.id = r.bundle_id
    WHERE i.id = NEW.interpretation_id;
  IF NEW.workspace_id IS DISTINCT FROM board_workspace THEN
    RAISE EXCEPTION 'proposal draft and its board interpretation must share a workspace'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (
       NEW.workspace_id != OLD.workspace_id OR NEW.interpretation_id != OLD.interpretation_id
       OR NEW.created_by_id != OLD.created_by_id OR NEW.created_at != OLD.created_at
       OR NEW.version != OLD.version + 1) THEN
    RAISE EXCEPTION 'a proposal draft keeps its board and advances one version per edit'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER proposal_draft_guard BEFORE INSERT OR UPDATE
ON mechanical_proposals_proposaldraft FOR EACH ROW EXECUTE FUNCTION specmate_proposal_draft_guard();

CREATE FUNCTION specmate_proposal_revision_guard() RETURNS trigger AS $$
DECLARE d record; board_hash text; doc jsonb;
BEGIN
  SELECT * INTO d FROM mechanical_proposals_proposaldraft WHERE id = NEW.draft_id;
  SELECT sha256 INTO board_hash FROM pcb_pcbinterpretation WHERE id = NEW.interpretation_id;
  doc := convert_from(NEW.canonical, 'UTF8')::jsonb;
  IF NEW.workspace_id IS DISTINCT FROM d.workspace_id
    OR NEW.interpretation_id IS DISTINCT FROM d.interpretation_id
    OR NEW.interpretation_sha256 IS DISTINCT FROM board_hash
    OR NEW.sha256 != encode(sha256(NEW.canonical), 'hex')
    OR NEW.draft_version > d.version
    OR doc->>'draft_id' IS DISTINCT FROM NEW.draft_id::text
    OR (doc->>'draft_version')::int IS DISTINCT FROM NEW.draft_version
    OR doc->'proposal'->>'generator' IS DISTINCT FROM NEW.generator
    OR doc->'proposal'->>'status' IS DISTINCT FROM NEW.status
    OR doc->'proposal'->'board'->>'interpretation_id' IS DISTINCT FROM NEW.interpretation_id::text
    OR doc->'proposal'->'board'->>'interpretation_sha256' IS DISTINCT FROM NEW.interpretation_sha256
    OR doc->'proposal'->'qualification'->>'physical' IS DISTINCT FROM 'false'
  THEN
    RAISE EXCEPTION 'a retained proposal must pin its draft, board and generated document'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER proposal_revision_guard BEFORE INSERT
ON mechanical_proposals_proposalrevision FOR EACH ROW
EXECUTE FUNCTION specmate_proposal_revision_guard();

CREATE TRIGGER mechanical_proposals_proposaldraft_workspace_fixed BEFORE UPDATE ON mechanical_proposals_proposaldraft
FOR EACH ROW EXECUTE FUNCTION specmate_preserve_workspace();

CREATE TRIGGER mechanical_proposals_proposalrevision_workspace_fixed BEFORE UPDATE ON mechanical_proposals_proposalrevision
FOR EACH ROW EXECUTE FUNCTION specmate_preserve_workspace();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS mechanical_proposals_proposalrevision_workspace_fixed ON mechanical_proposals_proposalrevision;
DROP TRIGGER IF EXISTS mechanical_proposals_proposaldraft_workspace_fixed ON mechanical_proposals_proposaldraft;
DROP TRIGGER IF EXISTS proposal_revision_guard ON mechanical_proposals_proposalrevision;
DROP FUNCTION IF EXISTS specmate_proposal_revision_guard();
DROP TRIGGER IF EXISTS proposal_draft_guard ON mechanical_proposals_proposaldraft;
DROP FUNCTION IF EXISTS specmate_proposal_draft_guard();
DROP TRIGGER IF EXISTS proposal_draft_no_delete ON mechanical_proposals_proposaldraft;
DROP TRIGGER IF EXISTS proposal_revision_immutable ON mechanical_proposals_proposalrevision;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("mechanical_proposals", "0001_initial"),
        ("operations", "0002_guards"),
        ("pcb", "0001_initial"),
        ("sources", "0001_initial"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
