"""ACC-EVD-005: later warnings attach beside an immutable release record.

Synthetic generic definitions on real PostgreSQL; nothing here is physical qualification.
"""

import base64
import hashlib
import json

import pytest
from django.db import DatabaseError, transaction

from specmate.design.models import Revision
from specmate.operations import Conflict, NotFound, PermissionDenied, ValidationFailed
from specmate.releases.models import Release, ReleaseWarning, ReleaseWarningWithdrawal

from .conftest import op
from .test_facts import append, fact, subject
from .test_releases import ACK, closure, release, request, review  # noqa: F401


@pytest.fixture
def released(users, closure):  # noqa: F811
    payload = request(closure)
    created = release(users["editor"], payload, review(users["viewer"], payload), **ACK)
    return {**closure, "release": created}


def warn(user, released, **changes):
    body = {
        "release_id": released["release"]["release_id"],
        "kind": "security",
        "severity": "caution",
        "title": "Synthetic advisory",
        "body": "A later synthetic advisory concerns this closure.",
        **changes,
    }
    return op(user, "release.warn", body)


def read(user, released):
    return op(user, "release.read", {"release_id": released["release"]["release_id"]})


def test_warning_is_visible_beside_an_unchanged_record(users, released):
    before = Release.objects.get(id=released["release"]["release_id"])
    sensor = released["sensor_r2"]["revision_id"]
    created = warn(users["contributor"], released, revision_id=sensor, kind="engineering")
    assert created["state"] == "active" and created["revision_id"] == sensor

    seen = read(users["viewer"], released)
    assert [w["warning_id"] for w in seen["warnings"]] == [created["warning_id"]]
    assert seen["record"] == released["release"]["record"]
    after = Release.objects.get(id=before.id)
    assert bytes(after.record_canonical) == bytes(before.record_canonical)
    assert after.record_sha256 == before.record_sha256
    assert op(users["viewer"], "release.verify", {"release_id": str(before.id)})["status"] == (
        "verified"
    )
    [row] = op(
        users["viewer"],
        "release.list",
        {"workspace_id": str(before.workspace_id)},
    )["releases"]
    assert row["active_warnings"] == 1

    with pytest.raises(NotFound):
        op(users["outsider"], "release.warnings", {"release_id": str(before.id)})


def test_authority_and_references_are_checked(users, released):
    with pytest.raises(PermissionDenied):
        warn(users["viewer"], released)
    with pytest.raises(NotFound):
        warn(users["outsider"], released)
    with pytest.raises(ValidationFailed):
        # Not a revision this release pins.
        warn(users["editor"], released, revision_id=released["sensor_r1"]["revision_id"])
    with pytest.raises(ValidationFailed):
        warn(
            users["editor"],
            released,
            source_revision_id="00000000-0000-0000-0000-000000000000",
            source_path="x.txt",
        )
    assert not ReleaseWarning.objects.exists()


def test_supersede_and_withdraw_never_delete(users, released):
    first = warn(users["contributor"], released)
    second = warn(users["editor"], released, supersedes_id=first["warning_id"], severity="critical")
    listed = op(
        users["viewer"], "release.warnings", {"release_id": released["release"]["release_id"]}
    )
    states = {w["warning_id"]: w["state"] for w in listed["warnings"]}
    assert states == {first["warning_id"]: "superseded", second["warning_id"]: "active"}
    assert listed["active"] == 1
    with pytest.raises(Conflict):
        warn(users["editor"], released, supersedes_id=first["warning_id"])

    # Only the author or an admin may withdraw.
    with pytest.raises(PermissionDenied):
        op(
            users["contributor"],
            "release.withdraw_warning",
            {"warning_id": second["warning_id"], "reason": "Not mine."},
        )
    with pytest.raises(PermissionDenied):
        op(
            users["viewer"],
            "release.withdraw_warning",
            {"warning_id": second["warning_id"], "reason": "Viewer."},
        )
    mine = warn(users["contributor"], released, title="Own warning")
    withdrawn = op(
        users["contributor"],
        "release.withdraw_warning",
        {"warning_id": mine["warning_id"], "reason": "Mistaken."},
    )
    assert withdrawn["state"] == "withdrawn" and withdrawn["withdrawal"]["reason"] == "Mistaken."
    by_admin = op(
        users["owner"],
        "release.withdraw_warning",
        {"warning_id": second["warning_id"], "reason": "Resolved upstream."},
    )
    assert by_admin["withdrawal"]["withdrawn_by"] == "owner"
    with pytest.raises(Conflict):
        op(
            users["owner"],
            "release.withdraw_warning",
            {"warning_id": second["warning_id"], "reason": "Again."},
        )
    with pytest.raises(Conflict):
        warn(users["editor"], released, supersedes_id=second["warning_id"])
    assert ReleaseWarning.objects.count() == 3

    for statement in (
        lambda: ReleaseWarning.objects.filter(id=first["warning_id"]).delete(),
        lambda: ReleaseWarning.objects.filter(id=first["warning_id"]).update(title="Edited"),
        lambda: ReleaseWarningWithdrawal.objects.all().delete(),
    ):
        with pytest.raises(DatabaseError), transaction.atomic():
            statement()


