from django.db import migrations

FORWARD = """
CREATE TRIGGER catalog_lifecycle_immutable BEFORE UPDATE OR DELETE ON catalog_definitionlifecycle
FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE FUNCTION specmate_catalog_lifecycle_guard() RETURNS trigger AS $$
DECLARE owning_workspace uuid; latest_sequence integer;
BEGIN
  SELECT workspace_id INTO owning_workspace FROM design_definition WHERE id=NEW.definition_id;
  PERFORM 1 FROM access_workspace WHERE id=owning_workspace FOR UPDATE;
  SELECT COALESCE(MAX(sequence),0) INTO latest_sequence
    FROM catalog_definitionlifecycle WHERE definition_id=NEW.definition_id;
  IF NEW.sequence <> latest_sequence + 1 THEN
    RAISE EXCEPTION 'catalog lifecycle sequence mismatch' USING ERRCODE='check_violation';
  END IF;
  IF NEW.replacement_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM design_revision r JOIN design_definition d ON d.id=r.definition_id
    WHERE r.id=NEW.replacement_id AND d.workspace_id=owning_workspace AND d.id<>NEW.definition_id
  ) THEN
    RAISE EXCEPTION 'catalog replacement scope mismatch' USING ERRCODE='check_violation';
  END IF;
  IF NEW.replacement_id IS NOT NULL AND EXISTS (
    WITH RECURSIVE chain(definition_id, visited) AS (
      SELECT definition_id, ARRAY[definition_id] FROM design_revision WHERE id=NEW.replacement_id
      UNION ALL
      SELECT r.definition_id, c.visited || r.definition_id FROM chain c
      JOIN LATERAL (SELECT replacement_id FROM catalog_definitionlifecycle
        WHERE definition_id=c.definition_id ORDER BY sequence DESC LIMIT 1) e ON TRUE
      JOIN design_revision r ON r.id=e.replacement_id WHERE NOT r.definition_id=ANY(c.visited)
    ) SELECT 1 FROM chain WHERE definition_id=NEW.definition_id
  ) THEN
    RAISE EXCEPTION 'catalog replacement cycle' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER catalog_lifecycle_guard BEFORE INSERT ON catalog_definitionlifecycle
FOR EACH ROW EXECUTE FUNCTION specmate_catalog_lifecycle_guard();
"""

REVERSE = """
DROP TRIGGER IF EXISTS catalog_lifecycle_guard ON catalog_definitionlifecycle;
DROP FUNCTION IF EXISTS specmate_catalog_lifecycle_guard();
DROP TRIGGER IF EXISTS catalog_lifecycle_immutable ON catalog_definitionlifecycle;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("catalog", "0004_definition_lifecycle"),
        ("access", "0004_project_release_references"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
