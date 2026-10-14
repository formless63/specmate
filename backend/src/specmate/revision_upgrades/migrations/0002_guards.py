"""Consolidated pre-1.0 database guards (immutability, sequencing and same-workspace
relationships). Hand-maintained SQL; see docs/DOMAIN.md."""

from django.db import migrations

FORWARD = r"""
CREATE TRIGGER upgrade_proposal_immutable BEFORE UPDATE OR DELETE ON revision_upgrades_upgradeproposal FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE TRIGGER upgrade_review_immutable BEFORE UPDATE OR DELETE ON revision_upgrades_upgradereview FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE TRIGGER upgrade_application_immutable BEFORE UPDATE OR DELETE ON revision_upgrades_upgradeapplication FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE FUNCTION specmate_upgrade_identity() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM design_revision o JOIN design_revision c ON TRUE
    JOIN design_definition od ON od.id = o.definition_id
    JOIN design_definition cd ON cd.id = c.definition_id
    JOIN design_snapshot s ON s.id = NEW.owning_snapshot_id
    JOIN design_definition d ON d.id = s.definition_id
    WHERE o.id = NEW.old_revision_id AND c.id = NEW.candidate_revision_id AND d.kind = 'assembly'
    AND (
      (NEW.relation = 'later_revision' AND c.definition_id = o.definition_id
        AND c.number > o.number AND NEW.replacement_basis = '')
      OR (NEW.relation = 'declared_replacement' AND c.definition_id != o.definition_id
        AND cd.kind = od.kind AND NEW.replacement_basis != '')
    )
  ) OR jsonb_typeof(NEW.paths) != 'array' OR jsonb_array_length(NEW.paths) = 0 OR NEW.basis = ''
  OR jsonb_typeof(NEW.context_path) != 'array'
  OR (jsonb_array_length(NEW.context_path) = 0) != (NEW.consumer_snapshot_id IS NULL)
  OR (NEW.consumer_snapshot_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM design_snapshot cs JOIN design_definition cdef ON cdef.id = cs.definition_id
    JOIN design_revision cr ON cr.snapshot_id = cs.id
    JOIN design_snapshotdependency dep ON dep.revision_id = cr.id
    WHERE cs.id = NEW.consumer_snapshot_id AND cdef.kind = 'assembly'
    AND dep.snapshot_id = NEW.owning_snapshot_id
  )) THEN
    RAISE EXCEPTION 'invalid exact upgrade proposal' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER upgrade_identity BEFORE INSERT ON revision_upgrades_upgradeproposal FOR EACH ROW EXECUTE FUNCTION specmate_upgrade_identity();

CREATE FUNCTION specmate_upgrade_review_sequence() RETURNS trigger AS $$
DECLARE prior_version integer;
BEGIN
  PERFORM id FROM revision_upgrades_upgradeproposal WHERE id = NEW.proposal_id FOR UPDATE;
  SELECT COALESCE(MAX(version), 0) INTO prior_version FROM revision_upgrades_upgradereview WHERE proposal_id = NEW.proposal_id;
  IF NEW.version != prior_version + 1 THEN
    RAISE EXCEPTION 'upgrade review sequence mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER upgrade_review_sequence BEFORE INSERT ON revision_upgrades_upgradereview FOR EACH ROW EXECUTE FUNCTION specmate_upgrade_review_sequence();

CREATE FUNCTION specmate_upgrade_application_link() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM revision_upgrades_upgradeproposal p
    JOIN revision_upgrades_upgradereview r ON r.proposal_id = p.id
    JOIN design_snapshot s ON s.id = COALESCE(p.consumer_snapshot_id, p.owning_snapshot_id)
    JOIN design_draft d ON d.id = NEW.draft_id
    WHERE p.id = NEW.proposal_id AND r.id = NEW.review_id AND r.decision = 'accepted'
    AND d.definition_id = s.definition_id AND d.version = NEW.draft_version
    AND r.version = (SELECT MAX(version) FROM revision_upgrades_upgradereview WHERE proposal_id = p.id)
  ) THEN
    RAISE EXCEPTION 'invalid upgrade application links' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER upgrade_application_link BEFORE INSERT ON revision_upgrades_upgradeapplication FOR EACH ROW EXECUTE FUNCTION specmate_upgrade_application_link();

ALTER TABLE revision_upgrades_upgradereview ADD CONSTRAINT upgrade_review_decisions
  CHECK (jsonb_typeof(relationship_decisions) = 'array' AND jsonb_typeof(assignment_decisions) = 'array');
"""

REVERSE = r"""
ALTER TABLE revision_upgrades_upgradereview DROP CONSTRAINT IF EXISTS upgrade_review_decisions;
DROP TRIGGER IF EXISTS upgrade_application_link ON revision_upgrades_upgradeapplication;
DROP FUNCTION IF EXISTS specmate_upgrade_application_link();
DROP TRIGGER IF EXISTS upgrade_review_sequence ON revision_upgrades_upgradereview;
DROP FUNCTION IF EXISTS specmate_upgrade_review_sequence();
DROP TRIGGER IF EXISTS upgrade_identity ON revision_upgrades_upgradeproposal;
DROP FUNCTION IF EXISTS specmate_upgrade_identity();
DROP TRIGGER IF EXISTS upgrade_application_immutable ON revision_upgrades_upgradeapplication;
DROP TRIGGER IF EXISTS upgrade_review_immutable ON revision_upgrades_upgradereview;
DROP TRIGGER IF EXISTS upgrade_proposal_immutable ON revision_upgrades_upgradeproposal;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("design", "0001_initial"),
        ("operations", "0002_guards"),
        ("revision_upgrades", "0001_initial"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
