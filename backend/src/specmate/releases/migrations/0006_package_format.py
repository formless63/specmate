from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("releases", "0005_reproducibility_as_of"),
    ]

    operations = [
        migrations.AddField(
            model_name="release",
            name="package_format",
            field=models.PositiveSmallIntegerField(default=1),
        ),
    ]
