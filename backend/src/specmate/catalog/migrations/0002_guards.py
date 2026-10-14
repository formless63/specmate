"""Consolidated pre-1.0 database guards (immutability, sequencing and same-workspace
relationships). Hand-maintained SQL; see docs/DOMAIN.md."""

from django.db import migrations

FORWARD = r"""
CREATE TRIGGER catalog_variant_immutable BEFORE UPDATE OR DELETE ON catalog_manufacturervariant FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE TRIGGER catalog_representation_immutable BEFORE UPDATE OR DELETE ON catalog_representation FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE TRIGGER catalog_lot_immutable BEFORE UPDATE OR DELETE ON catalog_physicallot FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE FUNCTION specmate_catalog_lot_revision() RETURNS trigger AS $$
BEGIN
  IF NEW.variant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM catalog_manufacturervariant WHERE id = NEW.variant_id AND revision_id = NEW.revision_id
  ) THEN
    RAISE EXCEPTION 'lot and variant revision mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER catalog_lot_revision BEFORE INSERT ON catalog_physicallot FOR EACH ROW EXECUTE FUNCTION specmate_catalog_lot_revision();

CREATE FUNCTION specmate_catalog_representation_scope() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM design_revision r JOIN design_definition d ON d.id = r.definition_id,
      sources_sourcebundlefile f JOIN sources_sourcebundlerevision s ON s.id = f.revision_id
      JOIN sources_sourcebundle b ON b.id = s.bundle_id
    WHERE r.id = NEW.revision_id AND f.id = NEW.source_file_id AND d.workspace_id = b.workspace_id
  ) THEN
    RAISE EXCEPTION 'representation source scope mismatch' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER catalog_representation_scope BEFORE INSERT ON catalog_representation FOR EACH ROW EXECUTE FUNCTION specmate_catalog_representation_scope();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS catalog_representation_scope ON catalog_representation;
DROP FUNCTION IF EXISTS specmate_catalog_representation_scope();
DROP TRIGGER IF EXISTS catalog_lot_revision ON catalog_physicallot;
DROP FUNCTION IF EXISTS specmate_catalog_lot_revision();
DROP TRIGGER IF EXISTS catalog_lot_immutable ON catalog_physicallot;
DROP TRIGGER IF EXISTS catalog_representation_immutable ON catalog_representation;
DROP TRIGGER IF EXISTS catalog_variant_immutable ON catalog_manufacturervariant;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("catalog", "0001_initial"),
        ("design", "0001_initial"),
        ("operations", "0002_guards"),
        ("sources", "0001_initial"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
