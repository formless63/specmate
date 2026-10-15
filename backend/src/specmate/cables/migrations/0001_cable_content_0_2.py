"""Upgrade editable cable drafts from content schema 0.1 to 0.2.

Only drafts change, each with a version bump so stale editors are rejected. Snapshots and
frozen revisions keep their exact 0.1 bytes and are upgraded in memory when read.
"""

from django.db import migrations


def upgrade_drafts(apps, schema_editor):
    from pydantic import ValidationError

    from specmate.cables.contracts import upgrade_content

    Draft = apps.get_model("design", "Draft")
    for draft in Draft.objects.filter(definition__kind="cable").iterator():
        cable = draft.content.get("cable") if isinstance(draft.content, dict) else None
        if not isinstance(cable, dict) or cable.get("schema_version", "0.1") != "0.1":
            continue
        try:
            upgraded = upgrade_content(cable)
        except ValidationError:
            # Invalid content stays as it is and keeps failing validation on its next use.
            continue
        draft.content = {**draft.content, "cable": upgraded}
        draft.version += 1
        draft.save(update_fields=["content", "version"])


class Migration(migrations.Migration):
    dependencies = [("design", "0002_guards")]

    operations = [migrations.RunPython(upgrade_drafts, migrations.RunPython.noop)]
