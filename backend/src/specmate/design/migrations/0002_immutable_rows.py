from django.db import migrations

FORWARD = """
CREATE TRIGGER design_snapshot_immutable BEFORE UPDATE OR DELETE ON design_snapshot FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
CREATE TRIGGER design_snapshotdependency_immutable BEFORE UPDATE OR DELETE ON design_snapshotdependency FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
CREATE TRIGGER design_revision_immutable BEFORE UPDATE OR DELETE ON design_revision FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
"""
REVERSE = """
DROP TRIGGER IF EXISTS design_snapshot_immutable ON design_snapshot;
DROP TRIGGER IF EXISTS design_snapshotdependency_immutable ON design_snapshotdependency;
DROP TRIGGER IF EXISTS design_revision_immutable ON design_revision;
"""


class Migration(migrations.Migration):
    dependencies = [("design", "0001_initial"), ("operations", "0002_immutable_rows")]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
