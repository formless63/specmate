"""Containing sub-assembly revisions frozen to propagate a nested adoption choice.

Extends the adoption evidence guard: every propagated level names a frozen assembly
revision of this workspace, captured from the named draft, and matches a reviewed level
(path, exact pinned base revision and definition). Hand-maintained SQL.
"""

from django.db import migrations, models

FORWARD = r"""
CREATE OR REPLACE FUNCTION specmate_configuration_adoption_links() RETURNS trigger AS $$
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
     OR jsonb_typeof(NEW.propagated) IS DISTINCT FROM 'array'
     OR jsonb_array_length(NEW.propagated) IS DISTINCT FROM
        jsonb_array_length(COALESCE(NEW.review->'propagation', '[]'::jsonb))
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(NEW.propagated) AS level(item)
       WHERE NOT EXISTS (
         SELECT 1 FROM design_revision r
         JOIN design_definition def ON def.id = r.definition_id
         JOIN design_snapshot s ON s.id = r.snapshot_id
         JOIN design_draft d ON d.id = s.draft_id
         WHERE r.id::text = level.item->>'revision_id'
           AND def.id::text = level.item->>'definition_id'
           AND def.kind = 'assembly' AND def.workspace_id = NEW.workspace_id
           AND d.id::text = level.item->>'draft_id'
           AND d.definition_id = def.id
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(NEW.review->'propagation') AS reviewed(body)
             WHERE reviewed.body->'path' = level.item->'path'
               AND reviewed.body->'pinned'->>'revision_id' = level.item->>'base_revision_id'
               AND reviewed.body->'pinned'->>'definition_id' = def.id::text)))
  THEN
    RAISE EXCEPTION 'invalid configuration adoption evidence' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
"""

REVERSE = r"""
CREATE OR REPLACE FUNCTION specmate_configuration_adoption_links() RETURNS trigger AS $$
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
"""


class Migration(migrations.Migration):
    dependencies = [("configurations", "0004_adoption_guards")]

    operations = [
        migrations.AddField(
            model_name="configurationadoption",
            name="propagated",
            field=models.JSONField(default=list),
        ),
        migrations.RunSQL(FORWARD, REVERSE),
    ]
