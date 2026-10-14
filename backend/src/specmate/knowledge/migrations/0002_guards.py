"""Consolidated pre-1.0 database guards (immutability, sequencing and same-workspace
relationships). Hand-maintained SQL; see docs/DOMAIN.md."""

from django.db import migrations

FORWARD = r"""
CREATE TRIGGER knowledge_item_no_delete BEFORE DELETE ON knowledge_knowledgeitem
FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE FUNCTION specmate_knowledge_item_guard() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'version') IS DISTINCT FROM (to_jsonb(OLD) - 'version')
     OR NEW.version != OLD.version + 1 OR NOT EXISTS (
       SELECT 1 FROM knowledge_knowledgeentry WHERE item_id = OLD.id AND number = NEW.version
     ) THEN
    RAISE EXCEPTION 'knowledge identity is immutable; version follows an appended entry'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER knowledge_item_guard BEFORE UPDATE ON knowledge_knowledgeitem
FOR EACH ROW EXECUTE FUNCTION specmate_knowledge_item_guard();

CREATE TRIGGER knowledge_entry_immutable BEFORE UPDATE OR DELETE ON knowledge_knowledgeentry
FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE FUNCTION specmate_knowledge_entry_guard() RETURNS trigger AS $$
DECLARE item_version integer; item_kind text; expected integer;
BEGIN
  SELECT version, kind INTO item_version, item_kind FROM knowledge_knowledgeitem
    WHERE id = NEW.item_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM knowledge_knowledgeentry WHERE item_id = NEW.item_id) THEN
    expected := item_version + 1;
  ELSE
    expected := 1;
  END IF;
  IF NEW.number != expected THEN
    RAISE EXCEPTION 'knowledge entries append in sequence' USING ERRCODE = 'check_violation';
  END IF;
  IF (item_kind = 'decision') != (NEW.decision_status IS NOT NULL) THEN
    RAISE EXCEPTION 'only decisions carry a decision status' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER knowledge_entry_guard BEFORE INSERT ON knowledge_knowledgeentry
FOR EACH ROW EXECUTE FUNCTION specmate_knowledge_entry_guard();

CREATE TRIGGER knowledge_attachment_immutable BEFORE UPDATE OR DELETE
ON knowledge_knowledgeattachment FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE FUNCTION specmate_knowledge_attachment_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM knowledge_knowledgeentry e
      JOIN knowledge_knowledgeitem i ON i.id = e.item_id
      JOIN sources_sourcebundlefile f ON f.id = NEW.source_file_id
      JOIN sources_sourcebundlerevision r ON r.id = f.revision_id
      JOIN sources_sourcebundle b ON b.id = r.bundle_id
      JOIN sources_sourceblob s ON s.id = f.blob_id
    WHERE e.id = NEW.entry_id AND b.workspace_id = i.workspace_id AND s.workspace_id = i.workspace_id
  ) THEN
    RAISE EXCEPTION 'attachments reference bytes owned by the item workspace'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER knowledge_attachment_guard BEFORE INSERT ON knowledge_knowledgeattachment
FOR EACH ROW EXECUTE FUNCTION specmate_knowledge_attachment_guard();

CREATE TRIGGER knowledge_link_no_delete BEFORE DELETE ON knowledge_knowledgelink
FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE FUNCTION specmate_knowledge_link_guard() RETURNS trigger AS $$
DECLARE item_workspace uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL
       OR (to_jsonb(NEW) - 'removed_at' - 'removed_by_id' - 'removal_request_id' - 'removal_reason')
          IS DISTINCT FROM
          (to_jsonb(OLD) - 'removed_at' - 'removed_by_id' - 'removal_request_id' - 'removal_reason')
    THEN
      RAISE EXCEPTION 'a link is removed once and otherwise immutable'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.removed_at IS NOT NULL OR jsonb_typeof(NEW.path) != 'array' THEN
    RAISE EXCEPTION 'invalid knowledge link state' USING ERRCODE = 'check_violation';
  END IF;
  SELECT workspace_id INTO item_workspace FROM knowledge_knowledgeitem WHERE id = NEW.item_id;
  IF (NEW.target_project_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM access_project WHERE id = NEW.target_project_id
        AND workspace_id = item_workspace
    )) OR (NEW.definition_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM design_definition WHERE id = NEW.definition_id
        AND workspace_id = item_workspace
    )) OR (NEW.revision_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM design_revision r JOIN design_definition d ON d.id = r.definition_id
      WHERE r.id = NEW.revision_id AND d.workspace_id = item_workspace
    )) OR (NEW.snapshot_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM design_snapshot s JOIN design_definition d ON d.id = s.definition_id
      WHERE s.id = NEW.snapshot_id AND d.workspace_id = item_workspace
    )) OR (NEW.physical_unit_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM physical_units_physicalunit
      WHERE id = NEW.physical_unit_id AND workspace_id = item_workspace
    )) THEN
    RAISE EXCEPTION 'knowledge link target scope mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER knowledge_link_guard BEFORE INSERT OR UPDATE ON knowledge_knowledgelink
FOR EACH ROW EXECUTE FUNCTION specmate_knowledge_link_guard();

CREATE TRIGGER knowledge_knowledgeitem_workspace_fixed BEFORE UPDATE ON knowledge_knowledgeitem
FOR EACH ROW EXECUTE FUNCTION specmate_preserve_workspace();

CREATE TRIGGER knowledge_knowledgeitem_project_context BEFORE INSERT OR UPDATE ON knowledge_knowledgeitem
FOR EACH ROW EXECUTE FUNCTION specmate_project_context();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS knowledge_knowledgeitem_project_context ON knowledge_knowledgeitem;
DROP TRIGGER IF EXISTS knowledge_knowledgeitem_workspace_fixed ON knowledge_knowledgeitem;
DROP TRIGGER IF EXISTS knowledge_link_guard ON knowledge_knowledgelink;
DROP FUNCTION IF EXISTS specmate_knowledge_link_guard();
DROP TRIGGER IF EXISTS knowledge_link_no_delete ON knowledge_knowledgelink;
DROP TRIGGER IF EXISTS knowledge_attachment_guard ON knowledge_knowledgeattachment;
DROP FUNCTION IF EXISTS specmate_knowledge_attachment_guard();
DROP TRIGGER IF EXISTS knowledge_attachment_immutable ON knowledge_knowledgeattachment;
DROP TRIGGER IF EXISTS knowledge_entry_guard ON knowledge_knowledgeentry;
DROP FUNCTION IF EXISTS specmate_knowledge_entry_guard();
DROP TRIGGER IF EXISTS knowledge_entry_immutable ON knowledge_knowledgeentry;
DROP TRIGGER IF EXISTS knowledge_item_guard ON knowledge_knowledgeitem;
DROP FUNCTION IF EXISTS specmate_knowledge_item_guard();
DROP TRIGGER IF EXISTS knowledge_item_no_delete ON knowledge_knowledgeitem;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("access", "0002_projectreference"),
        ("design", "0001_initial"),
        ("knowledge", "0001_initial"),
        ("operations", "0002_guards"),
        ("physical_units", "0001_initial"),
        ("sources", "0001_initial"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
