"""Store the runner-reported resolved image ID of a stage's execution (BLD-002).

The image is reported while the stage runs, so it is retained even when no receipt is
ever accepted (for example after a revoked credential). Once recorded it is immutable.
"""

from django.db import migrations, models

FORWARD = r"""
CREATE FUNCTION builds_stage_image_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.resolved_image_id <> ''
       AND NEW.resolved_image_id IS DISTINCT FROM OLD.resolved_image_id THEN
        RAISE EXCEPTION 'A recorded resolved image ID is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER stage_image_fixed BEFORE UPDATE ON builds_buildstage
FOR EACH ROW EXECUTE FUNCTION builds_stage_image_fixed();
"""

REVERSE = r"""
DROP TRIGGER IF EXISTS stage_image_fixed ON builds_buildstage;
DROP FUNCTION IF EXISTS builds_stage_image_fixed();
"""


class Migration(migrations.Migration):
    dependencies = [
        ("builds", "0007_reproducibility"),
    ]

    operations = [
        migrations.AddField(
            model_name="buildstage",
            name="resolved_image_id",
            field=models.CharField(blank=True, default="", max_length=71),
        ),
        migrations.RunSQL(FORWARD, REVERSE),
    ]
