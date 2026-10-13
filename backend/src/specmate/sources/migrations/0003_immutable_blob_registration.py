from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [("sources", "0002_immutable_rows")]

    operations = [
        migrations.RunSQL(
            "CREATE TRIGGER sources_sourceblob_immutable BEFORE UPDATE OR DELETE "
            "ON sources_sourceblob FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();",
            "DROP TRIGGER IF EXISTS sources_sourceblob_immutable ON sources_sourceblob;",
        )
    ]
