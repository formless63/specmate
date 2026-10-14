import uuid

from django.conf import settings
from django.db import models


class ResolvedConfiguration(models.Model):
    """Immutable resolved snapshot a build consumes instead of mutable option defaults.

    The design snapshot pins every exact revision; the canonical resolution records each
    decision, its source (selected/default/none) and every unresolved choice.
    """

    class Status(models.TextChoices):
        COMPLETE = "complete"
        INCOMPLETE = "incomplete"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey("access.Workspace", on_delete=models.PROTECT, related_name="+")
    draft = models.ForeignKey("design.Draft", on_delete=models.PROTECT, related_name="+")
    draft_version = models.PositiveIntegerField()
    snapshot = models.OneToOneField(
        "design.Snapshot", on_delete=models.PROTECT, related_name="resolved_configuration"
    )
    option_set_revision = models.ForeignKey(
        "design.Revision", on_delete=models.PROTECT, related_name="+"
    )
    status = models.CharField(max_length=20, choices=Status.choices)
    resolution = models.JSONField()
    resolution_canonical = models.BinaryField()
    resolution_sha256 = models.CharField(max_length=64)
    review_sha256 = models.CharField(max_length=64)
    basis = models.TextField()
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(status__in=["complete", "incomplete"])
                & models.Q(draft_version__gte=1)
                & models.Q(resolution_sha256__regex=r"^[0-9a-f]{64}$")
                & models.Q(review_sha256__regex=r"^[0-9a-f]{64}$")
                & models.Q(basis__regex=r"\S"),
                name="resolved_configuration_valid",
            )
        ]
        indexes = [models.Index(fields=["draft", "-created_at"], name="resolved_config_draft")]


class ConfigurationAdoption(models.Model):
    """Immutable reviewed change of an owning assembly draft from one resolved configuration.

    Provenance for the draft change: the exact resolved configuration, the selected
    decisions, the reviewed diff, the draft content before and after, and every
    containing sub-assembly revision frozen to propagate a nested choice. No frozen
    revision is modified; a new draft or an explicitly selected one is.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey("access.Workspace", on_delete=models.PROTECT, related_name="+")
    resolved_configuration = models.ForeignKey(
        ResolvedConfiguration, on_delete=models.PROTECT, related_name="adoptions"
    )
    draft = models.ForeignKey("design.Draft", on_delete=models.PROTECT, related_name="+")
    draft_version = models.PositiveIntegerField()
    created_draft = models.BooleanField()
    base_revision = models.ForeignKey(
        "design.Revision", on_delete=models.PROTECT, null=True, related_name="+"
    )
    option_keys = models.JSONField()
    review = models.JSONField()
    review_canonical = models.BinaryField()
    review_sha256 = models.CharField(max_length=64)
    before_content = models.JSONField()
    before_canonical = models.BinaryField()
    after_content = models.JSONField()
    # Containing sub-assembly revisions frozen by this adoption from new drafts of their
    # exact pinned revisions, so the owning draft could re-pin a nested choice.
    propagated = models.JSONField(default=list)
    basis = models.TextField()
    adopted_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["draft", "draft_version"], name="configuration_adoption_draft_version"
            ),
            models.CheckConstraint(
                condition=models.Q(draft_version__gte=1)
                & models.Q(review_sha256__regex=r"^[0-9a-f]{64}$")
                & models.Q(basis__regex=r"\S"),
                name="configuration_adoption_valid",
            ),
        ]
        indexes = [
            models.Index(
                fields=["resolved_configuration", "-created_at"], name="configuration_adoption_rc"
            )
        ]


class DevelopmentLink(models.Model):
    """A development proposal linked to one failing rule of a configuration (CFG-003).

    The proposal is a separate workspace item: a `development_need` definition (adapter
    board, cable or enclosure work) or an existing mechanical proposal draft. The link
    records the rule key, the exact option-set revision and the outcome observed when it
    was made. It never changes a constraint outcome, a resolution or build eligibility.
    Rows are append-only; unlinking records who removed the link and why.
    """

    class Target(models.TextChoices):
        DEVELOPMENT_NEED = "development_need"
        MECHANICAL_PROPOSAL = "mechanical_proposal"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey("access.Workspace", on_delete=models.PROTECT, related_name="+")
    configuration = models.ForeignKey(
        "design.Definition", on_delete=models.PROTECT, related_name="+"
    )
    option_set_revision = models.ForeignKey(
        "design.Revision", on_delete=models.PROTECT, related_name="+"
    )
    rule_key = models.CharField(max_length=200)
    observed_outcome = models.CharField(max_length=20)
    target = models.CharField(max_length=30, choices=Target.choices)
    need = models.ForeignKey(
        "design.Definition", null=True, on_delete=models.PROTECT, related_name="+"
    )
    mechanical_proposal = models.ForeignKey(
        "mechanical_proposals.ProposalDraft", null=True, on_delete=models.PROTECT, related_name="+"
    )
    basis = models.TextField()
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    request_id = models.CharField(max_length=200)
    created_at = models.DateTimeField(auto_now_add=True)
    removed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.PROTECT, related_name="+"
    )
    removed_at = models.DateTimeField(null=True)
    removal_reason = models.TextField(blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(observed_outcome__in=["invalid", "unknown"])
                & models.Q(basis__regex=r"\S")
                & models.Q(rule_key__regex=r"\S")
                & (
                    models.Q(
                        target="development_need",
                        need__isnull=False,
                        mechanical_proposal__isnull=True,
                    )
                    | models.Q(
                        target="mechanical_proposal",
                        need__isnull=True,
                        mechanical_proposal__isnull=False,
                    )
                )
                & (
                    models.Q(removed_at__isnull=True, removed_by__isnull=True, removal_reason="")
                    | (
                        models.Q(removed_at__isnull=False, removed_by__isnull=False)
                        & models.Q(removal_reason__regex=r"\S")
                    )
                ),
                name="development_link_valid",
            ),
            models.UniqueConstraint(
                fields=["configuration", "rule_key", "need"],
                condition=models.Q(removed_at__isnull=True, need__isnull=False),
                name="development_link_need_once",
            ),
            models.UniqueConstraint(
                fields=["configuration", "rule_key", "mechanical_proposal"],
                condition=models.Q(removed_at__isnull=True, mechanical_proposal__isnull=False),
                name="development_link_proposal_once",
            ),
        ]
        indexes = [
            models.Index(fields=["configuration", "created_at"], name="development_link_config"),
            models.Index(fields=["workspace", "created_at"], name="development_link_workspace"),
        ]
