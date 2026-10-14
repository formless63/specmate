"""Current source closure checks for new intake and its disclosure surfaces."""

from specmate.access.permissions import Perm, authorize
from specmate.operations import NotFound
from specmate.sources.models import (
    SourceArchiveExpansion,
    SourceBundleRevision,
    SourceEditSubmission,
)


def authorize_revision(user, revision, permission=Perm.WORKSPACE_READ):
    pending = [revision]
    seen = set()
    while pending:
        current = pending.pop()
        if current.id in seen:
            continue
        seen.add(current.id)
        authorize(user, current.bundle.workspace_id, permission)
        for workspace_id in current.files.values_list("blob__workspace_id", flat=True).distinct():
            authorize(user, workspace_id, Perm.WORKSPACE_READ)
            if workspace_id != current.bundle.workspace_id:
                raise NotFound("Source revision not found.")
        expansion = (
            SourceArchiveExpansion.objects.select_related(
                "archive_file__revision__bundle", "archive_file__blob"
            )
            .filter(revision=current)
            .first()
        )
        if expansion:
            authorize(user, expansion.archive_file.blob.workspace_id, Perm.WORKSPACE_READ)
            pending.append(expansion.archive_file.revision)
        submission = (
            SourceEditSubmission.objects.select_related(
                "baseline__bundle", "archive_file__revision__bundle", "archive_file__blob"
            )
            .filter(revision=current)
            .first()
        )
        if submission:
            pending.append(submission.baseline)
            if submission.archive_file:
                authorize(user, submission.archive_file.blob.workspace_id, Perm.WORKSPACE_READ)
                pending.append(submission.archive_file.revision)
        if current.bundle.derived_from_id:
            pending.append(
                SourceBundleRevision.objects.select_related("bundle").get(
                    id=current.bundle.derived_from_id
                )
            )
