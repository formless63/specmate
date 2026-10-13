from django.db import migrations

# Shared trigger function: rows of immutable engineering records cannot be updated or
# deleted. TRUNCATE (used only by disposable test/reset tooling) is not affected.
SQL = """
CREATE OR REPLACE FUNCTION specmate_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'immutable record: % on %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
"""


class Migration(migrations.Migration):
    dependencies = [("operations", "0001_initial")]
    operations = [
        migrations.RunSQL(SQL, "DROP FUNCTION IF EXISTS specmate_reject_mutation();"),
    ]
