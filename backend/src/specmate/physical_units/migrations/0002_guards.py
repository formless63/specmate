"""Consolidated pre-1.0 database guards (immutability, sequencing and same-workspace
relationships). Hand-maintained SQL; see docs/DOMAIN.md."""

from django.db import migrations

FORWARD = r"""
CREATE FUNCTION specmate_physical_unit_guard() RETURNS trigger AS $$
DECLARE revision_workspace uuid; lot_revision uuid; lot_variant uuid; variant_revision uuid;
BEGIN
  SELECT d.workspace_id INTO revision_workspace FROM design_revision r
    JOIN design_definition d ON d.id = r.definition_id WHERE r.id = NEW.revision_id;
  IF revision_workspace IS NULL OR revision_workspace != NEW.workspace_id THEN
    RAISE EXCEPTION 'physical unit workspace and revision mismatch' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.lot_id IS NOT NULL THEN
    SELECT revision_id, variant_id INTO lot_revision, lot_variant
      FROM catalog_physicallot WHERE id = NEW.lot_id;
    IF lot_revision IS DISTINCT FROM NEW.revision_id THEN
      RAISE EXCEPTION 'physical unit and lot revision mismatch' USING ERRCODE = 'check_violation';
    END IF;
    IF lot_variant IS NOT NULL AND NEW.variant_id IS DISTINCT FROM lot_variant THEN
      RAISE EXCEPTION 'physical unit must retain known lot variant' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.variant_id IS NOT NULL THEN
    SELECT revision_id INTO variant_revision FROM catalog_manufacturervariant
      WHERE id = NEW.variant_id;
    IF variant_revision IS DISTINCT FROM NEW.revision_id OR
      (lot_variant IS NOT NULL AND lot_variant != NEW.variant_id) THEN
      RAISE EXCEPTION 'physical unit and variant mismatch' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER physical_unit_guard BEFORE INSERT ON physical_units_physicalunit
FOR EACH ROW EXECUTE FUNCTION specmate_physical_unit_guard();

CREATE TRIGGER physical_unit_immutable BEFORE UPDATE OR DELETE ON physical_units_physicalunit
FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE FUNCTION specmate_physical_work_unit_guard() RETURNS trigger AS $$
DECLARE work_revision uuid; work_workspace uuid; unit_revision uuid; unit_workspace uuid;
BEGIN
  SELECT b.revision_id, d.workspace_id INTO work_revision, work_workspace
    FROM inventory_workbatch b JOIN design_revision r ON r.id = b.revision_id
    JOIN design_definition d ON d.id = r.definition_id
    WHERE b.id = NEW.work_batch_id FOR UPDATE OF b;
  SELECT revision_id, workspace_id INTO unit_revision, unit_workspace
    FROM physical_units_physicalunit WHERE id = NEW.unit_id;
  IF work_revision IS DISTINCT FROM unit_revision OR work_workspace IS DISTINCT FROM unit_workspace THEN
    RAISE EXCEPTION 'physical unit and work target mismatch' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE inventory_workbatch SET state = gen_random_uuid() WHERE id = NEW.work_batch_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER physical_work_unit_guard BEFORE INSERT ON physical_units_workunitlink
FOR EACH ROW EXECUTE FUNCTION specmate_physical_work_unit_guard();

CREATE TRIGGER physical_work_unit_immutable BEFORE UPDATE OR DELETE ON physical_units_workunitlink
FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE TRIGGER physical_units_physicalunit_workspace_fixed BEFORE UPDATE ON physical_units_physicalunit
FOR EACH ROW EXECUTE FUNCTION specmate_preserve_workspace();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS physical_units_physicalunit_workspace_fixed ON physical_units_physicalunit;
DROP TRIGGER IF EXISTS physical_work_unit_immutable ON physical_units_workunitlink;
DROP TRIGGER IF EXISTS physical_work_unit_guard ON physical_units_workunitlink;
DROP FUNCTION IF EXISTS specmate_physical_work_unit_guard();
DROP TRIGGER IF EXISTS physical_unit_immutable ON physical_units_physicalunit;
DROP TRIGGER IF EXISTS physical_unit_guard ON physical_units_physicalunit;
DROP FUNCTION IF EXISTS specmate_physical_unit_guard();
"""


class Migration(migrations.Migration):
    dependencies = [
        ("catalog", "0001_initial"),
        ("design", "0001_initial"),
        ("inventory", "0002_stockentry_physical_unit"),
        ("operations", "0002_guards"),
        ("physical_units", "0001_initial"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
