"""Bind immutable projection history and hashes to exact retained evidence."""

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [("pcb", "0003_property_authority")]

    operations = [
        migrations.RunSQL(
            sql="""
CREATE OR REPLACE FUNCTION specmate_validate_property_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('known', 'unknown') OR NOT EXISTS (
    SELECT 1 FROM pcb_propertyauthority a
    JOIN pcb_pcbinterpretation i ON i.id = NEW.interpretation_id
    JOIN pcb_pcbextractionattempt t ON t.id = i.attempt_id
    JOIN pcb_pcbintake k ON k.id = t.intake_id
    JOIN sources_sourcebundlerevision r ON r.id = k.source_revision_id
    WHERE a.id = NEW.authority_id AND a.version = NEW.version
      AND r.id = NEW.source_revision_id AND r.bundle_id = a.owner_bundle_id
      AND k.board_path = a.owner_path AND NEW.source_path = a.owner_path
      AND i.sha256 = NEW.report_sha256
  ) THEN
    RAISE EXCEPTION 'Invalid property projection provenance';
  END IF;
  IF NEW.previous_id IS DISTINCT FROM (
    SELECT p.id FROM pcb_propertyprojection p
    WHERE p.authority_id = NEW.authority_id ORDER BY p.version DESC LIMIT 1
  ) OR (NEW.previous_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pcb_propertyprojection p
    WHERE p.id = NEW.previous_id AND p.authority_id = NEW.authority_id
      AND p.version < NEW.version AND p.id <> NEW.id
  )) THEN
    RAISE EXCEPTION 'Invalid property projection history';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM sources_sourcebundlefile f
    JOIN sources_sourceblob b ON b.id = f.blob_id
    WHERE f.revision_id = NEW.source_revision_id AND f.path = NEW.source_path
      AND b.sha256 = NEW.source_sha256
  ) OR encode(sha256(NEW.value), 'hex') <> NEW.value_sha256 THEN
    RAISE EXCEPTION 'Invalid property projection byte provenance';
  END IF;
  RETURN NEW;
END;
$$;
""",
            reverse_sql="""
CREATE OR REPLACE FUNCTION specmate_validate_property_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('known', 'unknown') OR NOT EXISTS (
    SELECT 1 FROM pcb_propertyauthority a
    JOIN pcb_pcbinterpretation i ON i.id = NEW.interpretation_id
    JOIN pcb_pcbextractionattempt t ON t.id = i.attempt_id
    JOIN pcb_pcbintake k ON k.id = t.intake_id
    JOIN sources_sourcebundlerevision r ON r.id = k.source_revision_id
    WHERE a.id = NEW.authority_id AND a.version = NEW.version
      AND r.id = NEW.source_revision_id AND r.bundle_id = a.owner_bundle_id
      AND k.board_path = a.owner_path AND NEW.source_path = a.owner_path
      AND i.sha256 = NEW.report_sha256
  ) THEN
    RAISE EXCEPTION 'Invalid property projection provenance';
  END IF;
  RETURN NEW;
END;
$$;
""",
        )
    ]
