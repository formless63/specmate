"""Current source closure checks for new intake and its disclosure surfaces."""

from specmate.access.permissions import Perm, authorize
from specmate.operations import NotFound
from specmate.sources.models import SourceArchiveExpansion, SourceBundleRevision


def authorize_revision(user, revision, permission=Perm.PROJECT_READ):
    pending = [revision]
    seen = set()
    while pending:
        current = pending.pop()
        if current.id in seen:
            continue
        seen.add(current.id)
        authorize(user, current.bundle.project_id, permission)
        for project_id in current.files.values_list("blob__project_id", flat=True).distinct():
            authorize(user, project_id, Perm.PROJECT_READ)
            if project_id != current.bundle.project_id:
                raise NotFound("Source revision not found.")
        expansion = (
            SourceArchiveExpansion.objects.select_related(
                "archive_file__revision__bundle", "archive_file__blob"
            )
            .filter(revision=current)
            .first()
        )
        if expansion:
            authorize(user, expansion.archive_file.blob.project_id, Perm.PROJECT_READ)
            pending.append(expansion.archive_file.revision)
        if current.bundle.derived_from_id:
            pending.append(
                SourceBundleRevision.objects.select_related("bundle").get(
                    id=current.bundle.derived_from_id
                )
            )
