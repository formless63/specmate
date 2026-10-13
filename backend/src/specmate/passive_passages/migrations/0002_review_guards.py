from django.db import migrations

FORWARD = """
CREATE TRIGGER passage_review_immutable BEFORE UPDATE OR DELETE ON passive_passages_passagereview FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
CREATE FUNCTION specmate_passage_review_sequence() RETURNS trigger AS $$
DECLARE prior_version integer;
BEGIN
  PERFORM id FROM design_revision WHERE id = NEW.model_revision_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM design_revision r JOIN design_definition d ON d.id = r.definition_id
    WHERE r.id = NEW.model_revision_id AND d.kind = 'passage_model'
  ) THEN
    RAISE EXCEPTION 'passage review requires an exact passive model revision' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(MAX(version), 0) INTO prior_version FROM passive_passages_passagereview WHERE model_revision_id = NEW.model_revision_id;
  IF NEW.version != prior_version + 1 THEN
    RAISE EXCEPTION 'passage review sequence mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER passage_review_sequence BEFORE INSERT ON passive_passages_passagereview FOR EACH ROW EXECUTE FUNCTION specmate_passage_review_sequence();
"""
REVERSE = """
DROP TRIGGER passage_review_sequence ON passive_passages_passagereview;
DROP FUNCTION specmate_passage_review_sequence();
DROP TRIGGER passage_review_immutable ON passive_passages_passagereview;
"""


class Migration(migrations.Migration):
    dependencies = [("passive_passages", "0001_initial"), ("operations", "0002_immutable_rows")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
