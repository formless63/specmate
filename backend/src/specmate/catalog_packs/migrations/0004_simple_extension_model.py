"""Simple extension model: no signature claims and no authority-acceptance ceremony.

Declared needs stay in the manifest as plain information; admins enable and disable packs
themselves (permission-checked in the operations)."""

from django.db import migrations

FORWARD = r"""
DROP TRIGGER IF EXISTS pack_authority_acceptance ON catalog_packs_packdecision;
DROP FUNCTION IF EXISTS specmate_pack_authority_acceptance();

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
     OR body - ARRAY['format','kind','contract_version','compatible_contract_versions','package_key','label','version','publisher','rights','capabilities','requested_authority','dependencies','entries'] != '{}'::jsonb
  THEN RAISE EXCEPTION 'pack manifest identity mismatch' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("catalog_packs", "0003_authority_acceptance"),
    ]

    operations = [
        migrations.RunSQL(FORWARD, migrations.RunSQL.noop),
        migrations.RemoveField(model_name="packdecision", name="accepted_authority"),
    ]
