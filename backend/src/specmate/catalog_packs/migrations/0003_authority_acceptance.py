"""Authority acceptance is recorded per install decision, and the database refuses an
install whose accepted set differs from the manifest's declared requests."""

from django.db import migrations, models

FORWARD = r"""
CREATE OR REPLACE FUNCTION specmate_pack_manifest() RETURNS trigger AS $$
DECLARE body jsonb;
BEGIN
  body := convert_from(NEW.canonical, 'UTF8')::jsonb;
  IF body->>'format' IS DISTINCT FROM 'specmate.catalog-pack'
     OR body->>'version' IS DISTINCT FROM NEW.version
     OR body->>'package_key' IS DISTINCT FROM (SELECT package_key FROM catalog_packs_catalogpack WHERE id = NEW.pack_id)
     OR encode(sha256(NEW.canonical), 'hex') IS DISTINCT FROM NEW.sha256
     OR jsonb_array_length(body->'requested_authority') > 20
     OR jsonb_array_length(body->'entries') NOT BETWEEN 1 AND 100
     OR body - ARRAY['format','kind','contract_version','compatible_contract_versions','package_key','label','version','publisher','rights','capabilities','requested_authority','dependencies','signature_claim','entries'] != '{}'::jsonb
  THEN RAISE EXCEPTION 'pack manifest identity or authority declaration mismatch' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION specmate_pack_authority_acceptance() RETURNS trigger AS $$
DECLARE body jsonb; requested jsonb;
BEGIN
  SELECT convert_from(canonical,'UTF8')::jsonb INTO body FROM catalog_packs_packversion WHERE id=NEW.version_id;
  SELECT COALESCE(jsonb_agg(r->>'kind' || ':' || (r->>'scope') ORDER BY r->>'kind' || ':' || (r->>'scope')), '[]'::jsonb)
    INTO requested FROM jsonb_array_elements(COALESCE(body->'requested_authority','[]'::jsonb)) r;
  IF NEW.action = 'install' THEN
    -- An install carries exactly the declared requests, accepted explicitly.
    IF NOT (NEW.accepted_authority @> requested AND requested @> NEW.accepted_authority
            AND jsonb_array_length(NEW.accepted_authority) = jsonb_array_length(requested))
    THEN RAISE EXCEPTION 'install must accept exactly the requested authority' USING ERRCODE = 'check_violation'; END IF;
  ELSIF jsonb_array_length(NEW.accepted_authority) != 0 THEN
    RAISE EXCEPTION 'only an install records accepted authority' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pack_authority_acceptance BEFORE INSERT ON catalog_packs_packdecision FOR EACH ROW EXECUTE FUNCTION specmate_pack_authority_acceptance();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS pack_authority_acceptance ON catalog_packs_packdecision;
DROP FUNCTION IF EXISTS specmate_pack_authority_acceptance();
"""


class Migration(migrations.Migration):
    dependencies = [
        ("catalog_packs", "0002_guards"),
    ]

    operations = [
        migrations.AddField(
            model_name="packdecision",
            name="accepted_authority",
            field=models.JSONField(default=list),
        ),
        migrations.RunSQL(FORWARD, REVERSE),
    ]
