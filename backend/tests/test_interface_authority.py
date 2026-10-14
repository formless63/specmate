"""Direct interface reads retain current actor and valid catalog-origin authority."""

import pytest
from django.contrib.auth import get_user_model

from specmate.access.models import WorkspaceMember
from specmate.design.models import Snapshot
from specmate.interfaces.queries import inspect_revision
from specmate.operations import NotFound, Unauthenticated

from .test_interfaces import create, freeze, pinout
from .test_shared_read_authority import adopt_with_remote_origin, restore, revoke


@pytest.mark.parametrize("nested", [False, True])
def test_interface_retained_origin_denial_and_exact_recovery(users, project, nested):
    original = freeze(users["owner"], create(users["owner"], project))
    remote, _, adopted = adopt_with_remote_origin(users, project, original)
    target = (
        freeze(users["owner"], create(users["owner"], project, pinout(adopted)))
        if nested
        else adopted
    )
    actor = users["viewer"]
    before = inspect_revision(actor, target["revision_id"])
    raw = bytes(Snapshot.objects.get(pk=target["snapshot_id"]).canonical)
    revoke(users, remote)
    with pytest.raises(NotFound, match="Project not found"):
        inspect_revision(actor, target["revision_id"])
    restore(users, remote)
    assert inspect_revision(actor, target["revision_id"]) == before
    assert bytes(Snapshot.objects.get(pk=target["snapshot_id"]).canonical) == raw


def test_direct_interface_reader_rechecks_captured_inactive_actor(users, project):
    target = freeze(users["owner"], create(users["owner"], project))
    actor = users["viewer"]
    before = inspect_revision(actor, target["revision_id"])
    get_user_model().objects.filter(pk=actor.pk).update(is_active=False)
    assert actor.is_active
    with pytest.raises(Unauthenticated):
        inspect_revision(actor, target["revision_id"])
    get_user_model().objects.filter(pk=actor.pk).update(is_active=True)
    assert inspect_revision(actor, target["revision_id"]) == before


def test_changed_interface_key_authorizes_retained_receipt_after_draft_drops_origin(users, project):
    from specmate.queries import get_draft

    from .conftest import ensure_member, op

    owner = users["owner"]
    body = freeze(owner, create(owner, project))
    remote, _, adopted = adopt_with_remote_origin(users, project, body)
    original = pinout(adopted)
    saved = create(owner, project, original, idempotency_key="retained-interface")
    # Latest draft no longer contains the old protected origin; receipt still does.
    newer = op(
        owner,
        "interface.update",
        {"draft_id": saved["draft_id"], "interface": pinout(body)},
        expected_state=saved["state"],
    )
    WorkspaceMember.objects.filter(workspace__projects=remote, user=owner).delete()
    assert get_draft(owner, saved["draft_id"])["state"] == newer["state"]
    with pytest.raises(NotFound):
        create(owner, project, pinout(body), idempotency_key="retained-interface")
    with pytest.raises(NotFound):
        create(owner, project, original, idempotency_key="retained-interface")
    ensure_member(owner, "owner", project=remote)
    assert create(owner, project, original, idempotency_key="retained-interface") == saved
    assert get_draft(owner, saved["draft_id"])["state"] == newer["state"]
