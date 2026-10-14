"""Consolidated pre-1.0 database guards (immutability, sequencing and same-workspace
relationships). Hand-maintained SQL; see docs/DOMAIN.md."""

from django.db import migrations

FORWARD = r"""
CREATE TRIGGER prep_document_set_immutable BEFORE UPDATE OR DELETE
ON preparation_documents_documentset FOR EACH ROW
EXECUTE FUNCTION specmate_reject_mutation();

CREATE TRIGGER prep_document_output_immutable BEFORE UPDATE OR DELETE
ON preparation_documents_documentoutput FOR EACH ROW
EXECUTE FUNCTION specmate_reject_mutation();

CREATE FUNCTION specmate_prep_document_identity() RETURNS trigger AS $$
BEGIN
  IF NEW.configuration->>'root_revision_id' IS DISTINCT FROM NEW.root_revision_id::text
    OR NEW.manifest->'inputs'->'root'->>'revision_id' IS DISTINCT FROM NEW.root_revision_id::text
    OR NEW.manifest->>'inputs_sha256' IS DISTINCT FROM NEW.sha256
    OR NEW.manifest->'inputs'->>'generator' IS DISTINCT FROM NEW.generator THEN
    RAISE EXCEPTION 'inconsistent document receipt pins' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prep_document_identity BEFORE INSERT
ON preparation_documents_documentset FOR EACH ROW
EXECUTE FUNCTION specmate_prep_document_identity();

CREATE FUNCTION specmate_prep_output_identity() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM preparation_documents_documentset s,
    LATERAL jsonb_array_elements(s.manifest->'outputs') o
    WHERE s.id = NEW.document_set_id
      AND o->>'filename' = NEW.filename AND o->>'sha256' = NEW.sha256
      AND o->>'size' = NEW.size::text AND o->>'media_type' = NEW.media_type
      AND o->>'rights' = NEW.rights AND o->>'inputs_sha256' = s.sha256
  ) THEN
    RAISE EXCEPTION 'output does not match immutable manifest' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prep_output_identity BEFORE INSERT
ON preparation_documents_documentoutput FOR EACH ROW
EXECUTE FUNCTION specmate_prep_output_identity();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS prep_output_identity ON preparation_documents_documentoutput;
DROP FUNCTION IF EXISTS specmate_prep_output_identity();
DROP TRIGGER IF EXISTS prep_document_identity ON preparation_documents_documentset;
DROP FUNCTION IF EXISTS specmate_prep_document_identity();
DROP TRIGGER IF EXISTS prep_document_output_immutable ON preparation_documents_documentoutput;
DROP TRIGGER IF EXISTS prep_document_set_immutable ON preparation_documents_documentset;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("operations", "0002_guards"),
        ("preparation_documents", "0001_initial"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
