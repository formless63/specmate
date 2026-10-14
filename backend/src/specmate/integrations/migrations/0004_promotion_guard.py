"""A promotion link is immutable evidence."""

from django.db import migrations

FORWARD = """
CREATE TRIGGER integrations_promotion_immutable
BEFORE UPDATE OR DELETE ON integrations_observationpromotion
FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
"""
REVERSE = (
    "DROP TRIGGER IF EXISTS integrations_promotion_immutable ON integrations_observationpromotion;"
)


class Migration(migrations.Migration):
    dependencies = [("integrations", "0003_promotion"), ("operations", "0002_guards")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
