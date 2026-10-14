"""Consolidated pre-1.0 database guards (immutability, sequencing and same-workspace
relationships). Hand-maintained SQL; see docs/DOMAIN.md."""

from django.db import migrations

FORWARD = r"""
CREATE TRIGGER pcb_pcbintake_immutable BEFORE UPDATE OR DELETE ON pcb_pcbintake FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE TRIGGER pcb_pcbextractionattempt_immutable BEFORE UPDATE OR DELETE ON pcb_pcbextractionattempt FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE TRIGGER pcb_pcbinterpretation_immutable BEFORE UPDATE OR DELETE ON pcb_pcbinterpretation FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE FUNCTION specmate_guard_property_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Property authority is retained';
  END IF;
  IF (NEW.id, NEW.workspace_id, NEW.property, NEW.lineage_root_id, NEW.owner_path, NEW.extractor,
      NEW.declared_by_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.workspace_id, OLD.property, OLD.lineage_root_id,
      OLD.owner_path, OLD.extractor, OLD.declared_by_id, OLD.created_at)
     OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Property authority identity is immutable and versions advance by one';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pcb_property_authority_guard BEFORE UPDATE OR DELETE ON pcb_propertyauthority
FOR EACH ROW EXECUTE FUNCTION specmate_guard_property_authority();

CREATE FUNCTION specmate_validate_property_owner_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pcb_propertyauthority a
    JOIN sources_sourcebundlerevision r ON r.id = NEW.owner_revision_id
    JOIN sources_sourcebundle b ON b.id = r.bundle_id
    JOIN sources_sourcebundlefile f ON f.revision_id = r.id AND f.path = NEW.owner_path
    WHERE a.id = NEW.authority_id AND a.version = NEW.version AND a.owner_bundle_id = b.id
      AND a.owner_path = NEW.owner_path AND b.workspace_id = a.workspace_id
  ) THEN
    RAISE EXCEPTION 'Invalid property owner change';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pcb_property_owner_change_valid BEFORE INSERT ON pcb_propertyownerchange
FOR EACH ROW EXECUTE FUNCTION specmate_validate_property_owner_change();

CREATE TRIGGER pcb_property_owner_change_immutable BEFORE UPDATE OR DELETE
ON pcb_propertyownerchange FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE FUNCTION specmate_validate_property_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('known', 'unknown') OR NOT EXISTS (
    SELECT 1 FROM pcb_propertyauthority a
    JOIN pcb_pcbinterpretation i ON i.id = NEW.interpretation_id
    JOIN pcb_pcbextractionattempt t ON t.id = i.attempt_id
    JOIN pcb_pcbintake k ON k.id = t.intake_id
    JOIN sources_sourcebundlerevision r ON r.id = k.source_revision_id
    WHERE a.id = NEW.authority_id AND a.version = NEW.version
      AND r.id = NEW.source_revision_id AND r.bundle_id = a.owner_bundle_id
      AND k.board_path = a.owner_path AND NEW.source_path = a.owner_path
      AND i.sha256 = NEW.report_sha256
  ) THEN
    RAISE EXCEPTION 'Invalid property projection provenance';
  END IF;
  IF NEW.previous_id IS DISTINCT FROM (
    SELECT p.id FROM pcb_propertyprojection p
    WHERE p.authority_id = NEW.authority_id ORDER BY p.version DESC LIMIT 1
  ) OR (NEW.previous_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pcb_propertyprojection p
    WHERE p.id = NEW.previous_id AND p.authority_id = NEW.authority_id
      AND p.version < NEW.version AND p.id <> NEW.id
  )) THEN
    RAISE EXCEPTION 'Invalid property projection history';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM sources_sourcebundlefile f
    JOIN sources_sourceblob b ON b.id = f.blob_id
    WHERE f.revision_id = NEW.source_revision_id AND f.path = NEW.source_path
      AND b.sha256 = NEW.source_sha256
  ) OR encode(sha256(NEW.value), 'hex') <> NEW.value_sha256 THEN
    RAISE EXCEPTION 'Invalid property projection byte provenance';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pcb_property_projection_valid BEFORE INSERT ON pcb_propertyprojection
FOR EACH ROW EXECUTE FUNCTION specmate_validate_property_projection();

CREATE TRIGGER pcb_property_projection_immutable BEFORE UPDATE OR DELETE
ON pcb_propertyprojection FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE TRIGGER pcb_propertyauthority_workspace_fixed BEFORE UPDATE ON pcb_propertyauthority
FOR EACH ROW EXECUTE FUNCTION specmate_preserve_workspace();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS pcb_propertyauthority_workspace_fixed ON pcb_propertyauthority;
DROP TRIGGER IF EXISTS pcb_property_projection_immutable ON pcb_propertyprojection;
DROP TRIGGER IF EXISTS pcb_property_projection_valid ON pcb_propertyprojection;
DROP FUNCTION IF EXISTS specmate_validate_property_projection();
DROP TRIGGER IF EXISTS pcb_property_owner_change_immutable ON pcb_propertyownerchange;
DROP TRIGGER IF EXISTS pcb_property_owner_change_valid ON pcb_propertyownerchange;
DROP FUNCTION IF EXISTS specmate_validate_property_owner_change();
DROP TRIGGER IF EXISTS pcb_property_authority_guard ON pcb_propertyauthority;
DROP FUNCTION IF EXISTS specmate_guard_property_authority();
DROP TRIGGER IF EXISTS pcb_pcbinterpretation_immutable ON pcb_pcbinterpretation;
DROP TRIGGER IF EXISTS pcb_pcbextractionattempt_immutable ON pcb_pcbextractionattempt;
DROP TRIGGER IF EXISTS pcb_pcbintake_immutable ON pcb_pcbintake;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("operations", "0002_guards"),
        ("pcb", "0001_initial"),
        ("sources", "0001_initial"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
