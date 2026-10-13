from django.db import migrations

FORWARD = """
CREATE TRIGGER shared_scene_drawing_immutable BEFORE UPDATE OR DELETE
ON shared_scene_scenedrawing FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
CREATE FUNCTION specmate_scene_drawing_guard() RETURNS trigger AS $$
DECLARE snapshot_project uuid; snapshot_hash text; manifest_doc jsonb;
BEGIN
  SELECT d.project_id, s.sha256 INTO snapshot_project, snapshot_hash
    FROM design_snapshot s JOIN design_definition d ON d.id = s.definition_id
    WHERE s.id = NEW.snapshot_id;
  manifest_doc := convert_from(NEW.manifest, 'UTF8')::jsonb;
  IF NEW.project_id IS DISTINCT FROM snapshot_project
    OR NEW.svg_sha256 != encode(sha256(NEW.svg), 'hex')
    OR NEW.manifest_sha256 != encode(sha256(NEW.manifest), 'hex')
    OR manifest_doc->>'scene_snapshot_id' IS DISTINCT FROM NEW.snapshot_id::text
    OR manifest_doc->>'scene_snapshot_sha256' IS DISTINCT FROM snapshot_hash
    OR manifest_doc->>'renderer_version' IS DISTINCT FROM NEW.renderer_version
    OR manifest_doc->>'purpose' IS DISTINCT FROM NEW.purpose
    OR manifest_doc->'options' IS DISTINCT FROM NEW.options
    OR manifest_doc->'outputs'->0->>'sha256' IS DISTINCT FROM NEW.svg_sha256
    OR manifest_doc->'qualification'->>'physical' IS DISTINCT FROM 'false'
  THEN
    RAISE EXCEPTION 'drawing bytes and manifest must pin the same owned frozen scene'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER shared_scene_drawing_guard BEFORE INSERT ON shared_scene_scenedrawing
FOR EACH ROW EXECUTE FUNCTION specmate_scene_drawing_guard();
"""
REVERSE = """
DROP TRIGGER IF EXISTS shared_scene_drawing_guard ON shared_scene_scenedrawing;
DROP FUNCTION IF EXISTS specmate_scene_drawing_guard();
DROP TRIGGER IF EXISTS shared_scene_drawing_immutable ON shared_scene_scenedrawing;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("shared_scene", "0001_initial"),
        ("design", "0002_immutable_rows"),
        ("operations", "0002_immutable_rows"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
