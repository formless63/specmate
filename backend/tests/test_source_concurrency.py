"""Real PostgreSQL competing source writes: one winner, an explicit stale writer, no loss.

Both writers resolve the same head before either locks the bundle. The first then holds
the bundle row lock until PostgreSQL reports the second writer waiting on a lock, so the
outcome is decided by actual database serialization rather than request ordering.
"""

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from django.db import connection, connections

from specmate.access.models import WorkspaceMember
from specmate.jobs.adapter import run_operation
from specmate.operations import Conflict, IdempotencyMismatch, NotFound, PermissionDenied
from specmate.sources import blobstore, editing
from specmate.sources import operations as source_operations
from specmate.sources.models import (
    SourceBlob,
    SourceBundleRevision,
    SourceEditSubmission,
)

from .conftest import op, remove_member
from .test_source_editing import (
    ORIGINAL,
    edited_zip,
    export,
    original,
    preview,
    submit,
    unpack,
)
from .test_sources import register, sha

pytestmark = pytest.mark.django_db(transaction=True)


def ordered_race(monkeypatch, first, second):
    """Run two writers that both read the same head before either takes the lock."""
    resolved = threading.Barrier(2)
    first_locked = threading.Event()
    blocked = threading.Event()
    local = threading.local()
    backend_pids = {}

    def gate(original_function):
        def wrapper(*args, **kwargs):
            result = original_function(*args, **kwargs)
            if not getattr(local, "gated", False):
                local.gated = True
                resolved.wait(timeout=5)
                if local.index == 1 and not first_locked.wait(timeout=5):
                    raise AssertionError("first writer never acquired the bundle lock")
            return result

        return wrapper

    def hold(original_function):
        def wrapper(*args, **kwargs):
            if local.index == 0:
                first_locked.set()
                with connection.cursor() as cursor:
                    for _ in range(200):
                        cursor.execute(
                            "SELECT %s = ANY(pg_blocking_pids(%s))",
                            [backend_pids[0], backend_pids[1]],
                        )
                        if cursor.fetchone()[0]:
                            blocked.set()
                            break
                        time.sleep(0.025)
            return original_function(*args, **kwargs)

        return wrapper

    monkeypatch.setattr(
        source_operations, "authorized_head", gate(source_operations.authorized_head)
    )
    monkeypatch.setattr(editing, "_closure", gate(editing._closure))
    monkeypatch.setattr(editing, "_write_revision", hold(editing._write_revision))
    monkeypatch.setattr(
        source_operations, "_write_revision", hold(source_operations._write_revision)
    )

    def worker(index, action):
        local.index = index
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_backend_pid()")
                backend_pids[index] = cursor.fetchone()[0]
                cursor.execute("SET lock_timeout = '10s'")
                cursor.execute("SET statement_timeout = '20s'")
            try:
                return action()
            except Conflict as error:
                return error
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = [pool.submit(worker, 0, first), pool.submit(worker, 1, second)]
        results = [future.result(timeout=30) for future in pending]
    monkeypatch.undo()
    assert blocked.is_set(), "the stale writer never waited on the winner's lock"
    return results


def call(user, operation, payload, **ctx):
    return lambda: run_operation(
        on_behalf_of=user.pk,
        operation=operation,
        payload=payload,
        request_id=f"{operation}-{user.username}-{ctx.get('idempotency_key', 'unkeyed')}",
        **ctx,
    )


def derivative(users, workspace):
    source = original(users, workspace)
    return op(
        users["editor"],
        "source.derive_bundle",
        {"source_revision_id": source["revision_id"], "name": "Editable synthetic bundle"},
    )


def files_with(main: bytes):
    contents = {**ORIGINAL, "board/main.native": main}
    return [
        {"path": p, "sha256": sha(d), "media_type": "text/plain", "rights": "synthetic-original"}
        for p, d in contents.items()
    ]


def main_hash(revision_id):
    manifest = json.loads(bytes(SourceBundleRevision.objects.get(id=revision_id).manifest))
    return {f["path"]: f["sha256"] for f in manifest["files"]}["board/main.native"]


def frozen(revision_id):
    revision = SourceBundleRevision.objects.get(id=revision_id)
    rows = list(revision.files.values_list("path", "blob__sha256", "rights").order_by("path"))
    return revision.manifest_sha256, bytes(revision.manifest), rows


def stored(data):
    with blobstore.open_blob(sha(data)) as stream:
        return stream.read() == data


