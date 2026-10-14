"""Consolidated pre-1.0 database guards (immutability, sequencing and same-workspace
relationships). Hand-maintained SQL; see docs/DOMAIN.md."""

from django.db import migrations

FORWARD = r"""
CREATE TRIGGER pcb_disagreement_sourcenetattempt_immutable BEFORE UPDATE OR DELETE ON pcb_disagreement_sourcenetattempt FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE TRIGGER pcb_disagreement_sourcenetinterpretation_immutable BEFORE UPDATE OR DELETE ON pcb_disagreement_sourcenetinterpretation FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS pcb_disagreement_sourcenetinterpretation_immutable ON pcb_disagreement_sourcenetinterpretation;
DROP TRIGGER IF EXISTS pcb_disagreement_sourcenetattempt_immutable ON pcb_disagreement_sourcenetattempt;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("operations", "0002_guards"),
        ("pcb_disagreement", "0001_initial"),
    ]
    operations = [migrations.RunSQL(FORWARD, REVERSE)]
