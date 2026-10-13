import django.db.models.deletion
from django.db import migrations, models

FORWARD = """
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
      AND b.project_id = base_bundle.project_id
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
      AND archive_bundle.project_id = b.project_id AND blob.project_id = b.project_id
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
  IF (NEW.project_id, NEW.role, NEW.derived_from_id)
       IS DISTINCT FROM (OLD.project_id, OLD.role, OLD.derived_from_id)
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
"""
REVERSE = """
DROP TRIGGER sources_edit_bundle_identity ON sources_sourcebundle;
DROP FUNCTION specmate_preserve_edit_bundle_identity();
DROP TRIGGER sources_edit_submission_immutable ON sources_sourceeditsubmission;
DROP TRIGGER sources_edit_submission_valid ON sources_sourceeditsubmission;
DROP FUNCTION specmate_validate_edit_submission();
"""


class Migration(migrations.Migration):
    dependencies = [("sources", "0004_archive_expansion")]
    operations = [
        migrations.CreateModel(
            name="SourceEditSubmission",
            fields=[
                (
                    "revision",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.PROTECT,
                        primary_key=True,
                        related_name="edit_submission",
                        serialize=False,
                        to="sources.sourcebundlerevision",
                    ),
                ),
                ("parser", models.CharField(blank=True, max_length=100)),
                ("marker", models.CharField(max_length=20)),
                ("root_prefix", models.CharField(blank=True, max_length=512)),
                ("review_sha256", models.CharField(max_length=64)),
                ("summary", models.TextField(max_length=2000)),
                (
                    "archive_file",
                    models.ForeignKey(
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="+",
                        to="sources.sourcebundlefile",
                    ),
                ),
                (
                    "baseline",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="+",
                        to="sources.sourcebundlerevision",
                    ),
                ),
            ],
        ),
        migrations.RunSQL(FORWARD, REVERSE),
    ]
