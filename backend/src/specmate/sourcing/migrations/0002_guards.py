"""Pre-1.0 database guards: offers are immutable and stay inside one workspace."""

from django.db import migrations

FORWARD = r"""
CREATE FUNCTION specmate_sourcing_offer_guard() RETURNS trigger AS $$
DECLARE revision_workspace uuid; previous record;
BEGIN
  SELECT d.workspace_id INTO revision_workspace FROM design_revision r
    JOIN design_definition d ON d.id = r.definition_id WHERE r.id = NEW.revision_id;
  IF revision_workspace IS NULL OR revision_workspace != NEW.workspace_id THEN
    RAISE EXCEPTION 'offered revision must belong to the offer workspace' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.substitute_for_id IS NOT NULL THEN
    SELECT d.workspace_id INTO revision_workspace FROM design_revision r
      JOIN design_definition d ON d.id = r.definition_id WHERE r.id = NEW.substitute_for_id;
    IF revision_workspace IS NULL OR revision_workspace != NEW.workspace_id THEN
      RAISE EXCEPTION 'replaced revision must belong to the offer workspace' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.supersedes_id IS NOT NULL THEN
    SELECT * INTO previous FROM sourcing_supplieroffer WHERE id = NEW.supersedes_id;
    IF previous.id IS NULL OR previous.workspace_id != NEW.workspace_id
      OR previous.revision_id != NEW.revision_id
      OR previous.substitute_for_id IS DISTINCT FROM NEW.substitute_for_id THEN
      RAISE EXCEPTION 'superseded offer must cover the same workspace, revision and need' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sourcing_offer_guard BEFORE INSERT ON sourcing_supplieroffer
FOR EACH ROW EXECUTE FUNCTION specmate_sourcing_offer_guard();

CREATE TRIGGER sourcing_offer_immutable BEFORE UPDATE OR DELETE ON sourcing_supplieroffer
FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS sourcing_offer_immutable ON sourcing_supplieroffer;
DROP TRIGGER IF EXISTS sourcing_offer_guard ON sourcing_supplieroffer;
DROP FUNCTION IF EXISTS specmate_sourcing_offer_guard();
"""


class Migration(migrations.Migration):
    dependencies = [
        ("design", "0001_initial"),
        ("operations", "0002_guards"),
        ("sourcing", "0001_initial"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
