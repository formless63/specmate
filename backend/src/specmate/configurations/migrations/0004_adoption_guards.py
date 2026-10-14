"""Database guards for resolved-configuration adoption evidence (immutability and links).
Hand-maintained SQL; see docs/DOMAIN.md."""

from django.db import migrations

FORWARD = r"""
CREATE TRIGGER configurations_adoption_immutable BEFORE UPDATE OR DELETE
ON configurations_configurationadoption FOR EACH ROW
EXECUTE FUNCTION specmate_reject_mutation();

CREATE FUNCTION specmate_configuration_adoption_links() RETURNS trigger AS $$
BEGIN
  IF convert_from(NEW.review_canonical, 'UTF8')::jsonb IS DISTINCT FROM
        (NEW.review - 'review_sha256')
     OR encode(sha256(NEW.review_canonical), 'hex') IS DISTINCT FROM NEW.review_sha256
     OR NEW.review->>'review_sha256' IS DISTINCT FROM NEW.review_sha256
     OR NEW.review->>'eligible' IS DISTINCT FROM 'true'
     OR NEW.review->>'resolved_configuration_id'
        IS DISTINCT FROM NEW.resolved_configuration_id::text
     OR NEW.review->'option_keys' IS DISTINCT FROM NEW.option_keys
     OR convert_from(NEW.before_canonical, 'UTF8')::jsonb IS DISTINCT FROM NEW.before_content
     OR encode(sha256(NEW.before_canonical), 'hex') IS DISTINCT FROM
        NEW.review->'owner'->>'content_sha256'
     OR (NEW.before_content - 'assembly') IS DISTINCT FROM (NEW.after_content - 'assembly')
     OR NEW.created_draft IS DISTINCT FROM (NEW.review->'owner'->>'mode' = 'new_draft')
     OR (NEW.created_draft AND NEW.draft_version != 1)
     OR (NOT NEW.created_draft AND (
          NEW.review->'owner'->>'draft_id' IS DISTINCT FROM NEW.draft_id::text
          OR NEW.review->'owner'->>'state' IS DISTINCT FROM
             'draft-v' || (NEW.draft_version - 1)::text))
     OR NOT EXISTS (
       SELECT 1 FROM configurations_resolvedconfiguration rc
       WHERE rc.id = NEW.resolved_configuration_id AND rc.workspace_id = NEW.workspace_id
         AND rc.resolution_sha256 = NEW.review->>'resolution_sha256')
     OR NOT EXISTS (
       SELECT 1 FROM design_draft d JOIN design_definition def ON def.id = d.definition_id
       WHERE d.id = NEW.draft_id AND def.kind = 'assembly'
         AND def.workspace_id = NEW.workspace_id
         AND def.id::text = NEW.review->'owner'->>'definition_id'
         AND d.version = NEW.draft_version AND d.content = NEW.after_content
         AND d.base_revision_id IS NOT DISTINCT FROM NEW.base_revision_id)
  THEN
    RAISE EXCEPTION 'invalid configuration adoption evidence' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER configurations_adoption_links BEFORE INSERT
ON configurations_configurationadoption
FOR EACH ROW EXECUTE FUNCTION specmate_configuration_adoption_links();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS configurations_adoption_links ON configurations_configurationadoption;
DROP FUNCTION IF EXISTS specmate_configuration_adoption_links();
DROP TRIGGER IF EXISTS configurations_adoption_immutable ON configurations_configurationadoption;
"""


class Migration(migrations.Migration):
    dependencies = [("configurations", "0003_adoption")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
