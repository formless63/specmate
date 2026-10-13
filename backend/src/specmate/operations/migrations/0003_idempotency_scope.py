from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("operations", "0002_immutable_rows")]
    operations = [
        migrations.AddField(
            model_name="idempotencyrecord",
            name="scope",
            field=models.CharField(default="legacy", max_length=64),
            preserve_default=False,
        ),
        migrations.RemoveConstraint(
            model_name="idempotencyrecord", name="idempotency_actor_operation_key"
        ),
        migrations.AddConstraint(
            model_name="idempotencyrecord",
            constraint=models.UniqueConstraint(
                fields=["actor", "scope", "operation", "key"],
                name="idempotency_actor_scope_operation_key",
            ),
        ),
        migrations.AddConstraint(
            model_name="idempotencyrecord",
            constraint=models.CheckConstraint(
                condition=models.Q(scope__in=["global", "legacy"])
                | models.Q(
                    scope__regex=r"^project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
                ),
                name="idempotency_valid_scope",
            ),
        ),
    ]
