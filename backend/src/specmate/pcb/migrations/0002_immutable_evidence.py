from django.db import migrations

TABLES = ("pcb_pcbintake", "pcb_pcbextractionattempt", "pcb_pcbinterpretation")


class Migration(migrations.Migration):
    dependencies = [("pcb", "0001_initial"), ("operations", "0002_immutable_rows")]
    operations = [
        migrations.RunSQL(
            "\n".join(
                f"CREATE TRIGGER {t}_immutable BEFORE UPDATE OR DELETE ON {t} "
                "FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();"
                for t in TABLES
            ),
            "\n".join(f"DROP TRIGGER IF EXISTS {t}_immutable ON {t};" for t in TABLES),
        )
    ]
