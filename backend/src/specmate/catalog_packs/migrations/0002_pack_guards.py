from django.db import migrations

FORWARD = """
CREATE TRIGGER pack_identity_immutable BEFORE UPDATE OR DELETE ON catalog_packs_catalogpack FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
CREATE TRIGGER pack_version_immutable BEFORE UPDATE OR DELETE ON catalog_packs_packversion FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
CREATE TRIGGER pack_entry_immutable BEFORE UPDATE OR DELETE ON catalog_packs_versionentry FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
CREATE TRIGGER pack_dependency_immutable BEFORE UPDATE OR DELETE ON catalog_packs_versiondependency FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
CREATE TRIGGER pack_decision_immutable BEFORE UPDATE OR DELETE ON catalog_packs_packdecision FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
CREATE TRIGGER pack_adoption_immutable BEFORE UPDATE OR DELETE ON catalog_packs_adoptionentry FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
CREATE FUNCTION specmate_pack_manifest() RETURNS trigger AS $$
DECLARE body jsonb;
BEGIN
  body := convert_from(NEW.canonical, 'UTF8')::jsonb;
  IF body->>'format' IS DISTINCT FROM 'specmate.catalog-pack'
     OR body->>'version' IS DISTINCT FROM NEW.version
     OR body->>'package_key' IS DISTINCT FROM (SELECT package_key FROM catalog_packs_catalogpack WHERE id = NEW.pack_id)
     OR encode(sha256(NEW.canonical), 'hex') IS DISTINCT FROM NEW.sha256
     OR jsonb_array_length(body->'requested_authority') != 0
     OR jsonb_array_length(body->'entries') NOT BETWEEN 1 AND 100
     OR body - ARRAY['format','contract_version','package_key','label','version','publisher','rights','capabilities','requested_authority','dependencies','signature_claim','entries'] != '{}'::jsonb
  THEN RAISE EXCEPTION 'pack manifest identity or inert authority mismatch' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER pack_manifest BEFORE INSERT ON catalog_packs_packversion FOR EACH ROW EXECUTE FUNCTION specmate_pack_manifest();
CREATE FUNCTION specmate_pack_entry_pin() RETURNS trigger AS $$
DECLARE item jsonb;
BEGIN
  SELECT value INTO item FROM jsonb_array_elements((SELECT convert_from(canonical,'UTF8')::jsonb->'entries' FROM catalog_packs_packversion WHERE id=NEW.version_id)) WHERE value->>'key'=NEW.key;
  IF item IS NULL OR (item->>'revision_id')::uuid IS DISTINCT FROM NEW.revision_id
     OR (NEW.revision_id IS NOT NULL AND item->>'revision_sha256' IS DISTINCT FROM (SELECT s.sha256 FROM design_revision r JOIN design_snapshot s ON s.id=r.snapshot_id WHERE r.id=NEW.revision_id))
     OR (item->'source' != 'null'::jsonb AND NEW.source_file_id IS NULL)
     OR (item->'source' = 'null'::jsonb AND NEW.source_file_id IS NOT NULL)
  THEN RAISE EXCEPTION 'pack entry revision pin mismatch' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.source_file_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sources_sourcebundlefile f JOIN sources_sourceblob b ON b.id=f.blob_id
    WHERE f.id=NEW.source_file_id AND f.revision_id=(item->'source'->>'source_bundle_revision_id')::uuid
      AND f.path=item->'source'->>'source_path' AND b.sha256=item->'source'->>'sha256' AND f.rights=item->'source'->>'rights'
  ) THEN RAISE EXCEPTION 'pack entry file pin mismatch' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER pack_entry_pin BEFORE INSERT ON catalog_packs_versionentry FOR EACH ROW EXECUTE FUNCTION specmate_pack_entry_pin();
CREATE FUNCTION specmate_pack_dependency_pin() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM catalog_packs_packversion v, jsonb_array_elements_text(convert_from(v.canonical,'UTF8')::jsonb->'dependencies') d WHERE v.id=NEW.version_id AND d::uuid=NEW.dependency_id)
  THEN RAISE EXCEPTION 'pack dependency pin mismatch' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER pack_dependency_pin BEFORE INSERT ON catalog_packs_versiondependency FOR EACH ROW EXECUTE FUNCTION specmate_pack_dependency_pin();
CREATE FUNCTION specmate_pack_decision() RETURNS trigger AS $$
DECLARE prior_sequence integer; installed_version uuid; installed_action text; body jsonb;
BEGIN
  PERFORM id FROM catalog_packs_catalogpack WHERE id=NEW.pack_id FOR UPDATE;
  SELECT COALESCE(MAX(sequence),0) INTO prior_sequence FROM catalog_packs_packdecision WHERE pack_id=NEW.pack_id;
  IF NEW.sequence != prior_sequence + 1 OR NOT EXISTS (SELECT 1 FROM catalog_packs_packversion WHERE id=NEW.version_id AND pack_id=NEW.pack_id)
  THEN RAISE EXCEPTION 'pack decision sequence or ownership mismatch' USING ERRCODE = 'check_violation'; END IF;
  SELECT convert_from(canonical,'UTF8')::jsonb INTO body FROM catalog_packs_packversion WHERE id=NEW.version_id;
  IF jsonb_array_length(body->'entries') != (SELECT COUNT(*) FROM catalog_packs_versionentry WHERE version_id=NEW.version_id)
     OR jsonb_array_length(body->'dependencies') != (SELECT COUNT(*) FROM catalog_packs_versiondependency WHERE version_id=NEW.version_id)
     OR body->>'contract_version' != '1'
  THEN RAISE EXCEPTION 'pack version closure incomplete or unsupported' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.action IN ('adopt','disable') THEN
    SELECT version_id, action INTO installed_version, installed_action FROM catalog_packs_packdecision WHERE pack_id=NEW.pack_id AND action IN ('install','disable') ORDER BY sequence DESC LIMIT 1;
    IF installed_version IS DISTINCT FROM NEW.version_id OR installed_action IS DISTINCT FROM 'install'
    THEN RAISE EXCEPTION 'pack must be installed and enabled' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER pack_decision BEFORE INSERT ON catalog_packs_packdecision FOR EACH ROW EXECUTE FUNCTION specmate_pack_decision();
CREATE FUNCTION specmate_pack_adoption() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM catalog_packs_packdecision d JOIN catalog_packs_versionentry e ON e.version_id=d.version_id WHERE d.id=NEW.decision_id AND d.action='adopt' AND e.id=NEW.entry_id)
  THEN RAISE EXCEPTION 'pack adoption version mismatch' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.definition_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM catalog_packs_packdecision d JOIN catalog_packs_catalogpack p ON p.id=d.pack_id,
      design_draft draft JOIN design_definition def ON def.id=draft.definition_id,
      catalog_packs_versionentry e JOIN design_revision r ON r.id=e.revision_id
      JOIN design_snapshot s ON s.id=r.snapshot_id JOIN design_definition source_def ON source_def.id=r.definition_id
    WHERE d.id=NEW.decision_id AND e.id=NEW.entry_id AND draft.id=NEW.draft_id
      AND def.id=NEW.definition_id AND def.project_id=p.project_id
      AND def.id != source_def.id AND def.kind=source_def.kind
      AND draft.content=convert_from(NEW.initial_content,'UTF8')::jsonb
      AND draft.content=(convert_from(s.canonical,'UTF8')::jsonb->'content')
  ) THEN RAISE EXCEPTION 'pack adoption owning draft or exact initial content mismatch' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER pack_adoption BEFORE INSERT ON catalog_packs_adoptionentry FOR EACH ROW EXECUTE FUNCTION specmate_pack_adoption();
"""

