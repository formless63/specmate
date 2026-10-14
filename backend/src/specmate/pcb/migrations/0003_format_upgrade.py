import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models

# Hand-maintained guards: upgrade evidence is immutable and its derivative names the
# exact upgraded original as ancestry, in the same workspace, with matching build pins.
FORWARD = r"""
CREATE FUNCTION specmate_validate_pcb_upgrade_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pcb_pcbintake k
    JOIN builds_buildattempt b ON b.id = NEW.build_id
    WHERE k.id = NEW.intake_id AND b.source_revision_id = k.source_revision_id
  ) THEN
    RAISE EXCEPTION 'Upgrade build must pin the intake source revision';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pcb_upgrade_attempt_valid BEFORE INSERT ON pcb_pcbupgradeattempt
FOR EACH ROW EXECUTE FUNCTION specmate_validate_pcb_upgrade_attempt();

CREATE TRIGGER pcb_pcbupgradeattempt_immutable BEFORE UPDATE OR DELETE ON pcb_pcbupgradeattempt
FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();

CREATE FUNCTION specmate_validate_pcb_format_upgrade() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pcb_pcbupgradeattempt a
    JOIN pcb_pcbintake original ON original.id = a.intake_id
    JOIN sources_sourcebundlerevision r ON r.id = NEW.revision_id
    JOIN sources_sourcebundle d ON d.id = r.bundle_id
    JOIN sources_sourcebundlerevision o ON o.id = original.source_revision_id
    JOIN sources_sourcebundle ob ON ob.id = o.bundle_id
    JOIN pcb_pcbintake derived ON derived.id = NEW.intake_id
    JOIN builds_stageoutput out ON out.id = NEW.report_output_id
    JOIN builds_buildstage st ON st.id = out.stage_id
    WHERE a.id = NEW.attempt_id AND d.role = 'derivative'
      AND d.derived_from_id = original.source_revision_id AND d.workspace_id = ob.workspace_id
      AND derived.source_revision_id = NEW.revision_id
      AND derived.board_path = original.board_path
      AND st.build_id = a.build_id AND st.state = 'succeeded'
  ) THEN
    RAISE EXCEPTION 'Invalid PCB format upgrade provenance';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pcb_format_upgrade_valid BEFORE INSERT ON pcb_pcbformatupgrade
FOR EACH ROW EXECUTE FUNCTION specmate_validate_pcb_format_upgrade();

CREATE TRIGGER pcb_pcbformatupgrade_immutable BEFORE UPDATE OR DELETE ON pcb_pcbformatupgrade
FOR EACH ROW EXECUTE FUNCTION specmate_reject_mutation();
"""

REVERSE = r"""
DROP TRIGGER pcb_pcbformatupgrade_immutable ON pcb_pcbformatupgrade;
DROP TRIGGER pcb_format_upgrade_valid ON pcb_pcbformatupgrade;
DROP FUNCTION specmate_validate_pcb_format_upgrade();
DROP TRIGGER pcb_pcbupgradeattempt_immutable ON pcb_pcbupgradeattempt;
DROP TRIGGER pcb_upgrade_attempt_valid ON pcb_pcbupgradeattempt;
DROP FUNCTION specmate_validate_pcb_upgrade_attempt();
"""


class Migration(migrations.Migration):
    dependencies = [
        ("builds", "0004_outbox_withheld"),
        ("pcb", "0002_guards"),
        ("sources", "0002_guards"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="PcbUpgradeAttempt",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "build",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.PROTECT, to="builds.buildattempt"
                    ),
                ),
                (
                    "intake",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="upgrades",
                        to="pcb.pcbintake",
                    ),
                ),
            ],
        ),
        migrations.CreateModel(
            name="PcbFormatUpgrade",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("canonical", models.BinaryField()),
                ("sha256", models.CharField(max_length=64)),
                ("from_kicad_major", models.PositiveSmallIntegerField()),
                ("from_format_version", models.PositiveIntegerField()),
                ("to_format_version", models.PositiveIntegerField()),
                ("tool_version", models.CharField(max_length=40)),
                ("image", models.CharField(max_length=300)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "accepted_by",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT, to=settings.AUTH_USER_MODEL
                    ),
                ),
                (
                    "intake",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="+",
                        to="pcb.pcbintake",
                    ),
                ),
                (
                    "report_output",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.PROTECT, to="builds.stageoutput"
                    ),
                ),
                (
                    "revision",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="pcb_format_upgrade",
                        to="sources.sourcebundlerevision",
                    ),
                ),
                (
                    "attempt",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.PROTECT, to="pcb.pcbupgradeattempt"
                    ),
                ),
            ],
        ),
        migrations.RunSQL(FORWARD, REVERSE),
    ]
