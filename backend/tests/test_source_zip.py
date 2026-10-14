import io
import json
import stat
import struct
import zipfile

import pytest
from django.test import Client, RequestFactory

from specmate.access.models import WorkspaceMember
from specmate.operations import (
    Context,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
    execute,
)
from specmate.sources import blobstore, zip_intake
from specmate.sources.api import download_file, list_revisions, read_revision
from specmate.sources.models import SourceBlob, SourceBundle, SourceBundleFile, SourceBundleRevision

from .conftest import op
from .test_sources import files, register, sha


def archive(entries=None, method=zipfile.ZIP_DEFLATED):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=method) as zip:
        for name, value in entries or [("src/board.native", b"original synthetic native bytes")]:
            zip.writestr(name, value)
    return buffer.getvalue()


def preserve(users, project, content):
    register(users["editor"], project, content)
    return op(
        users["editor"],
        "source.create_original_bundle",
        {
            "project_id": project,
            "name": "Preserved synthetic archive",
            "files": files(content, "source.zip"),
        },
    )


def payload(source):
    return {
        "source_revision_id": source["revision_id"],
        "path": "source.zip",
        "name": "Expanded synthetic archive",
        "format": "zip",
    }


def patch_field(data, local_offset, central_offset, value, code="H"):
    data = bytearray(data)
    central = data.index(b"PK\x01\x02")
    struct.pack_into("<" + code, data, local_offset, value)
    struct.pack_into("<" + code, data, central + central_offset, value)
    return bytes(data)


@pytest.mark.parametrize("method", [zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED])
def test_zip_preserves_original_rights_hashes_ancestry_and_inert_bytes(users, project, method):
    contents = {
        "src/board.native": b"unknown format stays intact",
        "run.py": b"raise SystemExit('inert')",
        "nested.zip": archive(),
        "zero.txt": b"",
    }
    content = archive(list(contents.items()), method)
    source = preserve(users, project, content)
    result = op(users["editor"], "source.expand_zip", payload(source), idempotency_key="expand")
    assert result["source_sha256"] == sha(content)
    assert result["member_count"] == 4 and result["execution"] == "none"
    assert result["expanded_bytes"] == sum(map(len, contents.values()))
    revision = SourceBundleRevision.objects.get(id=result["revision_id"])
    assert str(revision.bundle.derived_from_id) == source["revision_id"]
    manifest = json.loads(bytes(revision.manifest))
    assert manifest["ancestry"] == [source["revision_id"]]
    for entry in manifest["files"]:
        assert entry["sha256"] == sha(contents[entry["path"]])
        assert entry["rights"] == "synthetic-original"
        assert entry["media_type"] == "application/octet-stream"
        with blobstore.open_blob(entry["sha256"]) as stored:
            assert stored.read() == contents[entry["path"]]
    with blobstore.open_blob(sha(content)) as stored:
        assert stored.read() == content
    assert (
        op(users["editor"], "source.expand_zip", payload(source), idempotency_key="expand")
        == result
    )
    assert SourceBundle.objects.count() == 2
    with pytest.raises(IdempotencyMismatch):
        op(
            users["editor"],
            "source.expand_zip",
            {**payload(source), "name": "Other"},
            idempotency_key="expand",
        )


@pytest.mark.parametrize(
    "entries",
    [
        [("../outside", b"x")],
        [("/absolute", b"x")],
        [("a\\b", b"x")],
        [("a/./b", b"x")],
        [("A", b"x"), ("a", b"y")],
        [("a", b"x"), ("a/b", b"y")],
        [("a/b", b"y"), ("A", b"x")],
        [("a", b"x"), ("a/", b"")],
        [("a", b"x"), ("a/empty/", b"")],
        [("empty/", b"")],
    ],
)
def test_rejects_paths_and_collisions_without_derivative_or_staged_bytes(
    users, project, entries, artifact_root
):
    content = archive(entries)
    source = preserve(users, project, content)
    with pytest.raises(ValidationFailed):
        op(users["editor"], "source.expand_zip", payload(source), idempotency_key="reject")
    assert (
        SourceBundle.objects.count()
        == SourceBundleRevision.objects.count()
        == SourceBlob.objects.count()
        == 1
    )
    assert list((artifact_root / "staging").iterdir()) == []
    with blobstore.open_blob(sha(content)) as stream:
        assert stream.read() == content


