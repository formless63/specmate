"""Current source authority for new intake and its disclosure surfaces.

A bundle revision, its blobs, its archive and edit ancestry, and its derivation chain all
live in one workspace; database guards enforce that. Authority is therefore one fresh
membership and role check on the revision's workspace, never a walk of the closure.
"""

from specmate.access.permissions import Perm, authorize


def authorize_revision(user, revision, permission=Perm.WORKSPACE_READ):
    return authorize(user, revision.bundle.workspace_id, permission)
