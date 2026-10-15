"""Rename the stored preference key "wire_colours" to "wire_colors".

Preference rows are editable defaults, not frozen content. A row that changes gets a version
bump so stale editors are rejected. A row that already has the new key keeps it.
"""

from django.db import migrations


def rename_key(apps, schema_editor):
    Preferences = apps.get_model("preferences", "MakerPreferences")
    for row in Preferences.objects.all().iterator():
        if not isinstance(row.values, dict) or "wire_colours" not in row.values:
            continue
        values = dict(row.values)
        legacy = values.pop("wire_colours")
        values.setdefault("wire_colors", legacy)
        row.values = values
        row.version += 1
        row.save(update_fields=["values", "version"])


class Migration(migrations.Migration):
    dependencies = [("preferences", "0001_initial")]

    operations = [migrations.RunPython(rename_key, migrations.RunPython.noop)]