def test_competing_revisions_keep_winner_stale_writer_bytes_and_recovery(
    users, workspace, monkeypatch
):
    base = derivative(users, workspace)
    before = frozen(base["revision_id"])
    register(users["editor"], workspace, b"(editor revision)")
    register(users["owner"], workspace, b"(owner revision)")
    payloads = {
        name: {"bundle_id": base["bundle_id"], "files": files_with(f"({name} revision)".encode())}
        for name in ("editor", "owner")
    }
    winner, stale = ordered_race(
        monkeypatch,
        call(
            users["editor"],
            "source.revise_bundle",
            payloads["editor"],
            expected_state=base["state"],
            idempotency_key="editor-revise",
        ),
        call(
            users["owner"],
            "source.revise_bundle",
            payloads["owner"],
            expected_state=base["state"],
            idempotency_key="owner-revise",
        ),
    )
    assert isinstance(stale, Conflict)
    assert winner.result["number"] == 2
    assert stale.details == {
        "current": "bundle-r2",
        "head_revision_id": winner.result["revision_id"],
        "head_number": 2,
        "head_manifest_sha256": winner.result["manifest_sha256"],
    }
    assert main_hash(winner.result["revision_id"]) == sha(b"(editor revision)")
    assert frozen(base["revision_id"]) == before
    # The stale writer's registered bytes are untouched by the conflict.
    assert SourceBlob.objects.filter(
        workspace_id=workspace, sha256=sha(b"(owner revision)")
    ).exists()
    assert stored(b"(owner revision)")

    replay = call(
        users["editor"],
        "source.revise_bundle",
        payloads["editor"],
        expected_state=base["state"],
        idempotency_key="editor-revise",
    )()
    assert replay.replayed and replay.result == winner.result
    # No outcome was retained for the conflict, so the same key can carry the
    # deliberate retry against the reported head.
    recovered = call(
        users["owner"],
        "source.revise_bundle",
        payloads["owner"],
        expected_state=stale.details["current"],
        idempotency_key="owner-revise",
    )()
    assert recovered.result["number"] == 3
    assert json.loads(
        bytes(SourceBundleRevision.objects.get(id=recovered.result["revision_id"]).manifest)
    )["ancestry"] == [winner.result["revision_id"]]
    assert main_hash(recovered.result["revision_id"]) == sha(b"(owner revision)")
    assert main_hash(winner.result["revision_id"]) == sha(b"(editor revision)")


def test_browser_edit_losing_to_agent_revision_retains_upload_and_recovers_separately(
    users, workspace, monkeypatch, artifact_root
):
    base = derivative(users, workspace)
    register(users["owner"], workspace, b"(agent revision)")
    archive = edited_zip(
        users,
        workspace,
        base["revision_id"],
        lambda entries: entries.__setitem__("board/main.native", b"(browser edit)"),
    )
    payload = {"baseline_revision_id": base["revision_id"], "archive": archive}
    reviewed = preview(users["editor"], payload)
    upload = frozen(archive["revision_id"])
    agent, browser = ordered_race(
        monkeypatch,
        call(
            users["owner"],
            "source.revise_bundle",
            {"bundle_id": base["bundle_id"], "files": files_with(b"(agent revision)")},
            expected_state=base["state"],
        ),
        lambda: submit(users["editor"], payload, reviewed, target="next_revision"),
    )
    assert isinstance(browser, Conflict)
    assert browser.details["state"] == "bundle-r2"
    assert browser.details["head_revision_id"] == agent.result["revision_id"]
    assert not SourceEditSubmission.objects.exists()
    # The uploaded archive is preserved as its own original; nothing staged is left.
    assert frozen(archive["revision_id"]) == upload
    zip_hash = SourceBundleRevision.objects.get(id=archive["revision_id"]).files.get().blob.sha256
    with blobstore.open_blob(zip_hash) as stream:
        assert unpack(stream.read())["board/main.native"] == b"(browser edit)"
    assert not any((artifact_root / "staging").iterdir())

    again = preview(users["editor"], payload)
    assert not again["baseline_is_head"] and not again["next_revision_allowed"]
    assert again["state"] == "bundle-r2" and again["review_sha256"] == reviewed["review_sha256"]
    with pytest.raises(Conflict, match="current head of a derivative"):
        submit(users["editor"], payload, again, target="next_revision")
    separate = submit(users["editor"], payload, again)
    revision = SourceBundleRevision.objects.select_related("bundle").get(id=separate["revision_id"])
    assert str(revision.bundle.derived_from_id) == base["revision_id"]
    assert main_hash(separate["revision_id"]) == sha(b"(browser edit)")
    assert main_hash(agent.result["revision_id"]) == sha(b"(agent revision)")


