"""Projects may reference a release; the reference guard keeps it in the project workspace."""

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models

GUARD = r"""
CREATE OR REPLACE FUNCTION specmate_project_reference_guard() RETURNS trigger AS $$
DECLARE project_workspace uuid; target_workspace uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Reference history is retired, not erased; only deleting its project removes it.
    IF current_setting('specmate.deleting_project', true) IS DISTINCT FROM OLD.project_id::text THEN
      RAISE EXCEPTION 'project references are retired, not deleted'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL
       OR (to_jsonb(NEW) - 'removed_at' - 'removed_by_id' - 'removal_request_id' - 'removal_reason')
          IS DISTINCT FROM
          (to_jsonb(OLD) - 'removed_at' - 'removed_by_id' - 'removal_request_id' - 'removal_reason')
    THEN
      RAISE EXCEPTION 'a project reference is removed once and otherwise immutable'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'invalid project reference state' USING ERRCODE = 'check_violation';
  END IF;
  SELECT workspace_id INTO project_workspace FROM access_project WHERE id = NEW.project_id;
  target_workspace := CASE NEW.kind
    WHEN 'definition' THEN
      (SELECT workspace_id FROM design_definition WHERE id = NEW.definition_id)
    WHEN 'revision' THEN
      (SELECT d.workspace_id FROM design_revision r
         JOIN design_definition d ON d.id = r.definition_id WHERE r.id = NEW.revision_id)
    WHEN 'source_bundle' THEN
      (SELECT workspace_id FROM sources_sourcebundle WHERE id = NEW.source_bundle_id)
    WHEN 'physical_unit' THEN
      (SELECT workspace_id FROM physical_units_physicalunit WHERE id = NEW.physical_unit_id)
    WHEN 'work_batch' THEN
      (SELECT d.workspace_id FROM inventory_workbatch b
         JOIN design_revision r ON r.id = b.revision_id
         JOIN design_definition d ON d.id = r.definition_id WHERE b.id = NEW.work_batch_id)
    WHEN 'release' THEN
      (SELECT workspace_id FROM releases_release WHERE id = NEW.release_id)
  END;
  IF target_workspace IS NULL OR target_workspace IS DISTINCT FROM project_workspace THEN
    RAISE EXCEPTION 'project reference target must belong to the project workspace'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
"""

PREVIOUS = r"""
CREATE OR REPLACE FUNCTION specmate_project_reference_guard() RETURNS trigger AS $$
DECLARE project_workspace uuid; target_workspace uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Reference history is retired, not erased; only deleting its project removes it.
    IF current_setting('specmate.deleting_project', true) IS DISTINCT FROM OLD.project_id::text THEN
      RAISE EXCEPTION 'project references are retired, not deleted'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL
       OR (to_jsonb(NEW) - 'removed_at' - 'removed_by_id' - 'removal_request_id' - 'removal_reason')
          IS DISTINCT FROM
          (to_jsonb(OLD) - 'removed_at' - 'removed_by_id' - 'removal_request_id' - 'removal_reason')
    THEN
      RAISE EXCEPTION 'a project reference is removed once and otherwise immutable'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'invalid project reference state' USING ERRCODE = 'check_violation';
  END IF;
  SELECT workspace_id INTO project_workspace FROM access_project WHERE id = NEW.project_id;
  target_workspace := CASE NEW.kind
    WHEN 'definition' THEN
      (SELECT workspace_id FROM design_definition WHERE id = NEW.definition_id)
    WHEN 'revision' THEN
      (SELECT d.workspace_id FROM design_revision r
         JOIN design_definition d ON d.id = r.definition_id WHERE r.id = NEW.revision_id)
    WHEN 'source_bundle' THEN
      (SELECT workspace_id FROM sources_sourcebundle WHERE id = NEW.source_bundle_id)
    WHEN 'physical_unit' THEN
      (SELECT workspace_id FROM physical_units_physicalunit WHERE id = NEW.physical_unit_id)
    WHEN 'work_batch' THEN
      (SELECT d.workspace_id FROM inventory_workbatch b
         JOIN design_revision r ON r.id = b.revision_id
         JOIN design_definition d ON d.id = r.definition_id WHERE b.id = NEW.work_batch_id)
  END;
  IF target_workspace IS NULL OR target_workspace IS DISTINCT FROM project_workspace THEN
    RAISE EXCEPTION 'project reference target must belong to the project workspace'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
"""


class Migration(migrations.Migration):
    dependencies = [
        ("access", "0003_guards"),
        ("design", "0002_guards"),
        ("inventory", "0003_guards"),
        ("physical_units", "0002_guards"),
        ("releases", "0001_initial"),
        ("sources", "0002_guards"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.RemoveConstraint(
            model_name="projectreference",
            name="project_reference_target",
        ),
        migrations.AddField(
            model_name="projectreference",
            name="release",
            field=models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="+",
                to="releases.release",
            ),
        ),
        migrations.AlterField(
            model_name="projectreference",
            name="kind",
            field=models.CharField(
                choices=[
                    ("definition", "Definition"),
                    ("revision", "Revision"),
                    ("source_bundle", "Source Bundle"),
                    ("physical_unit", "Physical Unit"),
                    ("work_batch", "Work Batch"),
                    ("release", "Release"),
                ],
                max_length=20,
            ),
        ),
        migrations.AddConstraint(
            model_name="projectreference",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    models.Q(
                        ("definition__isnull", False),
                        ("kind", "definition"),
                        ("physical_unit__isnull", True),
                        ("release__isnull", True),
                        ("revision__isnull", True),
                        ("source_bundle__isnull", True),
                        ("work_batch__isnull", True),
                    ),
                    models.Q(
                        ("definition__isnull", True),
                        ("kind", "revision"),
                        ("physical_unit__isnull", True),
                        ("release__isnull", True),
                        ("revision__isnull", False),
                        ("source_bundle__isnull", True),
                        ("work_batch__isnull", True),
                    ),
                    models.Q(
                        ("definition__isnull", True),
                        ("kind", "source_bundle"),
                        ("physical_unit__isnull", True),
                        ("release__isnull", True),
                        ("revision__isnull", True),
                        ("source_bundle__isnull", False),
                        ("work_batch__isnull", True),
                    ),
                    models.Q(
                        ("definition__isnull", True),
                        ("kind", "physical_unit"),
                        ("physical_unit__isnull", False),
                        ("release__isnull", True),
                        ("revision__isnull", True),
                        ("source_bundle__isnull", True),
                        ("work_batch__isnull", True),
                    ),
                    models.Q(
                        ("definition__isnull", True),
                        ("kind", "work_batch"),
                        ("physical_unit__isnull", True),
                        ("release__isnull", True),
                        ("revision__isnull", True),
                        ("source_bundle__isnull", True),
                        ("work_batch__isnull", False),
                    ),
                    models.Q(
                        ("definition__isnull", True),
                        ("kind", "release"),
                        ("physical_unit__isnull", True),
                        ("release__isnull", False),
                        ("revision__isnull", True),
                        ("source_bundle__isnull", True),
                        ("work_batch__isnull", True),
                    ),
                    _connector="OR",
                ),
                name="project_reference_target",
            ),
        ),
        migrations.AddConstraint(
            model_name="projectreference",
            constraint=models.UniqueConstraint(
                condition=models.Q(("kind", "release"), ("removed_at__isnull", True)),
                fields=("project", "release", "role"),
                name="project_reference_active_release",
            ),
        ),
        migrations.RunSQL(GUARD, PREVIOUS),
    ]
