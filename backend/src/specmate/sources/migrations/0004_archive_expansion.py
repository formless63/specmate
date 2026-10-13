import django.db.models.deletion
from django.db import migrations, models

FORWARD = """
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
      AND b.project_id = original_bundle.project_id AND blob.project_id = b.project_id
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
  IF (NEW.project_id, NEW.role, NEW.derived_from_id)
       IS DISTINCT FROM (OLD.project_id, OLD.role, OLD.derived_from_id)
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
"""
REVERSE = """
DROP TRIGGER sources_archive_bundle_identity ON sources_sourcebundle;
DROP FUNCTION specmate_preserve_archive_bundle_identity();
DROP TRIGGER sources_archive_expansion_immutable ON sources_sourcearchiveexpansion;
DROP TRIGGER sources_archive_expansion_valid ON sources_sourcearchiveexpansion;
DROP FUNCTION specmate_validate_archive_expansion();
"""


class Migration(migrations.Migration):
    dependencies = [("sources", "0003_immutable_blob_registration")]
    operations = [
        migrations.CreateModel(
            name="SourceArchiveExpansion",
            fields=[
                (
                    "revision",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.PROTECT,
                        primary_key=True,
                        related_name="archive_expansion",
                        serialize=False,
                        to="sources.sourcebundlerevision",
                    ),
                ),
                (
                    "archive_file",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="+",
                        to="sources.sourcebundlefile",
                    ),
                ),
                ("parser", models.CharField(max_length=100)),
            ],
        ),
        migrations.RunSQL(FORWARD, REVERSE),
    ]
