import uuid

from django.conf import settings
from django.db import models


class Release(models.Model):
    """An immutable reviewed release closure: a workspace item, never owned by a project.

    ``record`` is the exact reviewed closure (revisions, configurations, dependencies,
    artifacts, rights, evidence applicability and unresolved items) with the release
    decision; ``record_canonical`` holds its exact bytes. The coherent package archive
    is retained by content address. Nothing here is rewritten: later warnings attach as
    separate records that reference the release.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey("access.Workspace", on_delete=models.PROTECT, related_name="+")
    name = models.CharField(max_length=200)
    root_revision = models.ForeignKey("design.Revision", on_delete=models.PROTECT, related_name="+")
    request = models.JSONField()
    record = models.JSONField()
    record_canonical = models.BinaryField()
    record_sha256 = models.CharField(max_length=64)
    review_sha256 = models.CharField(max_length=64)
    manifest_sha256 = models.CharField(max_length=64)
    archive_sha256 = models.CharField(max_length=64)
    archive_bytes = models.PositiveBigIntegerField()
    unresolved_count = models.PositiveIntegerField()
    acknowledgement_reason = models.TextField(blank=True, default="")
    released_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    released_at = models.DateTimeField(auto_now_add=True)
    # Cutoff for build reproducibility evidence in the manifest, fixed before it was built.
    reproducibility_as_of = models.DateTimeField(null=True)
    # Export package layout of the retained archive (1 = before the bundled verifier).
    package_format = models.PositiveSmallIntegerField(default=1)
    request_id = models.CharField(max_length=200)

    class Meta:
        indexes = [models.Index(fields=["workspace", "-released_at"], name="release_ws_time")]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(name__regex=r"\S")
                & models.Q(record_sha256__regex=r"^[0-9a-f]{64}$")
                & models.Q(review_sha256__regex=r"^[0-9a-f]{64}$")
                & models.Q(manifest_sha256__regex=r"^[0-9a-f]{64}$")
                & models.Q(archive_sha256__regex=r"^[0-9a-f]{64}$"),
                name="release_valid",
            ),
            # Unresolved items are released only with an explicit, stated acknowledgement.
            models.CheckConstraint(
                condition=models.Q(unresolved_count=0)
                | models.Q(acknowledgement_reason__regex=r"\S"),
                name="release_unresolved_acknowledged",
            ),
        ]


class ReleasePin(models.Model):
    """One exact frozen revision of the release closure (database-visible where-used)."""

    release = models.ForeignKey(Release, on_delete=models.PROTECT, related_name="pins")
    revision = models.ForeignKey("design.Revision", on_delete=models.PROTECT, related_name="+")
    role = models.CharField(max_length=20)
    sha256 = models.CharField(max_length=64)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["release", "revision"], name="release_pin_unique"),
            models.CheckConstraint(
                condition=models.Q(role__in=["root", "occurrence", "dependency"]),
                name="release_pin_role",
            ),
        ]


class ReleaseConfiguration(models.Model):
    """One exact resolved configuration the closure is released as."""

    release = models.ForeignKey(Release, on_delete=models.PROTECT, related_name="configurations")
    configuration = models.ForeignKey(
        "configurations.ResolvedConfiguration", on_delete=models.PROTECT, related_name="+"
    )
    resolution_sha256 = models.CharField(max_length=64)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["release", "configuration"], name="release_configuration_unique"
            )
        ]


class ReleaseWarning(models.Model):
    """A later contradiction, security or engineering warning about one release.

    Append-only and separate from the approved record: the release is never rewritten.
    Supersession and withdrawal are further rows, never edits or deletions.
    """

    KINDS = ["contradiction", "security", "engineering"]
    SEVERITIES = ["info", "caution", "critical"]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    release = models.ForeignKey(Release, on_delete=models.PROTECT, related_name="warnings")
    kind = models.CharField(max_length=20)
    severity = models.CharField(max_length=20)
    title = models.CharField(max_length=200)
    body = models.TextField()
    # Optional exact references, each inside the release's closure.
    revision = models.ForeignKey(
        "design.Revision", null=True, on_delete=models.PROTECT, related_name="+"
    )
    source_file = models.ForeignKey(
        "sources.SourceBundleFile", null=True, on_delete=models.PROTECT, related_name="+"
    )
    # Set when the warning was raised automatically by a contradicting assertion.
    assertion = models.ForeignKey(
        "facts.FactAssertion", null=True, on_delete=models.PROTECT, related_name="+"
    )
    supersedes = models.OneToOneField(
        "self", null=True, on_delete=models.PROTECT, related_name="superseded_by"
    )
    origin = models.CharField(max_length=10, default="manual")
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    request_id = models.CharField(max_length=200)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [models.Index(fields=["release", "created_at"], name="release_warning_time")]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(kind__in=["contradiction", "security", "engineering"])
                & models.Q(severity__in=["info", "caution", "critical"])
                & models.Q(origin__in=["manual", "automatic"])
                & models.Q(title__regex=r"\S")
                & models.Q(body__regex=r"\S"),
                name="release_warning_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(origin="manual", assertion__isnull=True)
                | models.Q(origin="automatic", assertion__isnull=False),
                name="release_warning_origin",
            ),
            models.UniqueConstraint(
                fields=["release", "assertion"],
                condition=models.Q(assertion__isnull=False),
                name="release_warning_assertion_once",
            ),
        ]


class ReleaseWarningWithdrawal(models.Model):
    """A stated withdrawal of one warning. The warning stays readable."""

    warning = models.OneToOneField(
        ReleaseWarning, on_delete=models.PROTECT, related_name="withdrawal"
    )
    reason = models.TextField()
    withdrawn_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    request_id = models.CharField(max_length=200)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(reason__regex=r"\S"), name="release_withdrawal_reason"
            )
        ]
