"""Releases are immutable; every pin stays inside the release workspace.
Hand-maintained SQL; see docs/modules/releases.md."""

from django.db import migrations

FORWARD = r"""
CREATE TRIGGER releases_release_immutable BEFORE UPDATE OR DELETE
ON releases_release FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE TRIGGER releases_pin_immutable BEFORE UPDATE OR DELETE
ON releases_releasepin FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE TRIGGER releases_configuration_immutable BEFORE UPDATE OR DELETE
ON releases_releaseconfiguration FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE FUNCTION specmate_release_root_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM design_revision v JOIN design_definition d ON d.id = v.definition_id
    WHERE v.id = NEW.root_revision_id AND d.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'a release root stays inside the release workspace'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER releases_release_root_guard BEFORE INSERT ON releases_release
FOR EACH ROW EXECUTE FUNCTION specmate_release_root_guard();

CREATE FUNCTION specmate_release_pin_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM releases_release r
      JOIN design_revision v ON v.id = NEW.revision_id
      JOIN design_definition d ON d.id = v.definition_id
    WHERE r.id = NEW.release_id AND d.workspace_id = r.workspace_id
  ) THEN
    RAISE EXCEPTION 'release pins stay inside the release workspace'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER releases_pin_guard BEFORE INSERT ON releases_releasepin
FOR EACH ROW EXECUTE FUNCTION specmate_release_pin_guard();

CREATE FUNCTION specmate_release_configuration_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM releases_release r
      JOIN configurations_resolvedconfiguration c ON c.id = NEW.configuration_id
    WHERE r.id = NEW.release_id AND c.workspace_id = r.workspace_id
  ) THEN
    RAISE EXCEPTION 'release configurations stay inside the release workspace'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER releases_configuration_guard BEFORE INSERT ON releases_releaseconfiguration
FOR EACH ROW EXECUTE FUNCTION specmate_release_configuration_guard();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS releases_configuration_guard ON releases_releaseconfiguration;
DROP FUNCTION IF EXISTS specmate_release_configuration_guard();
DROP TRIGGER IF EXISTS releases_pin_guard ON releases_releasepin;
DROP FUNCTION IF EXISTS specmate_release_pin_guard();
DROP TRIGGER IF EXISTS releases_release_root_guard ON releases_release;
DROP FUNCTION IF EXISTS specmate_release_root_guard();
DROP TRIGGER IF EXISTS releases_configuration_immutable ON releases_releaseconfiguration;
DROP TRIGGER IF EXISTS releases_pin_immutable ON releases_releasepin;
DROP TRIGGER IF EXISTS releases_release_immutable ON releases_release;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("design", "0002_guards"),
        ("configurations", "0004_adoption_guards"),
        ("operations", "0002_guards"),
        ("releases", "0001_initial"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
