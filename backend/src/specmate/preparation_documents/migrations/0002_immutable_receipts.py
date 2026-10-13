from django.db import migrations

FORWARD = """
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
"""
REVERSE = """
DROP TRIGGER prep_document_identity ON preparation_documents_documentset;
DROP FUNCTION specmate_prep_document_identity();
DROP TRIGGER prep_document_output_immutable ON preparation_documents_documentoutput;
DROP TRIGGER prep_document_set_immutable ON preparation_documents_documentset;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("preparation_documents", "0001_initial"),
        ("operations", "0002_immutable_rows"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
