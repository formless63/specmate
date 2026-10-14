"""Consolidated pre-1.0 database guards (immutability, sequencing and same-workspace
relationships). Hand-maintained SQL; see docs/DOMAIN.md."""

from django.db import migrations

FORWARD = r"""
CREATE TRIGGER collaboration_review_no_delete BEFORE DELETE ON collaboration_changereview
FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE FUNCTION specmate_collaboration_review_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.version != 1 THEN
      RAISE EXCEPTION 'new review starts at version one' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'version')
     OR NEW.version != OLD.version + 1 OR NOT EXISTS (
       SELECT 1 FROM collaboration_reviewentry WHERE review_id = OLD.id AND number = NEW.version
     ) THEN
    RAISE EXCEPTION 'review identity and exact inputs are immutable; version follows entry'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER collaboration_review_guard BEFORE INSERT OR UPDATE ON collaboration_changereview
FOR EACH ROW EXECUTE FUNCTION specmate_collaboration_review_guard();

CREATE TRIGGER collaboration_entry_immutable BEFORE UPDATE OR DELETE ON collaboration_reviewentry
FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE TRIGGER collaboration_recipient_immutable BEFORE UPDATE OR DELETE ON collaboration_reviewrecipient
FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE FUNCTION specmate_collaboration_recipient_guard() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM collaboration_reviewentry WHERE review_id = NEW.review_id) THEN
    RAISE EXCEPTION 'recipients are captured before review opens' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER collaboration_recipient_guard BEFORE INSERT ON collaboration_reviewrecipient
FOR EACH ROW EXECUTE FUNCTION specmate_collaboration_recipient_guard();

CREATE FUNCTION specmate_collaboration_entry_guard() RETURNS trigger AS $$
DECLARE expected integer;
BEGIN
  SELECT version + 1 INTO expected FROM collaboration_changereview WHERE id = NEW.review_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM collaboration_reviewentry WHERE review_id = NEW.review_id) THEN expected := 1; END IF;
  IF NEW.number != expected OR (NEW.action = 'opened') != (NEW.number = 1)
     OR (NEW.action = 'upgrade_proposed') != (NEW.upgrade_proposal_id IS NOT NULL)
     OR (NEW.evidence_status = 'registered_file') != (NEW.source_file_id IS NOT NULL)
     OR NEW.evidence_status NOT IN ('unknown', 'unverified_citation', 'registered_file')
     OR (NEW.evidence_status = 'unverified_citation') != (NEW.citation IS NOT NULL)
     OR NEW.citation = ''
     OR (NEW.upgrade_proposal_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM revision_upgrades_upgradeproposal u JOIN collaboration_changereview r
         ON u.old_revision_id = r.old_revision_id AND u.candidate_revision_id = r.candidate_revision_id
       WHERE r.id = NEW.review_id AND u.id = NEW.upgrade_proposal_id
     )) THEN
    RAISE EXCEPTION 'review entry sequence or exact provenance mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER collaboration_entry_guard BEFORE INSERT ON collaboration_reviewentry
FOR EACH ROW EXECUTE FUNCTION specmate_collaboration_entry_guard();

CREATE FUNCTION specmate_collaboration_notification_insert_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.read_at IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM collaboration_reviewentry e JOIN collaboration_changereview r ON r.id = e.review_id
    WHERE e.id = NEW.entry_id AND (r.created_by_id = NEW.recipient_id OR EXISTS (
      SELECT 1 FROM collaboration_reviewrecipient p
        WHERE p.review_id = r.id AND p.user_id = NEW.recipient_id
    ))
  ) THEN
    RAISE EXCEPTION 'notification must be an unread assigned-recipient or creator pointer'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER collaboration_notification_insert_guard BEFORE INSERT
ON collaboration_internalnotification FOR EACH ROW
EXECUTE FUNCTION specmate_collaboration_notification_insert_guard();

CREATE FUNCTION specmate_collaboration_notification_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.read_at IS NOT NULL OR NEW.read_at IS NULL
     OR (to_jsonb(NEW) - 'read_at') IS DISTINCT FROM (to_jsonb(OLD) - 'read_at') THEN
    RAISE EXCEPTION 'internal notification pointer is immutable and acknowledged once'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER collaboration_notification_guard BEFORE UPDATE OR DELETE ON collaboration_internalnotification
FOR EACH ROW EXECUTE FUNCTION specmate_collaboration_notification_guard();

CREATE FUNCTION specmate_collaboration_review_workspace() RETURNS trigger AS $$
BEGIN
  IF (SELECT count(*) FROM design_revision r JOIN design_definition d ON d.id = r.definition_id
      WHERE r.id IN (NEW.old_revision_id, NEW.candidate_revision_id)
        AND d.workspace_id = NEW.workspace_id)
     != (CASE WHEN NEW.old_revision_id = NEW.candidate_revision_id THEN 1 ELSE 2 END) THEN
    RAISE EXCEPTION 'reviewed revisions must belong to the review workspace'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER collaboration_changereview_workspace BEFORE INSERT
ON collaboration_changereview FOR EACH ROW EXECUTE FUNCTION specmate_collaboration_review_workspace();

CREATE TRIGGER collaboration_changereview_workspace_fixed BEFORE UPDATE ON collaboration_changereview
FOR EACH ROW EXECUTE FUNCTION specmate_preserve_workspace();

CREATE TRIGGER collaboration_changereview_project_context BEFORE INSERT OR UPDATE ON collaboration_changereview
FOR EACH ROW EXECUTE FUNCTION specmate_project_context();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS collaboration_changereview_project_context ON collaboration_changereview;
DROP TRIGGER IF EXISTS collaboration_changereview_workspace_fixed ON collaboration_changereview;
DROP TRIGGER IF EXISTS collaboration_changereview_workspace ON collaboration_changereview;
DROP FUNCTION IF EXISTS specmate_collaboration_review_workspace();
DROP TRIGGER IF EXISTS collaboration_notification_guard ON collaboration_internalnotification;
DROP FUNCTION IF EXISTS specmate_collaboration_notification_guard();
DROP TRIGGER IF EXISTS collaboration_notification_insert_guard ON collaboration_internalnotification;
DROP FUNCTION IF EXISTS specmate_collaboration_notification_insert_guard();
DROP TRIGGER IF EXISTS collaboration_entry_guard ON collaboration_reviewentry;
DROP FUNCTION IF EXISTS specmate_collaboration_entry_guard();
DROP TRIGGER IF EXISTS collaboration_recipient_guard ON collaboration_reviewrecipient;
DROP FUNCTION IF EXISTS specmate_collaboration_recipient_guard();
DROP TRIGGER IF EXISTS collaboration_recipient_immutable ON collaboration_reviewrecipient;
DROP TRIGGER IF EXISTS collaboration_entry_immutable ON collaboration_reviewentry;
DROP TRIGGER IF EXISTS collaboration_review_guard ON collaboration_changereview;
DROP FUNCTION IF EXISTS specmate_collaboration_review_guard();
DROP TRIGGER IF EXISTS collaboration_review_no_delete ON collaboration_changereview;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("collaboration", "0001_initial"),
        ("design", "0001_initial"),
        ("operations", "0002_guards"),
        ("revision_upgrades", "0001_initial"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