def test_export_carries_warnings_in_a_separate_file(users, released):
    created = warn(users["editor"], released)
    release_id = released["release"]["release_id"]
    exported = op(users["viewer"], "release.export_warnings", {"release_id": release_id})
    data = base64.b64decode(exported["content_base64"])
    assert hashlib.sha256(data).hexdigest() == exported["sha256"]
    document = json.loads(data)
    assert document["release_record_sha256"] == released["release"]["record_sha256"]
    assert [w["warning_id"] for w in document["warnings"]] == [created["warning_id"]]
    # The retained archive is exact and does not contain the warning file.
    archive = op(users["viewer"], "release.download", {"release_id": release_id})
    assert archive["sha256"] == released["release"]["archive_sha256"]


def test_contradicting_assertion_on_a_pinned_revision_warns_automatically(users, released):
    sensor = released["sensor_r2"]["revision_id"]
    ledger = subject(users["editor"], {"kind": "revision", "revision_id": sensor})
    first = append(users["editor"], ledger, fact())
    # An agreeing assertion raises nothing.
    agreeing = append(users["editor"], first, fact())
    assert not ReleaseWarning.objects.exists()
    second = append(users["editor"], agreeing, fact(magnitude="12"))
    [warning] = ReleaseWarning.objects.all()
    assert warning.origin == "automatic" and warning.kind == "contradiction"
    assert str(warning.assertion_id) == second["assertion"]["assertion_id"]
    assert str(warning.revision_id) == sensor
    # Further contradictions in an already conflicting context do not repeat it.
    append(users["editor"], second, fact(magnitude="14"))
    assert ReleaseWarning.objects.count() == 1
    seen = read(users["viewer"], released)
    assert seen["warnings"][0]["origin"] == "automatic"
    assert seen["record"] == released["release"]["record"]

    # A contradiction on an unpinned revision warns no release.
    other = subject(
        users["editor"],
        {"kind": "revision", "revision_id": released["sensor_r1"]["revision_id"]},
    )
    one = append(users["editor"], other, fact(property_name="height"))
    append(users["editor"], one, fact(property_name="height", magnitude="99"))
    assert ReleaseWarning.objects.count() == 1


def test_contradictions_on_occurrence_and_definition_subjects_warn_pinned_releases(users, released):
    sensor = released["sensor_r2"]["revision_id"]
    editor = users["editor"]

    # Occurrence subject: the sensor placed in the pinned root assembly.
    occurrence = subject(
        editor,
        {"kind": "occurrence", "snapshot_id": released["root"]["snapshot_id"], "path": ["sensor"]},
    )
    first = append(editor, occurrence, fact())
    assert not ReleaseWarning.objects.exists()
    second = append(editor, first, fact(magnitude="12"))
    [warning] = ReleaseWarning.objects.all()
    assert warning.origin == "automatic" and warning.kind == "contradiction"
    assert str(warning.assertion_id) == second["assertion"]["assertion_id"]
    assert str(warning.revision_id) == sensor
    append(editor, second, fact(magnitude="14"))
    assert ReleaseWarning.objects.count() == 1

    # Definition subject: any revision of the definition that the release pins.
    definition_id = str(Revision.objects.get(id=sensor).definition_id)
    definition = subject(editor, {"kind": "definition", "definition_id": definition_id})
    one = append(editor, definition, fact(property_name="height"))
    append(editor, one, fact(property_name="height", magnitude="99"))
    assert ReleaseWarning.objects.count() == 2
    latest = ReleaseWarning.objects.order_by("-created_at").first()
    assert str(latest.revision_id) == sensor and latest.origin == "automatic"
