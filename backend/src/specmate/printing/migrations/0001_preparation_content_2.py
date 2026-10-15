"""Upgrade editable print preparation drafts from content schema 1 to 2.

Only the spelling of the "as_modeled" orientation status changed. Only drafts change, each
with a version bump so stale editors are rejected. Snapshots and frozen revisions keep their
exact schema 1 bytes and are normalized in memory when read.
"""

from django.db import migrations


def upgrade_drafts(apps, schema_editor):
    from specmate.printing.contracts import PREPARATION_KEY, upgrade_preparation_content

    Draft = apps.get_model("design", "Draft")
    for draft in Draft.objects.filter(definition__kind="print_preparation").iterator():
        content = draft.content.get(PREPARATION_KEY) if isinstance(draft.content, dict) else None
        if not isinstance(content, dict) or content.get("schema_version", "1") != "1":
            continue
        draft.content = {**draft.content, PREPARATION_KEY: upgrade_preparation_content(content)}
        draft.version += 1
        draft.save(update_fields=["content", "version"])


class Migration(migrations.Migration):
    dependencies = [("design", "0002_guards")]

    operations = [migrations.RunPython(upgrade_drafts, migrations.RunPython.noop)]