@pytest.mark.parametrize(
    "kind", [stat.S_IFLNK, stat.S_IFIFO, stat.S_IFSOCK, stat.S_IFCHR, stat.S_IFBLK]
)
def test_rejects_link_and_special_metadata(kind):
    info = zipfile.ZipInfo("special")
    info.create_system = 3
    info.external_attr = (kind | 0o777) << 16
    with pytest.raises(ValidationFailed):
        zip_intake.inspect_archive(archive([(info, b"target")]))


def test_explicit_directories_are_checked_but_not_materialized(users, project):
    content = archive([("src/", b""), ("src/file", b"data"), ("empty/", b"")])
    source = preserve(users, project, content)
    result = op(users["editor"], "source.expand_zip", payload(source))
    assert result["member_count"] == 1
    assert list(
        SourceBundleRevision.objects.get(id=result["revision_id"]).files.values_list(
            "path", flat=True
        )
    ) == ["src/file"]


@pytest.mark.parametrize(
    "local,central,value,code",
    [
        (6, 8, 1, "H"),
        (6, 8, 8, "H"),
        (8, 10, 12, "H"),
        (4, 6, 45, "H"),
        (22, 24, zip_intake.MAX_MEMBER + 1, "I"),
        (14, 16, 0, "I"),
    ],
)
def test_rejects_encryption_descriptors_methods_versions_size_and_crc(
    local, central, value, code, artifact_root
):
    bad = patch_field(archive(), local, central, value, code)
    with pytest.raises(ValidationFailed):
        zip_intake.stage_members(bad)
    assert not (artifact_root / "staging").exists() or not list(
        (artifact_root / "staging").iterdir()
    )


def test_rejects_nul_names_without_zipfile_normalization():
    data = archive([("badXname", b"x")]).replace(b"badXname", b"bad\0name")
    with pytest.raises(ValidationFailed):
        zip_intake.inspect_archive(data)


@pytest.mark.parametrize("case", ["count", "directory", "compressed", "total", "ratio"])
def test_declared_limits_precede_any_staging(monkeypatch, case):
    data = archive([("a", b"123456"), ("b", b"123456")])
    limit = {
        "count": "MAX_ENTRIES",
        "directory": "MAX_DIRECTORY",
        "compressed": "MAX_ARCHIVE",
        "total": "MAX_EXPANDED",
        "ratio": "MAX_RATIO",
    }[case]
    monkeypatch.setattr(zip_intake, limit, 0 if case == "ratio" else 1)
    monkeypatch.setattr(
        blobstore, "stage", lambda *args: pytest.fail("must validate metadata first")
    )
    with pytest.raises(ValidationFailed):
        zip_intake.stage_members(data)


def test_false_small_declared_expansion_is_bounded_and_rolls_back(users, project, artifact_root):
    data = archive([("first", b"valid"), ("second", b"x" * 100000)])
    data = bytearray(data)
    local = data.index(b"PK\x03\x04", 4)
    central = data.index(b"PK\x01\x02", data.index(b"PK\x01\x02") + 4)
    struct.pack_into("<I", data, local + 22, 3)
    struct.pack_into("<I", data, central + 24, 3)
    source = preserve(users, project, bytes(data))
    with pytest.raises(ValidationFailed):
        op(users["editor"], "source.expand_zip", payload(source), idempotency_key="bad-size")
    assert SourceBlob.objects.count() == 1
    assert SourceBundle.objects.count() == 1
    assert list((artifact_root / "staging").iterdir()) == []


