from django.db import migrations

FORWARD = """
CREATE TRIGGER sources_sourcebundlerevision_immutable BEFORE UPDATE OR DELETE ON sources_sourcebundlerevision FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
CREATE TRIGGER sources_sourcebundlefile_immutable BEFORE UPDATE OR DELETE ON sources_sourcebundlefile FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
"""
REVERSE = """
DROP TRIGGER IF EXISTS sources_sourcebundlerevision_immutable ON sources_sourcebundlerevision;
DROP TRIGGER IF EXISTS sources_sourcebundlefile_immutable ON sources_sourcebundlefile;
"""


class Migration(migrations.Migration):
    dependencies = [("sources", "0001_initial"), ("operations", "0002_immutable_rows")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
