"""KNW-004: every workspace-external hand-off is recorded; nothing is public by default."""

import hashlib

import pytest
from django.db import DatabaseError, transaction

from specmate.operations import Conflict, NotFound
from specmate.sharing.models import ShareRecord

from .conftest import op
from .test_export_packages import download, review, system  # noqa: F401


def test_download_records_who_what_when_and_listing_is_scoped(users, workspace, system):  # noqa: F811
    payload = {"root_revision_id": system["root"]["revision_id"], "quantity": 1}
    reviewed = review(users["viewer"], payload)
    assert not ShareRecord.objects.exists()  # review is not a hand-off
    raw, _ = download(users["viewer"], payload, reviewed)
    row = ShareRecord.objects.get()
    assert row.kind == "export_package"
    assert row.shared_by == users["viewer"]
    assert str(row.root_revision_id) == system["root"]["revision_id"]
    assert row.archive_sha256 == hashlib.sha256(raw).hexdigest()
    assert row.shared_at is not None

    query = {"workspace_id": workspace}
    own = op(users["viewer"], "share.list", query)
    assert own["total"] == 1 and own["shares"][0]["id"] == str(row.id)
    assert own["shares"][0]["shared_by_username"] == users["viewer"].get_username()
    assert op(users["editor"], "share.list", query)["total"] == 1  # any member sees all
    with pytest.raises(NotFound):
        op(users["outsider"], "share.list", query)


def test_failed_download_records_nothing_and_rows_are_append_only(users, system):  # noqa: F811
    payload = {"root_revision_id": system["root"]["revision_id"], "quantity": 1}
    with pytest.raises(Conflict):
        op(users["viewer"], "export_package.download", {**payload, "reviewed_sha256": "0" * 64})
    assert not ShareRecord.objects.exists()
    download(users["viewer"], payload, review(users["viewer"], payload))
    with pytest.raises(DatabaseError), transaction.atomic():
        ShareRecord.objects.update(purpose="x")
    with pytest.raises(DatabaseError), transaction.atomic():
        ShareRecord.objects.all().delete()