@pytest.mark.parametrize(
    "change", [lambda d: d[:-1], lambda d: b"prefix" + d, lambda d: d + b"trailing"]
)
def test_rejects_truncated_prefixed_and_trailing_archives(change):
    with pytest.raises(ValidationFailed):
        zip_intake.stage_members(change(archive()))


def test_corrupt_later_member_cleans_all_staging_and_same_key_can_retry(
    users, project, artifact_root
):
    bad = archive([("first", b"okay"), ("second", b"bad")])
    bad = bytearray(bad)
    central = bad.index(b"PK\x01\x02", bad.index(b"PK\x01\x02") + 4)
    struct.pack_into("<I", bad, central + 16, 0)  # local/central disagreement
    source = preserve(users, project, bytes(bad))
    with pytest.raises(ValidationFailed):
        op(users["editor"], "source.expand_zip", payload(source), idempotency_key="retry")
    good = preserve(users, project, archive())
    result = op(users["editor"], "source.expand_zip", payload(good), idempotency_key="retry")
    assert result["member_count"] == 1
    assert list((artifact_root / "staging").iterdir()) == []


@pytest.mark.parametrize("via", ["api", "mcp", "job"])
def test_authority_shared_across_adapters_and_replay(users, project, via):
    source = preserve(users, project, archive())
    context = Context(user=users["editor"], via=via, request_id="expand", idempotency_key="expand")
    result = execute("source.expand_zip", context, payload(source))
    assert not result.replayed
    assert execute("source.expand_zip", context, payload(source)).replayed
    for actor, error in [("viewer", PermissionDenied), ("outsider", NotFound)]:
        with pytest.raises(error):
            execute(
                "source.expand_zip",
                Context(user=users[actor], via=via, request_id="deny"),
                payload(source),
            )
    WorkspaceMember.objects.filter(workspace__projects=project, user=users["editor"]).delete()
    for p in [payload(source), {**payload(source), "name": "mismatched"}]:
        with pytest.raises(NotFound):
            execute("source.expand_zip", context, p)


def test_http_command_preserves_and_expands_through_registered_operation(users, project):
    source = preserve(users, project, archive())
    client = Client()
    client.force_login(users["editor"])
    result = client.post(
        "/api/v0/operations",
        data=json.dumps(
            {
                "operation": "source.expand_zip",
                "request_id": "http-expand",
                "idempotency_key": "http-expand",
                "payload": payload(source),
            }
        ),
        content_type="application/json",
    )
    assert result.status_code == 200, result.content
    assert result.json()["result"]["member_count"] == 1


def test_new_inventory_closure_hides_foreign_blobs_before_diagnostics(users, project):
    source = preserve(users, project, archive())
    other = op(users["outsider"], "project.create", {"name": "Private source"})["project_id"]
    register(users["outsider"], other, b"hidden bytes")
    revision = SourceBundleRevision.objects.get(id=source["revision_id"])
    SourceBundleFile.objects.create(
        revision=revision,
        path="private-name",
        media_type="text/plain",
        rights="private",
        blob=SourceBlob.objects.get(project_id=other),
    )
    request = RequestFactory().get("/")
    request.user = users["editor"]
    with pytest.raises(NotFound):
        list_revisions(request, project)
    for action in [
        lambda: read_revision(request, revision.id),
        lambda: download_file(request, revision.id, "missing"),
        lambda: op(
            users["editor"],
            "source.expand_zip",
            {**payload(source), "path": "missing"},
            idempotency_key="no-leak",
        ),
    ]:
        with pytest.raises(NotFound):
            action()