REVERSE = """
DROP TRIGGER pack_adoption ON catalog_packs_adoptionentry;
DROP FUNCTION specmate_pack_adoption();
DROP TRIGGER pack_decision ON catalog_packs_packdecision;
DROP FUNCTION specmate_pack_decision();
DROP TRIGGER pack_dependency_pin ON catalog_packs_versiondependency;
DROP FUNCTION specmate_pack_dependency_pin();
DROP TRIGGER pack_entry_pin ON catalog_packs_versionentry;
DROP FUNCTION specmate_pack_entry_pin();
DROP TRIGGER pack_manifest ON catalog_packs_packversion;
DROP FUNCTION specmate_pack_manifest();
DROP TRIGGER pack_adoption_immutable ON catalog_packs_adoptionentry;
DROP TRIGGER pack_decision_immutable ON catalog_packs_packdecision;
DROP TRIGGER pack_dependency_immutable ON catalog_packs_versiondependency;
DROP TRIGGER pack_entry_immutable ON catalog_packs_versionentry;
DROP TRIGGER pack_version_immutable ON catalog_packs_packversion;
DROP TRIGGER pack_identity_immutable ON catalog_packs_catalogpack;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("catalog_packs", "0001_initial"),
        ("sources", "0003_immutable_blob_registration"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
