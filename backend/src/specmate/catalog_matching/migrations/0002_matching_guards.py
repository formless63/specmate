from django.db import migrations

FORWARD = """
CREATE TRIGGER matching_candidate_immutable BEFORE UPDATE OR DELETE ON catalog_matching_matchcandidate FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
CREATE TRIGGER matching_review_immutable BEFORE UPDATE OR DELETE ON catalog_matching_matchreview FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
CREATE FUNCTION specmate_matching_distinct_definitions() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM design_revision s, design_revision t
    WHERE s.id = NEW.source_revision_id AND t.id = NEW.target_revision_id
      AND s.definition_id = t.definition_id
  ) THEN
    RAISE EXCEPTION 'matching requires distinct definitions' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER matching_distinct_definitions BEFORE INSERT ON catalog_matching_matchcandidate FOR EACH ROW EXECUTE FUNCTION specmate_matching_distinct_definitions();
CREATE FUNCTION specmate_matching_review_sequence() RETURNS trigger AS $$
DECLARE prior_version integer;
BEGIN
  PERFORM id FROM catalog_matching_matchcandidate WHERE id = NEW.candidate_id FOR UPDATE;
  SELECT COALESCE(MAX(version), 0) INTO prior_version FROM catalog_matching_matchreview WHERE candidate_id = NEW.candidate_id;
  IF NEW.version != prior_version + 1 THEN
    RAISE EXCEPTION 'matching review sequence mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER matching_review_sequence BEFORE INSERT ON catalog_matching_matchreview FOR EACH ROW EXECUTE FUNCTION specmate_matching_review_sequence();
"""
REVERSE = """
DROP TRIGGER matching_review_sequence ON catalog_matching_matchreview;
DROP FUNCTION specmate_matching_review_sequence();
DROP TRIGGER matching_distinct_definitions ON catalog_matching_matchcandidate;
DROP FUNCTION specmate_matching_distinct_definitions();
DROP TRIGGER matching_review_immutable ON catalog_matching_matchreview;
DROP TRIGGER matching_candidate_immutable ON catalog_matching_matchcandidate;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("catalog_matching", "0001_initial"),
        ("operations", "0002_immutable_rows"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
