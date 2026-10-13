from django.db import migrations, models

FORWARD = """
CREATE FUNCTION specmate_pack_dependency_acyclic() RETURNS trigger AS $$
BEGIN
  -- Serialize graph insertions, including direct writes outside the operation layer.
  PERFORM pg_advisory_xact_lock(hashtext('specmate.catalog-packs.dependency-graph'));
  IF EXISTS (
    WITH RECURSIVE closure(id) AS (
      SELECT NEW.dependency_id
      UNION
      SELECT pin.dependency_id FROM catalog_packs_versiondependency pin
        JOIN closure ON pin.version_id=closure.id
    ) SELECT 1 FROM closure WHERE id=NEW.version_id
  ) THEN
    RAISE EXCEPTION 'catalog pack dependency insertion would create a cycle'
      USING ERRCODE='check_violation', CONSTRAINT='pack_dependency_acyclic';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER pack_dependency_acyclic BEFORE INSERT ON catalog_packs_versiondependency
  FOR EACH ROW EXECUTE FUNCTION specmate_pack_dependency_acyclic();

CREATE FUNCTION specmate_pack_adoption_category() RETURNS trigger AS $$
DECLARE category text;
BEGIN
  SELECT item->>'category' INTO category
    FROM catalog_packs_versionentry entry
    JOIN catalog_packs_packversion version ON version.id=entry.version_id,
    jsonb_array_elements(convert_from(version.canonical,'UTF8')::jsonb->'entries') item
    WHERE entry.id=NEW.entry_id AND item->>'key'=entry.key;
  IF (category IN ('content','profile') AND NEW.status='draft_created')
      OR (category IN ('rule','model','recipe_reference') AND NEW.status='inert_reference')
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'catalog pack entry category and adoption result mismatch'
    USING ERRCODE='check_violation', CONSTRAINT='pack_adoption_category';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER pack_adopt_category BEFORE INSERT ON catalog_packs_adoptionentry
  FOR EACH ROW EXECUTE FUNCTION specmate_pack_adoption_category();
"""

REVERSE = """
DROP TRIGGER pack_adopt_category ON catalog_packs_adoptionentry;
DROP FUNCTION specmate_pack_adoption_category();
DROP TRIGGER pack_dependency_acyclic ON catalog_packs_versiondependency;
DROP FUNCTION specmate_pack_dependency_acyclic();
"""


class Migration(migrations.Migration):
    dependencies = [("catalog_packs", "0002_pack_guards")]
    operations = [
        migrations.AddConstraint(
            model_name="adoptionentry",
            constraint=models.UniqueConstraint(
                fields=["definition"],
                condition=models.Q(definition__isnull=False),
                name="pack_adopted_definition_unique",
            ),
        ),
        migrations.AddConstraint(
            model_name="adoptionentry",
            constraint=models.UniqueConstraint(
                fields=["draft"],
                condition=models.Q(draft__isnull=False),
                name="pack_adopted_draft_unique",
            ),
        ),
        migrations.RunSQL(FORWARD, REVERSE),
    ]