def test_expansion_provenance_reopens_and_plain_revisions_do_not_claim_parser(users, project):
    from specmate.sources.models import SourceArchiveExpansion

    source = preserve(users, project, archive())
    result = op(users["editor"], "source.expand_zip", payload(source))
    request = RequestFactory().get("/")
    request.user = users["editor"]
    detail = read_revision(request, result["revision_id"])
    assert detail["expansion"] == {
        "parser": "specmate-classic-zip-v1",
        "source_revision_id": source["revision_id"],
        "path": "source.zip",
        "sha256": result["source_sha256"],
        "rights": "synthetic-original",
        "execution": "none",
    }
    original = read_revision(request, source["revision_id"])
    assert original["expansion"] is None
    revised = op(
        users["editor"],
        "source.revise_bundle",
        {
            "bundle_id": result["bundle_id"],
            "files": [
                {k: v for k, v in file.items() if k != "bytes"}
                for file in detail["manifest"]["files"]
            ],
        },
        expected_state=result["state"],
    )
    assert read_revision(request, revised["revision_id"])["expansion"] is None
    assert SourceArchiveExpansion.objects.count() == 1


def test_database_guards_exact_archive_parent_parser_and_immutable_provenance(users, project):
    from django.db import connection, transaction
    from django.db.utils import DatabaseError

    from specmate.sources.models import SourceArchiveExpansion

    source = preserve(users, project, archive())
    result = op(users["editor"], "source.expand_zip", payload(source))
    expansion = SourceArchiveExpansion.objects.get(revision_id=result["revision_id"])
    for sql in [
        "UPDATE sources_sourcearchiveexpansion SET parser = 'other' WHERE revision_id = %s",
        "DELETE FROM sources_sourcearchiveexpansion WHERE revision_id = %s",
    ]:
        with pytest.raises(DatabaseError), transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(sql, [expansion.revision_id])
    other = preserve(users, project, archive([("other", b"other")]))
    derivative = op(
        users["editor"],
        "source.derive_bundle",
        {
            "source_revision_id": other["revision_id"],
            "name": "Plain derived source",
        },
    )
    for target, parser in [
        (derivative["revision_id"], "specmate-classic-zip-v1"),
        (source["revision_id"], "specmate-classic-zip-v1"),
    ]:
        with pytest.raises(DatabaseError), transaction.atomic():
            SourceArchiveExpansion.objects.create(
                revision_id=target,
                archive_file=expansion.archive_file,
                parser=parser,
            )
    same_parent = op(
        users["editor"],
        "source.derive_bundle",
        {
            "source_revision_id": source["revision_id"],
            "name": "Other derivative",
        },
    )
    with pytest.raises(DatabaseError), transaction.atomic():
        SourceArchiveExpansion.objects.create(
            revision_id=same_parent["revision_id"],
            archive_file=expansion.archive_file,
            parser="unrecognized-parser",
        )
    with pytest.raises(DatabaseError), transaction.atomic():
        SourceBundle.objects.filter(id=result["bundle_id"]).update(
            derived_from_id=other["revision_id"]
        )
    with pytest.raises(DatabaseError), transaction.atomic():
        SourceBundle.objects.filter(id=source["bundle_id"]).update(
            role="derivative", derived_from_id=other["revision_id"]
        )


@pytest.mark.parametrize("legacy", [False, True])
def test_retained_result_closure_is_rechecked_on_replay(users, project, legacy):
    source = preserve(users, project, archive())
    result = op(users["editor"], "source.expand_zip", payload(source), idempotency_key="retained")
    if legacy:
        from specmate.operations.models import IdempotencyRecord

        IdempotencyRecord.objects.filter(operation="source.expand_zip", key="retained").update(
            scope="legacy"
        )
    other = op(users["outsider"], "project.create", {"name": "Hidden"})["project_id"]
    register(users["outsider"], other, b"hidden")
    SourceBundleFile.objects.create(
        revision_id=result["revision_id"],
        blob=SourceBlob.objects.get(project_id=other),
        path="hidden",
        rights="unknown",
        media_type="application/octet-stream",
    )
    for request_payload in [payload(source), {**payload(source), "name": "changed name"}]:
        with pytest.raises(NotFound):
            op(users["editor"], "source.expand_zip", request_payload, idempotency_key="retained")
    request = RequestFactory().get("/")
    request.user = users["editor"]
    with pytest.raises(NotFound):
        read_revision(request, result["revision_id"])


