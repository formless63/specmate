"""Share records are append-only. Hand-maintained SQL."""

from django.db import migrations

FORWARD = """
CREATE TRIGGER sharing_record_immutable BEFORE UPDATE OR DELETE
ON sharing_sharerecord FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
"""
REVERSE = "DROP TRIGGER IF EXISTS sharing_record_immutable ON sharing_sharerecord;"


class Migration(migrations.Migration):
    dependencies = [
        ("operations", "0002_guards"),
        ("sharing", "0001_initial"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
