"""Immutable reviewed release closures (EVD-004)."""

import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        ("access", "0003_guards"),
        ("configurations", "0004_adoption_guards"),
        ("design", "0002_guards"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="Release",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("name", models.CharField(max_length=200)),
                ("request", models.JSONField()),
                ("record", models.JSONField()),
                ("record_canonical", models.BinaryField()),
                ("record_sha256", models.CharField(max_length=64)),
                ("review_sha256", models.CharField(max_length=64)),
                ("manifest_sha256", models.CharField(max_length=64)),
                ("archive_sha256", models.CharField(max_length=64)),
                ("archive_bytes", models.PositiveBigIntegerField()),
                ("unresolved_count", models.PositiveIntegerField()),
                ("acknowledgement_reason", models.TextField(blank=True, default="")),
                ("released_at", models.DateTimeField(auto_now_add=True)),
                ("request_id", models.CharField(max_length=200)),
                (
                    "released_by",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT, to=settings.AUTH_USER_MODEL
                    ),
                ),
                (
                    "root_revision",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="+",
                        to="design.revision",
                    ),
                ),
                (
                    "workspace",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="+",
                        to="access.workspace",
                    ),
                ),
            ],
        ),
        migrations.CreateModel(
            name="ReleaseConfiguration",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True, primary_key=True, serialize=False, verbose_name="ID"
                    ),
                ),
                ("resolution_sha256", models.CharField(max_length=64)),
                (
                    "configuration",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="+",
                        to="configurations.resolvedconfiguration",
                    ),
                ),
                (
                    "release",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="configurations",
                        to="releases.release",
                    ),
                ),
            ],
        ),
        migrations.CreateModel(
            name="ReleasePin",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True, primary_key=True, serialize=False, verbose_name="ID"
                    ),
                ),
                ("role", models.CharField(max_length=20)),
                ("sha256", models.CharField(max_length=64)),
                (
                    "release",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="pins",
                        to="releases.release",
                    ),
                ),
                (
                    "revision",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="+",
                        to="design.revision",
                    ),
                ),
            ],
        ),
        migrations.AddIndex(
            model_name="release",
            index=models.Index(fields=["workspace", "-released_at"], name="release_ws_time"),
        ),
        migrations.AddConstraint(
            model_name="release",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("name__regex", "\\S"),
                    ("record_sha256__regex", "^[0-9a-f]{64}$"),
                    ("review_sha256__regex", "^[0-9a-f]{64}$"),
                    ("manifest_sha256__regex", "^[0-9a-f]{64}$"),
                    ("archive_sha256__regex", "^[0-9a-f]{64}$"),
                ),
                name="release_valid",
            ),
        ),
        migrations.AddConstraint(
            model_name="release",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    ("unresolved_count", 0),
                    ("acknowledgement_reason__regex", "\\S"),
                    _connector="OR",
                ),
                name="release_unresolved_acknowledged",
            ),
        ),
        migrations.AddConstraint(
            model_name="releaseconfiguration",
            constraint=models.UniqueConstraint(
                fields=("release", "configuration"), name="release_configuration_unique"
            ),
        ),
        migrations.AddConstraint(
            model_name="releasepin",
            constraint=models.UniqueConstraint(
                fields=("release", "revision"), name="release_pin_unique"
            ),
        ),
        migrations.AddConstraint(
            model_name="releasepin",
            constraint=models.CheckConstraint(
                condition=models.Q(("role__in", ["root", "occurrence", "dependency"])),
                name="release_pin_role",
            ),
        ),
    ]