def test_competing_reviewed_edits_force_rereview_against_winner(users, workspace, monkeypatch):
    base = derivative(users, workspace)
    entries = unpack(export(users["editor"], base["revision_id"]).content)
    edits = {}
    for writer in ("editor", "owner"):
        changed = {**entries, "board/main.native": f"({writer} edit)".encode()}
        for data in changed.values():
            register(users[writer], workspace, data)
        edits[writer] = {
            "baseline_revision_id": base["revision_id"],
            "files": [{"path": p, "sha256": sha(d)} for p, d in changed.items()],
        }
    reviews = {writer: preview(users[writer], edits[writer]) for writer in edits}
    winner, stale = ordered_race(
        monkeypatch,
        lambda: submit(
            users["editor"],
            edits["editor"],
            reviews["editor"],
            target="next_revision",
            idempotency_key="editor-edit",
        ),
        lambda: submit(
            users["owner"],
            edits["owner"],
            reviews["owner"],
            target="next_revision",
            idempotency_key="owner-edit",
        ),
    )
    assert (
        isinstance(stale, Conflict) and stale.details["head_revision_id"] == winner["revision_id"]
    )
    assert stored(b"(owner edit)")
    # Recovery is a fresh review against the winner: it shows exactly what the stale
    # writer's files would replace, and the winner remains an immutable revision.
    # The marker still names the original baseline, so retargeting is deliberate.
    with pytest.raises(Conflict, match="different revision"):
        preview(users["owner"], {**edits["owner"], "baseline_revision_id": winner["revision_id"]})
    against_head = {
        "baseline_revision_id": winner["revision_id"],
        "files": [f for f in edits["owner"]["files"] if f["path"] != editing.MARKER],
    }
    current = preview(users["owner"], against_head)
    rows = {row["path"]: row for row in current["files"]}
    assert rows["board/main.native"]["change"] == "modified"
    assert rows["board/main.native"]["baseline_sha256"] == sha(b"(editor edit)")
    with pytest.raises(Conflict, match="review it again"):
        submit(
            users["owner"],
            against_head,
            {**current, "review_sha256": reviews["owner"]["review_sha256"]},
            target="next_revision",
        )
    recovered = submit(
        users["owner"], against_head, current, target="next_revision", idempotency_key="owner-edit"
    )
    assert recovered["number"] == 3
    assert main_hash(recovered["revision_id"]) == sha(b"(owner edit)")
    assert main_hash(winner["revision_id"]) == sha(b"(editor edit)")
    replay = submit(
        users["editor"],
        edits["editor"],
        reviews["editor"],
        target="next_revision",
        idempotency_key="editor-edit",
    )
    assert replay == winner


def test_duplicate_keyed_submission_creates_once_and_replays_winner(users, workspace, monkeypatch):
    base = derivative(users, workspace)
    register(users["editor"], workspace, b"(double submit)")
    payload = {"bundle_id": base["bundle_id"], "files": files_with(b"(double submit)")}
    request = call(
        users["editor"],
        "source.revise_bundle",
        payload,
        expected_state=base["state"],
        idempotency_key="double",
    )
    winner, duplicate = ordered_race(monkeypatch, request, request)
    assert isinstance(duplicate, Conflict)
    replay = request()
    assert replay.replayed and replay.result == winner.result
    assert SourceBundleRevision.objects.filter(bundle_id=base["bundle_id"]).count() == 2


def test_revision_closure_and_retained_authority_precede_conflicts(users, workspace):
    base = derivative(users, workspace)
    register(users["editor"], workspace, b"(keyed)")
    payload = {"bundle_id": base["bundle_id"], "files": files_with(b"(keyed)")}
    revise = call(
        users["editor"],
        "source.revise_bundle",
        payload,
        expected_state=base["state"],
        idempotency_key="retained",
    )
    revise()
    WorkspaceMember.objects.filter(workspace_id=workspace, user=users["editor"]).update(
        role="viewer"
    )
    for body in (payload, {**payload, "files": files_with(b"(other)")}):
        with pytest.raises(PermissionDenied):
            call(
                users["editor"],
                "source.revise_bundle",
                body,
                expected_state=base["state"],
                idempotency_key="retained",
            )()
    WorkspaceMember.objects.filter(workspace_id=workspace, user=users["editor"]).update(
        role="editor"
    )
    with pytest.raises(IdempotencyMismatch):
        call(
            users["editor"],
            "source.revise_bundle",
            {**payload, "files": files_with(b"(other)")},
            expected_state=base["state"],
            idempotency_key="retained",
        )()
    # Losing membership hides state before stale diagnostics or replay.
    remove_member(users["editor"])
    for key in (None, "retained"):
        with pytest.raises(NotFound):
            call(
                users["editor"],
                "source.revise_bundle",
                payload,
                expected_state="bundle-r1",
                **({"idempotency_key": key} if key else {}),
            )()


def test_derivation_authorizes_source_closure_before_diagnostics_and_replay(users, workspace):
    source = original(users, workspace)
    derive = call(
        users["editor"],
        "source.derive_bundle",
        {"source_revision_id": source["revision_id"], "name": "Keyed derivative"},
        idempotency_key="derive",
    )
    created = derive()
    WorkspaceMember.objects.filter(workspace_id=workspace, user=users["editor"]).update(
        role="viewer"
    )
    for name in ("Keyed derivative", "Other name"):
        with pytest.raises(PermissionDenied):
            call(
                users["editor"],
                "source.derive_bundle",
                {"source_revision_id": source["revision_id"], "name": name},
                idempotency_key="derive",
            )()
    WorkspaceMember.objects.filter(workspace_id=workspace, user=users["editor"]).update(
        role="editor"
    )
    assert derive().result == created.result
    # Losing membership hides the source rather than producing a registration diagnostic.
    remove_member(users["editor"])
    for key in (None, "derive"):
        with pytest.raises(NotFound):
            call(
                users["editor"],
                "source.derive_bundle",
                {"source_revision_id": source["revision_id"], "name": "Keyed derivative"},
                **({"idempotency_key": key} if key else {}),
            )()