@pytest.mark.parametrize("tag", [0x0001, 0x756E, 0xFFFF])
def test_rejects_zip64_link_and_unknown_extra_fields(tag):
    info = zipfile.ZipInfo("file")
    info.extra = struct.pack("<HH", tag, 0)
    with pytest.raises(ValidationFailed):
        zip_intake.inspect_archive(archive([(info, b"data")]))


def test_large_valid_deflate_and_false_short_stream_are_verified(artifact_root):
    # A deterministic repeated 4 KiB pattern expands across many 64 KiB reads,
    # while staying below the independently fixed 200x ratio limit.
    import random

    content = random.Random(7).randbytes(4096) * 64  # noqa: S311 (deterministic fixture)
    result = zip_intake.stage_members(archive([("large", content)]))
    assert result[0][1].size == len(content)
    assert result[0][1].sha256 == sha(content)
    blobstore.discard(result[0][1])
    broken = patch_field(archive([("short", b"payload")]), 22, 24, 100, "I")
    with pytest.raises(ValidationFailed):
        zip_intake.stage_members(broken)
    assert list((artifact_root / "staging").iterdir()) == []


def test_sql_failure_rolls_back_expansion_rows_and_idempotency(users, project, monkeypatch):
    from specmate.operations.models import IdempotencyRecord
    from specmate.sources.models import SourceArchiveExpansion

    source = preserve(users, project, archive())

    def fail(*args, **kwargs):
        raise RuntimeError("Synthetic persistence failure")

    with monkeypatch.context() as patch:
        patch.setattr(SourceArchiveExpansion.objects, "create", fail)
        with pytest.raises(RuntimeError, match="Synthetic persistence failure"):
            op(users["editor"], "source.expand_zip", payload(source), idempotency_key="atomic")
    assert SourceBundle.objects.count() == SourceBundleRevision.objects.count() == 1
    assert SourceBlob.objects.count() == 1
    assert not IdempotencyRecord.objects.filter(operation="source.expand_zip").exists()
    assert (
        op(users["editor"], "source.expand_zip", payload(source), idempotency_key="atomic")[
            "member_count"
        ]
        == 1
    )


def test_lower_current_source_limit_applies_to_expansion(users, project, settings):
    source = preserve(users, project, archive([("member", b"a" * 1000)]))
    settings.SPECMATE_MAX_SOURCE_BYTES = 300
    with pytest.raises(ValidationFailed, match="configured source byte limit"):
        op(users["editor"], "source.expand_zip", payload(source))
    assert SourceBundle.objects.count() == 1


def test_db_rejects_expansion_with_cross_project_derivative(users, project):
    from django.db import transaction
    from django.db.utils import DatabaseError

    from specmate.sources.models import SourceArchiveExpansion

    source = preserve(users, project, archive())
    other = op(users["outsider"], "project.create", {"name": "Other project"})["project_id"]
    bundle = SourceBundle.objects.create(
        project_id=other,
        name="Mismatched scope",
        role="derivative",
        derived_from_id=source["revision_id"],
        created_by=users["outsider"],
    )
    revision = SourceBundleRevision.objects.create(
        bundle=bundle,
        number=1,
        manifest=b"{}",
        manifest_sha256=sha(b"{}"),
        created_by=users["outsider"],
    )
    with pytest.raises(DatabaseError), transaction.atomic():
        SourceArchiveExpansion.objects.create(
            revision=revision,
            archive_file=SourceBundleFile.objects.get(revision_id=source["revision_id"]),
            parser="specmate-classic-zip-v1",
        )


def test_source_integrity_failure_creates_no_derivative(users, project, monkeypatch):
    source = preserve(users, project, archive())
    monkeypatch.setattr(blobstore, "open_blob", lambda _: io.BytesIO(b"not the original"))
    with pytest.raises(ValidationFailed, match="integrity"):
        op(users["editor"], "source.expand_zip", payload(source))
    assert SourceBundle.objects.count() == 1
