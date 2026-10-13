from django.db import migrations

FORWARD = """
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
REVERSE = """
DROP TRIGGER prep_output_identity ON preparation_documents_documentoutput;
DROP FUNCTION specmate_prep_output_identity();
"""


class Migration(migrations.Migration):
    dependencies = [("preparation_documents", "0002_immutable_receipts")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
