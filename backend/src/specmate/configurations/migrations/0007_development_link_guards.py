"""Database guards for development links: same-workspace targets and append-only rows.

Only the removal fields may be set, once; nothing else changes and rows are never deleted.
Hand-maintained SQL; see docs/DOMAIN.md.
"""

from django.db import migrations

FORWARD = r"""
CREATE FUNCTION specmate_development_link_guard() RETURNS trigger AS $$
DECLARE config_ws uuid; config_kind text; set_ws uuid; set_kind text; target_ws uuid; need_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'development links are append-only' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.removed_at IS NOT NULL
       OR (to_jsonb(NEW) - 'removed_at' - 'removed_by_id' - 'removal_reason')
          IS DISTINCT FROM (to_jsonb(OLD) - 'removed_at' - 'removed_by_id' - 'removal_reason')
    THEN
      RAISE EXCEPTION 'a development link only records its removal, once'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT workspace_id, kind INTO config_ws, config_kind FROM design_definition
    WHERE id = NEW.configuration_id;
  SELECT d.workspace_id, d.kind INTO set_ws, set_kind
    FROM design_revision r JOIN design_definition d ON d.id = r.definition_id
    WHERE r.id = NEW.option_set_revision_id;
  IF config_ws IS DISTINCT FROM NEW.workspace_id OR config_kind IS DISTINCT FROM 'configuration'
     OR set_ws IS DISTINCT FROM NEW.workspace_id OR set_kind IS DISTINCT FROM 'option_set' THEN
    RAISE EXCEPTION 'a development link names a configuration and option set of its workspace'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.need_id IS NOT NULL THEN
    SELECT workspace_id, kind INTO target_ws, need_kind FROM design_definition
      WHERE id = NEW.need_id;
    IF need_kind IS DISTINCT FROM 'development_need' THEN
      RAISE EXCEPTION 'a linked need is a development_need definition'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT workspace_id INTO target_ws FROM mechanical_proposals_proposaldraft
      WHERE id = NEW.mechanical_proposal_id;
  END IF;
  IF target_ws IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'a linked proposal belongs to the same workspace'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a development link is created active' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER configurations_development_link_guard BEFORE INSERT OR UPDATE OR DELETE
ON configurations_developmentlink FOR EACH ROW
EXECUTE FUNCTION specmate_development_link_guard();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS configurations_development_link_guard ON configurations_developmentlink;
DROP FUNCTION IF EXISTS specmate_development_link_guard();
"""


class Migration(migrations.Migration):
    dependencies = [("configurations", "0006_development_links")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
