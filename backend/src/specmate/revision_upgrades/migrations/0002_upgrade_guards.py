from django.db import migrations

FORWARD = """
CREATE TRIGGER upgrade_proposal_immutable BEFORE UPDATE OR DELETE ON revision_upgrades_upgradeproposal FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
CREATE TRIGGER upgrade_review_immutable BEFORE UPDATE OR DELETE ON revision_upgrades_upgradereview FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
CREATE TRIGGER upgrade_application_immutable BEFORE UPDATE OR DELETE ON revision_upgrades_upgradeapplication FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
CREATE FUNCTION specmate_upgrade_identity() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM design_revision o JOIN design_revision c ON c.definition_id = o.definition_id
    JOIN design_snapshot s ON s.id = NEW.owning_snapshot_id
    JOIN design_definition d ON d.id = s.definition_id
    WHERE o.id = NEW.old_revision_id AND c.id = NEW.candidate_revision_id
    AND c.number > o.number AND d.kind = 'assembly'
  ) OR jsonb_typeof(NEW.paths) != 'array' OR jsonb_array_length(NEW.paths) = 0 OR NEW.basis = '' THEN
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
    JOIN design_snapshot s ON s.id = p.owning_snapshot_id
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
"""
REVERSE = """
DROP TRIGGER upgrade_application_link ON revision_upgrades_upgradeapplication;
DROP FUNCTION specmate_upgrade_application_link();
DROP TRIGGER upgrade_review_sequence ON revision_upgrades_upgradereview;
DROP FUNCTION specmate_upgrade_review_sequence();
DROP TRIGGER upgrade_identity ON revision_upgrades_upgradeproposal;
DROP FUNCTION specmate_upgrade_identity();
DROP TRIGGER upgrade_application_immutable ON revision_upgrades_upgradeapplication;
DROP TRIGGER upgrade_review_immutable ON revision_upgrades_upgradereview;
DROP TRIGGER upgrade_proposal_immutable ON revision_upgrades_upgradeproposal;
"""


class Migration(migrations.Migration):
    dependencies = [("revision_upgrades", "0001_initial"), ("operations", "0002_immutable_rows")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
