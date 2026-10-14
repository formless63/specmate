"""Release warnings and withdrawals are append-only and stay inside the release closure.
Hand-maintained SQL; see docs/modules/releases.md."""

from django.db import migrations

FORWARD = r"""
CREATE TRIGGER releases_warning_immutable BEFORE UPDATE OR DELETE
ON releases_releasewarning FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE TRIGGER releases_withdrawal_immutable BEFORE UPDATE OR DELETE
ON releases_releasewarningwithdrawal FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE FUNCTION specmate_release_warning_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM releases_releasepin WHERE release_id = NEW.release_id AND revision_id = NEW.revision_id
  ) THEN
    RAISE EXCEPTION 'a release warning references a revision pinned by the release'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM releases_releasewarning w
    WHERE w.id = NEW.supersedes_id AND w.release_id = NEW.release_id
  ) THEN
    RAISE EXCEPTION 'a warning supersedes a warning of the same release'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER releases_warning_guard BEFORE INSERT ON releases_releasewarning
FOR EACH ROW EXECUTE FUNCTION specmate_release_warning_guard();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS releases_warning_guard ON releases_releasewarning;
DROP FUNCTION IF EXISTS specmate_release_warning_guard();
DROP TRIGGER IF EXISTS releases_withdrawal_immutable ON releases_releasewarningwithdrawal;
DROP TRIGGER IF EXISTS releases_warning_immutable ON releases_releasewarning;
"""


class Migration(migrations.Migration):
    dependencies = [("releases", "0003_warnings")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
