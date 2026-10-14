"""Consolidated pre-1.0 database guards (immutability, sequencing and same-workspace
relationships). Hand-maintained SQL; see docs/DOMAIN.md."""

from django.db import migrations

FORWARD = r"""
CREATE TRIGGER sources_sourcebundlerevision_immutable BEFORE UPDATE OR DELETE ON sources_sourcebundlerevision FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE TRIGGER sources_sourcebundlefile_immutable BEFORE UPDATE OR DELETE ON sources_sourcebundlefile FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE TRIGGER sources_sourceblob_immutable BEFORE UPDATE OR DELETE ON sources_sourceblob FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE FUNCTION specmate_validate_archive_expansion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parser <> 'specmate-classic-zip-v1' OR NOT EXISTS (
    SELECT 1 FROM sources_sourcebundlerevision r
    JOIN sources_sourcebundle b ON b.id = r.bundle_id
    JOIN sources_sourcebundlefile f ON f.id = NEW.archive_file_id
    JOIN sources_sourcebundlerevision original ON original.id = f.revision_id
    JOIN sources_sourcebundle original_bundle ON original_bundle.id = original.bundle_id
    JOIN sources_sourceblob blob ON blob.id = f.blob_id
    WHERE r.id = NEW.revision_id AND r.number = 1 AND b.role = 'derivative'
      AND b.derived_from_id = original.id AND original_bundle.role = 'original'
      AND b.workspace_id = original_bundle.workspace_id AND blob.workspace_id = b.workspace_id
  ) THEN
    RAISE EXCEPTION 'Invalid archive expansion provenance';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sources_archive_expansion_valid BEFORE INSERT ON sources_sourcearchiveexpansion
FOR EACH ROW EXECUTE FUNCTION specmate_validate_archive_expansion();

CREATE TRIGGER sources_archive_expansion_immutable BEFORE UPDATE OR DELETE
ON sources_sourcearchiveexpansion FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE FUNCTION specmate_preserve_archive_bundle_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.workspace_id, NEW.role, NEW.derived_from_id)
       IS DISTINCT FROM (OLD.workspace_id, OLD.role, OLD.derived_from_id)
     AND EXISTS (
       SELECT 1 FROM sources_sourcearchiveexpansion e
       JOIN sources_sourcebundlerevision r ON r.id = e.revision_id
       JOIN sources_sourcebundlefile f ON f.id = e.archive_file_id
       JOIN sources_sourcebundlerevision original ON original.id = f.revision_id
       WHERE r.bundle_id = OLD.id OR original.bundle_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'Archive provenance bundle identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sources_archive_bundle_identity BEFORE UPDATE ON sources_sourcebundle
FOR EACH ROW EXECUTE FUNCTION specmate_preserve_archive_bundle_identity();

CREATE FUNCTION specmate_validate_edit_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.marker NOT IN ('matched', 'absent')
     OR length(NEW.review_sha256) <> 64
     OR (NEW.archive_file_id IS NULL) <> (NEW.parser = '')
     OR (NEW.archive_file_id IS NOT NULL AND NEW.parser <> 'specmate-classic-zip-v1')
     OR NOT EXISTS (
    SELECT 1 FROM sources_sourcebundlerevision r
    JOIN sources_sourcebundle b ON b.id = r.bundle_id
    JOIN sources_sourcebundlerevision base ON base.id = NEW.baseline_id
    JOIN sources_sourcebundle base_bundle ON base_bundle.id = base.bundle_id
    WHERE r.id = NEW.revision_id AND b.role = 'derivative'
      AND b.workspace_id = base_bundle.workspace_id
      AND ((r.number = 1 AND b.derived_from_id = base.id)
        OR (r.bundle_id = base.bundle_id AND r.number = base.number + 1))
  ) OR (NEW.archive_file_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sources_sourcebundlefile f
    JOIN sources_sourcebundlerevision archive ON archive.id = f.revision_id
    JOIN sources_sourcebundle archive_bundle ON archive_bundle.id = archive.bundle_id
    JOIN sources_sourceblob blob ON blob.id = f.blob_id
    JOIN sources_sourcebundlerevision r ON r.id = NEW.revision_id
    JOIN sources_sourcebundle b ON b.id = r.bundle_id
    WHERE f.id = NEW.archive_file_id AND archive_bundle.role = 'original'
      AND archive_bundle.workspace_id = b.workspace_id AND blob.workspace_id = b.workspace_id
  )) THEN
    RAISE EXCEPTION 'Invalid edit submission provenance';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sources_edit_submission_valid BEFORE INSERT ON sources_sourceeditsubmission
FOR EACH ROW EXECUTE FUNCTION specmate_validate_edit_submission();

CREATE TRIGGER sources_edit_submission_immutable BEFORE UPDATE OR DELETE
ON sources_sourceeditsubmission FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE FUNCTION specmate_preserve_edit_bundle_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.workspace_id, NEW.role, NEW.derived_from_id)
       IS DISTINCT FROM (OLD.workspace_id, OLD.role, OLD.derived_from_id)
     AND EXISTS (
       SELECT 1 FROM sources_sourceeditsubmission e
       JOIN sources_sourcebundlerevision r ON r.id = e.revision_id
       JOIN sources_sourcebundlerevision base ON base.id = e.baseline_id
       LEFT JOIN sources_sourcebundlefile f ON f.id = e.archive_file_id
       LEFT JOIN sources_sourcebundlerevision archive ON archive.id = f.revision_id
       WHERE r.bundle_id = OLD.id OR base.bundle_id = OLD.id OR archive.bundle_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'Edit provenance bundle identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sources_edit_bundle_identity BEFORE UPDATE ON sources_sourcebundle
FOR EACH ROW EXECUTE FUNCTION specmate_preserve_edit_bundle_identity();

CREATE TRIGGER sources_sourceblob_workspace_fixed BEFORE UPDATE ON sources_sourceblob
FOR EACH ROW EXECUTE FUNCTION specmate_preserve_workspace();

CREATE TRIGGER sources_sourcebundle_workspace_fixed BEFORE UPDATE ON sources_sourcebundle
FOR EACH ROW EXECUTE FUNCTION specmate_preserve_workspace();

CREATE FUNCTION specmate_validate_bundle_ancestry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.derived_from_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sources_sourcebundlerevision r
    JOIN sources_sourcebundle origin ON origin.id = r.bundle_id
    WHERE r.id = NEW.derived_from_id AND origin.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'Derived bundles stay in their origin workspace';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sources_bundle_ancestry_same_workspace
BEFORE INSERT OR UPDATE OF workspace_id, derived_from_id ON sources_sourcebundle
FOR EACH ROW EXECUTE FUNCTION specmate_validate_bundle_ancestry();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS sources_bundle_ancestry_same_workspace ON sources_sourcebundle;
DROP FUNCTION IF EXISTS specmate_validate_bundle_ancestry();
DROP TRIGGER IF EXISTS sources_sourcebundle_workspace_fixed ON sources_sourcebundle;
DROP TRIGGER IF EXISTS sources_sourceblob_workspace_fixed ON sources_sourceblob;
DROP TRIGGER IF EXISTS sources_edit_bundle_identity ON sources_sourcebundle;
DROP FUNCTION IF EXISTS specmate_preserve_edit_bundle_identity();
DROP TRIGGER IF EXISTS sources_edit_submission_immutable ON sources_sourceeditsubmission;
DROP TRIGGER IF EXISTS sources_edit_submission_valid ON sources_sourceeditsubmission;
DROP FUNCTION IF EXISTS specmate_validate_edit_submission();
DROP TRIGGER IF EXISTS sources_archive_bundle_identity ON sources_sourcebundle;
DROP FUNCTION IF EXISTS specmate_preserve_archive_bundle_identity();
DROP TRIGGER IF EXISTS sources_archive_expansion_immutable ON sources_sourcearchiveexpansion;
DROP TRIGGER IF EXISTS sources_archive_expansion_valid ON sources_sourcearchiveexpansion;
DROP FUNCTION IF EXISTS specmate_validate_archive_expansion();
DROP TRIGGER IF EXISTS sources_sourceblob_immutable ON sources_sourceblob;
DROP TRIGGER IF EXISTS sources_sourcebundlefile_immutable ON sources_sourcebundlefile;
DROP TRIGGER IF EXISTS sources_sourcebundlerevision_immutable ON sources_sourcebundlerevision;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("operations", "0002_guards"),
        ("sources", "0001_initial"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
