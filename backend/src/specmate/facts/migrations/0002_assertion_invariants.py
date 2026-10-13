from django.db import migrations

FORWARD = """
CREATE TRIGGER facts_assertion_immutable BEFORE UPDATE OR DELETE ON facts_factassertion FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
CREATE TRIGGER facts_source_immutable BEFORE UPDATE OR DELETE ON facts_assertionsource FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
CREATE TRIGGER facts_input_immutable BEFORE UPDATE OR DELETE ON facts_assertioninput FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
CREATE TRIGGER facts_subject_no_delete BEFORE DELETE ON facts_factsubject FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
CREATE FUNCTION specmate_facts_subject_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'version')
     OR NEW.version != OLD.version + 1 OR NOT EXISTS (
       SELECT 1 FROM facts_factassertion WHERE subject_id = OLD.id AND sequence = OLD.version
     )) THEN
    RAISE EXCEPTION 'subject identity is immutable; version follows assertion append' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version < 1 OR jsonb_typeof(NEW.path) != 'array' THEN
    RAISE EXCEPTION 'invalid fact subject state' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.definition_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM design_definition WHERE id = NEW.definition_id AND project_id = NEW.project_id
    )) OR (NEW.revision_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM design_revision r JOIN design_definition d ON d.id = r.definition_id
      WHERE r.id = NEW.revision_id AND d.project_id = NEW.project_id
    )) OR (NEW.snapshot_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM design_snapshot s JOIN design_definition d ON d.id = s.definition_id
      WHERE s.id = NEW.snapshot_id AND d.project_id = NEW.project_id
    )) THEN
    RAISE EXCEPTION 'fact subject scope mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER facts_subject_guard BEFORE INSERT OR UPDATE ON facts_factsubject FOR EACH ROW EXECUTE FUNCTION specmate_facts_subject_guard();
CREATE FUNCTION specmate_facts_assertion_guard() RETURNS trigger AS $$
DECLARE e jsonb;
BEGIN
  IF NEW.sequence < 1 OR NOT EXISTS (
    SELECT 1 FROM facts_factsubject WHERE id = NEW.subject_id AND version = NEW.sequence
  ) OR NEW.content->>'status' IS DISTINCT FROM NEW.status
     OR NEW.content->>'property' IS DISTINCT FROM NEW.property
     OR NEW.content->'provenance'->>'method' IS DISTINCT FROM NEW.method
     OR jsonb_typeof(NEW.content->'provenance'->'evidence') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'assertion identity/content mismatch' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.status = 'known' AND (jsonb_typeof(NEW.content->'value') IS DISTINCT FROM 'object'
       OR jsonb_typeof(NEW.canonical_value) IS DISTINCT FROM 'object'))
     OR (NEW.status != 'known' AND COALESCE(NEW.content->'value', 'null'::jsonb) != 'null'::jsonb) THEN
    RAISE EXCEPTION 'unknown facts cannot contain guessed values' USING ERRCODE = 'check_violation';
  END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(NEW.content->'provenance'->'evidence') LOOP
    IF e->>'kind' = 'assertion' AND (e->>'assertion_id' = NEW.id::text OR NOT EXISTS (
      SELECT 1 FROM facts_factassertion WHERE id::text = e->>'assertion_id'
    )) THEN
      RAISE EXCEPTION 'assertion inputs must already exist' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER facts_assertion_guard BEFORE INSERT ON facts_factassertion FOR EACH ROW EXECUTE FUNCTION specmate_facts_assertion_guard();
CREATE FUNCTION specmate_facts_link_guard() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'facts_assertioninput' THEN
    IF NOT EXISTS (
      SELECT 1 FROM facts_factassertion a, jsonb_array_elements(a.content->'provenance'->'evidence') e
      WHERE a.id = NEW.assertion_id AND e->>'kind' = 'assertion'
        AND e->>'assertion_id' = NEW.input_assertion_id::text
    ) THEN
      RAISE EXCEPTION 'input link must match immutable provenance' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM facts_factassertion a, jsonb_array_elements(a.content->'provenance'->'evidence') e,
        sources_sourcebundlefile f
      WHERE a.id = NEW.assertion_id AND f.id = NEW.source_file_id AND e->>'kind' = 'source_file'
        AND e->>'bundle_revision_id' = f.revision_id::text AND e->>'path' = f.path
    ) THEN
      RAISE EXCEPTION 'source link must match immutable provenance' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER facts_input_guard BEFORE INSERT ON facts_assertioninput FOR EACH ROW EXECUTE FUNCTION specmate_facts_link_guard();
CREATE TRIGGER facts_source_guard BEFORE INSERT ON facts_assertionsource FOR EACH ROW EXECUTE FUNCTION specmate_facts_link_guard();
"""

REVERSE = """
DROP TRIGGER facts_source_guard ON facts_assertionsource;
DROP TRIGGER facts_input_guard ON facts_assertioninput;
DROP FUNCTION specmate_facts_link_guard();
DROP TRIGGER facts_assertion_guard ON facts_factassertion;
DROP FUNCTION specmate_facts_assertion_guard();
DROP TRIGGER facts_subject_guard ON facts_factsubject;
DROP FUNCTION specmate_facts_subject_guard();
DROP TRIGGER facts_subject_no_delete ON facts_factsubject;
DROP TRIGGER facts_input_immutable ON facts_assertioninput;
DROP TRIGGER facts_source_immutable ON facts_assertionsource;
DROP TRIGGER facts_assertion_immutable ON facts_factassertion;
"""


class Migration(migrations.Migration):
    dependencies = [("facts", "0001_initial"), ("operations", "0002_immutable_rows")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
