"""Selected-root immutable document paging and fresh current authority boundaries."""

import json
from unittest.mock import patch

import pytest
from django.core import signing
from django.utils import timezone

from specmate.operations import NotFound, ValidationFailed
from specmate.preparation_documents import operations
from specmate.preparation_documents.models import DocumentSet

from .conftest import ensure_member, op, remove_member
from .test_preparation import cable
from .test_preparation_documents import configuration, files, retain
from .test_transports import api, post_op


def test_viewer_paging_is_root_bound_deterministic_and_does_not_change_legacy_outputs(
    users, project, monkeypatch
):
    owner = users["owner"]
    _, root = cable(owner, project)
    _, other = cable(owner, project)
    stamp = timezone.now()
    with patch("django.utils.timezone.now", return_value=stamp):
        saved = [
            retain(owner, configuration(root, quantity=index + 1), key=f"page-{index}")[1]
            for index in range(3)
        ]
    retain(owner, configuration(other), key="other-root")
    original = files(owner, saved[0])
    assert saved[0]["generator"] == "specmate.preparation-documents/2"
    expected = [
        str(row.id)
        for row in DocumentSet.objects.filter(root_revision_id=root["revision_id"]).order_by(
            "-created_at", "id"
        )
    ]
    monkeypatch.setattr(
        operations, "render", lambda *_: pytest.fail("History must not regenerate retained bytes.")
    )
    payload = {"root_revision_id": root["revision_id"], "limit": 2}
    first = op(users["viewer"], "preparation_documents.list", payload)
    assert [row["document_set_id"] for row in first["results"]] == expected[:2]
    assert first["next_after"] and "total" not in first
    assert all(row["root_revision_id"] == root["revision_id"] for row in first["results"])
    assert op(users["viewer"], "preparation_documents.list", payload)["results"] == first["results"]
    second = op(
        users["viewer"], "preparation_documents.list", {**payload, "after": first["next_after"]}
    )
    assert [row["document_set_id"] for row in second["results"]] == expected[2:]
    assert second["next_after"] is None
    response = post_op(api(users["viewer"]), "preparation_documents.list", payload)
    assert response.status_code == 200 and response.json()["result"]["results"] == first["results"]
    with pytest.raises(ValidationFailed):
        op(
            users["viewer"],
            "preparation_documents.list",
            {**payload, "root_revision_id": other["revision_id"], "after": first["next_after"]},
        )
    receipt = op(
        users["viewer"],
        "preparation_documents.read",
        {"document_set_id": saved[0]["document_set_id"]},
    )
    assert receipt == saved[0]
    assert files(users["viewer"], saved[0]) == original


def test_unreadable_candidate_closure_hides_metadata_without_counts_and_can_restore(
    users, project, monkeypatch
):
    owner = users["owner"]
    _, root = cable(owner, project)
    saved = [
        retain(owner, configuration(root, quantity=i + 1), key=f"hidden-{i}")[1] for i in range(3)
    ]
    hidden = saved[1]["document_set_id"]
    original = operations.authorized_set
    blocked = True

    def fresh_source_closure(user, identifier, *args):
        # Inject the shared receipt guard's source-denial boundary, without mutating
        # immutable source records or pretending projects are independent ACLs.
        if blocked and str(identifier) == hidden:
            raise NotFound("Synthetic retained source closure unavailable.")
        return original(user, identifier, *args)

    monkeypatch.setattr(operations, "authorized_set", fresh_source_closure)
    payload = {"root_revision_id": root["revision_id"], "limit": 2}
    found = []
    page = op(users["viewer"], "preparation_documents.list", payload)
    while True:
        assert "total" not in page and "hidden" not in page
        found.extend(row["document_set_id"] for row in page["results"])
        if not page["next_after"]:
            break
        page = op(
            users["viewer"], "preparation_documents.list", {**payload, "after": page["next_after"]}
        )
    assert set(found) == {row["document_set_id"] for row in saved} - {hidden}
    blocked = False
    restored = op(users["viewer"], "preparation_documents.list", {**payload, "limit": 50})
    assert {row["document_set_id"] for row in restored["results"]} == {
        row["document_set_id"] for row in saved
    }
    remove_member(users["viewer"])
    with pytest.raises(NotFound):
        op(users["viewer"], "preparation_documents.list", {**payload, "after": "malformed"})
    assert post_op(api(users["viewer"]), "preparation_documents.list", payload).status_code == 404
    ensure_member(users["viewer"])
    assert op(users["viewer"], "preparation_documents.list", {**payload, "limit": 50}) == restored


@pytest.mark.parametrize("cursor", ["bad", "e30", "WyJkb2N1bWVudHMvMSIsbnVsbCxudWxsLG51bGxd"])
def test_invalid_cursor_does_not_fall_back_to_unbounded_history(users, project, cursor):
    _, root = cable(users["owner"], project)
    with pytest.raises(ValidationFailed):
        op(
            users["viewer"],
            "preparation_documents.list",
            {"root_revision_id": root["revision_id"], "after": cursor},
        )


def test_cursor_contains_no_denied_candidate_identity_and_rejects_tampering(
    users, project, monkeypatch
):
    owner = users["owner"]
    _, root = cable(owner, project)
    saved = [
        retain(owner, configuration(root, quantity=i + 1), key=f"opaque-{i}")[1] for i in range(3)
    ]
    hidden = saved[1]
    original = operations.authorized_set

    def guarded(user, identifier, *args):
        if str(identifier) == hidden["document_set_id"]:
            raise NotFound("Source unavailable.")
        return original(user, identifier, *args)

    monkeypatch.setattr(operations, "authorized_set", guarded)
    monkeypatch.setattr(operations, "SET_SCAN_LIMIT", 2)
    payload = {"root_revision_id": root["revision_id"], "limit": 2}
    first = op(users["viewer"], "preparation_documents.list", payload)
    encoded = first["next_after"]
    decoded = signing.loads(encoded, salt=operations.SET_CURSOR_SALT)
    assert set(decoded) == {"version", "root", "anchor", "offset"}
    assert hidden["document_set_id"] not in json.dumps(decoded)
    assert hidden["created_at"] not in json.dumps(decoded)
    assert decoded["root"] == root["revision_id"]
    assert decoded["offset"] == 2
    second = op(users["viewer"], "preparation_documents.list", {**payload, "after": encoded})
    assert second["results"][0]["document_set_id"] == saved[0]["document_set_id"]
    for invalid in (
        encoded + "x",
        signing.dumps({**decoded, "version": 2}, salt=operations.SET_CURSOR_SALT),
    ):
        with pytest.raises(ValidationFailed):
            op(users["viewer"], "preparation_documents.list", {**payload, "after": invalid})


def test_cursor_freezes_insertion_window(users, project):
    owner = users["owner"]
    _, root = cable(owner, project)
    saved = [
        retain(owner, configuration(root, quantity=i + 1), key=f"window-{i}")[1] for i in range(2)
    ]
    payload = {"root_revision_id": root["revision_id"], "limit": 1}
    first = op(users["viewer"], "preparation_documents.list", payload)
    late = retain(owner, configuration(root, quantity=3), key="window-late")[1]
    second = op(
        users["viewer"], "preparation_documents.list", {**payload, "after": first["next_after"]}
    )
    observed = [row["document_set_id"] for page in (first, second) for row in page["results"]]
    assert set(observed) == {row["document_set_id"] for row in saved}
    assert late["document_set_id"] not in observed
    assert second["next_after"] is None
