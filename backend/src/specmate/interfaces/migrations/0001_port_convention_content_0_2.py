"""Upgrade editable port and conductor convention drafts from content schema 0.1 to 0.2.

Only the spelling changed: pins say "behavior", conventions say "color", "color_hex" and the
"color_code" scope. Only drafts change, each with a version bump so stale editors are
rejected. Snapshots and frozen revisions keep their exact 0.1 bytes and are normalized in
memory when read.
"""

from django.db import migrations


def upgrade_drafts(apps, schema_editor):
    from specmate.interfaces.contracts import upgrade_port_content
    from specmate.interfaces.convention_contracts import upgrade_convention

    upgraders = {"port": upgrade_port_content, "conductor_convention": upgrade_convention}
    Draft = apps.get_model("design", "Draft")
    for kind, upgrade in upgraders.items():
        for draft in Draft.objects.filter(definition__kind=kind).iterator():
            content = draft.content.get("interface") if isinstance(draft.content, dict) else None
            if not isinstance(content, dict) or content.get("schema_version", "0.1") != "0.1":
                continue
            draft.content = {**draft.content, "interface": upgrade(content)}
            draft.version += 1
            draft.save(update_fields=["content", "version"])


class Migration(migrations.Migration):
    dependencies = [("design", "0002_guards")]

    operations = [migrations.RunPython(upgrade_drafts, migrations.RunPython.noop)]
