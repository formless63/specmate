"""Bounded, standard-library-only verification of inert selected-package bytes.

This file can be obtained from a trusted Specmate checkout and run directly. Never
run a verifier, source file or other executable obtained from the package under review.
Hashes establish integrity relative to a separately retained manifest digest; they
provide neither publisher authentication nor engineering or rights qualification.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import re
import stat
import struct
import sys
import unicodedata
import zipfile
import zlib
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from uuid import UUID

MAX_BYTES = 16 * 1024 * 1024
MAX_ARCHIVE_BYTES = 20 * 1024 * 1024
MAX_FILES = 4000
MAX_REVISIONS = 2000
MAX_DEPTH = 64
FORMAT = "specmate.selected-assembly-package"
VERSION = "0.1"


@dataclass
class Verification:
    errors: list[str] = field(default_factory=list)
    limitations: list[str] = field(default_factory=list)
    manifest_identity: str = "not_verified"

    def result(self):
        return {
            "integrity": "failed" if self.errors else "verified",
            "completeness": (
                "not_verified"
                if self.errors
                else "limited"
                if self.limitations
                else "complete_declared_data"
            ),
            "errors": sorted(set(self.errors)),
            "limitations": sorted(set(self.limitations)),
            "manifest_identity": self.manifest_identity,
            "authenticity": "not_verified",
            "rights_certification": "not_evaluated",
            "physical_qualification": "not_evaluated",
        }


def _sha(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise ValueError("invalid digest")
    return value


def _uuid(value):
    if not isinstance(value, str) or str(UUID(value)) != value:
        raise ValueError("noncanonical identity")
    return value


def _path(value):
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 512
        or value != unicodedata.normalize("NFC", value)
        or any(ord(c) < 32 or c in '\\:*?"<>|' or ord(c) == 127 for c in value)
    ):
        raise ValueError("unsafe path")
    path = PurePosixPath(value)
    if path.is_absolute() or str(path) != value or any(p in ("", ".", "..") for p in path.parts):
        raise ValueError("unsafe path")
    return value


def _file_tree(paths):
    normalized = [_path(path).casefold() for path in paths]
    unique = set(normalized)
    if len(unique) != len(normalized):
        raise ValueError("duplicate or case-colliding paths")
    if any(str(parent) in unique for path in unique for parent in PurePosixPath(path).parents):
        raise ValueError("file/directory collision")


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _json(raw):
    # Bound nesting before invoking the recursive JSON parser, ignoring string contents.
    depth, quoted, escaped = 0, False, False
    for char in raw.decode("utf-8"):
        if quoted:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char in "[{":
            depth += 1
            if depth > MAX_DEPTH:
                raise ValueError("JSON nesting exceeds limit")
        elif char in "]}":
            depth -= 1
    return json.loads(
        raw, object_pairs_hook=_pairs, parse_constant=_invalid_constant, parse_float=_finite_float
    )


def _finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("nonfinite JSON number")
    return number


def _invalid_constant(_value):
    raise ValueError("nonfinite JSON number")


def _size(value):
    if type(value) is not int or not 0 <= value <= MAX_BYTES:
        raise ValueError("invalid byte count")
    return value


def _address(value):
    if not isinstance(value, list) or len(value) > 32:
        raise ValueError("invalid occurrence address")
    if any(not isinstance(x, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,79}", x) for x in value):
        raise ValueError("invalid occurrence identity")
    return tuple(value)


def _review(review, subject):
    if review["subject"] != subject or review["decision"] not in {
        "permitted",
        "unknown",
        "withheld",
    }:
        raise ValueError("contradictory rights subject")
    if not isinstance(review["basis"], str) or (
        review["decision"] != "unknown" and not review["basis"].strip()
    ):
        raise ValueError("missing rights basis")
    return review["decision"]


def _source_pins(value):
    """Check recognized inert file-pin shapes without loading native parsers or extensions."""
    if isinstance(value, dict):
        rid = value.get("source_bundle_revision_id")
        path = value.get("source_path")
        if not rid:
            rid = value.get("bundle_revision_id") or value.get("source_revision_id")
            path = value.get("path")
        if rid:
            # Typed firmware source groups carry their own exact manifest/file hashes.
            if "files" in value and "source_manifest_sha256" in value:
                for file in value["files"]:
                    yield rid, file["path"], file["sha256"], value["source_manifest_sha256"]
            else:
                yield rid, path, value.get("sha256"), value.get("source_manifest_sha256")
        for child in value.values():
            yield from _source_pins(child)
    elif isinstance(value, list):
        for child in value:
            yield from _source_pins(child)


def inspect_files(files, *, manifest_sha256=None):
    """Inspect already-read files. CLI/archive verification always requires an external hash.

    The optional hash retains the application helper API; callers omitting it verify
    internal consistency only and cannot detect coherent manifest replacement.
    """
    report = Verification()
    try:
        if len(files) > MAX_FILES or any(not isinstance(raw, bytes) for raw in files.values()):
            raise ValueError("invalid or excessive files")
        if sum(len(raw) for raw in files.values()) > MAX_BYTES:
            raise ValueError("package too large")
        _file_tree(files)
        raw = files["manifest.json"]
        if manifest_sha256 is not None and hashlib.sha256(raw).hexdigest() != _sha(manifest_sha256):
            report.errors.append("Manifest hash mismatch.")
        elif manifest_sha256 is not None:
            report.manifest_identity = "independently_matched"
        manifest = _json(raw)
        if manifest["format"] != FORMAT or manifest["schema_version"] != VERSION:
            report.errors.append("Unsupported package format or schema version.")
            return report
        entries = manifest["files"]
        _file_tree([entry["path"] for entry in entries] + ["manifest.json"])
        inventory = {entry["path"]: entry for entry in entries}
        if set(files) != set(inventory) | {"manifest.json"}:
            report.errors.append("Package file set differs from manifest.")
        for entry in entries:
            data = files.get(entry["path"])
            sha, size = _sha(entry["sha256"]), _size(entry["bytes"])
            if data is None:
                report.errors.append("Required file missing.")
            elif len(data) != size or hashlib.sha256(data).hexdigest() != sha:
                report.errors.append("File hash or byte count mismatch.")
        designs = manifest["design_revisions"]
        if not isinstance(designs, list) or not 1 <= len(designs) <= MAX_REVISIONS:
            raise ValueError("invalid design count")
        revisions = {}
        bodies = {}
        for entry in designs:
            rid = _uuid(entry["revision_id"])
            _uuid(entry["snapshot_id"])
            _uuid(entry["definition_id"])
            _sha(entry["sha256"])
            if rid in revisions or entry["path"] != f"designs/{rid}.json":
                raise ValueError("duplicate or contradictory design identity")
            revisions[rid] = entry
            decision = _review(entry["rights_review"], f"design:{rid}")
            if decision == "withheld":
                report.errors.append("Withheld design included.")
            if manifest["purpose"] == "distribution" and decision != "permitted":
                report.errors.append("Distribution design lacks explicit permission.")
            data = files.get(entry["path"])
            if data is None or hashlib.sha256(data).hexdigest() != entry["sha256"]:
                report.errors.append("Required design snapshot missing or changed.")
                continue
            if (
                entry["path"] not in inventory
                or inventory[entry["path"]]["sha256"] != entry["sha256"]
            ):
                report.errors.append("Design inventory pin mismatch.")
            body = _json(data)
            canonical = json.dumps(
                body, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
            ).encode()
            if (
                data != canonical
                or body["definition_id"] != entry["definition_id"]
                or body["kind"] != entry["kind"]
                or body["schema_version"] != VERSION
            ):
                report.errors.append("Design canonical identity mismatch.")
            bodies[rid] = body
        for body in bodies.values():
            seen = set()
            for pin in body["dependencies"]:
                rid = _uuid(pin["revision_id"])
                _sha(pin["sha256"])
                if rid in seen:
                    raise ValueError("duplicate dependency identity")
                seen.add(rid)
                dependency = revisions.get(rid)
                if dependency is None:
                    report.errors.append("Required design dependency not included.")
                elif dependency["sha256"] != pin["sha256"]:
                    report.errors.append("Exact dependency pin mismatch.")
        scope = manifest["scope"]
        for key in ("root_revision_id", "root_snapshot_id", "selected_revision_id"):
            _uuid(scope[key])
        for key in ("root_sha256", "selected_sha256"):
            _sha(scope[key])
        selected_path = _address(scope["occurrence_path"])
        selected = revisions.get(scope["selected_revision_id"])
        if selected is None or selected["sha256"] != scope["selected_sha256"]:
            report.errors.append("Selected scope pin missing or changed.")
        if not selected_path and (
            scope["root_revision_id"] != scope["selected_revision_id"]
            or scope["root_sha256"] != scope["selected_sha256"]
            or selected is None
            or scope["root_snapshot_id"] != selected["snapshot_id"]
        ):
            report.errors.append("Standalone root scope identity mismatch.")
        if not isinstance(manifest["occurrences"], list) or len(manifest["occurrences"]) > 10000:
            raise ValueError("invalid occurrence count")
        addresses = set()
        occurrence_pins = {}
        for row in manifest["occurrences"]:
            address = _address(row["path"])
            if address in addresses:
                raise ValueError("duplicate occurrence identity")
            addresses.add(address)
            rid = _uuid(row["revision_id"])
            occurrence_pins[address] = rid
            sha = _sha(row["sha256"])
            if rid not in revisions or revisions[rid]["sha256"] != sha:
                report.errors.append("Occurrence pin missing or changed.")
            if not address and (
                rid != scope["selected_revision_id"] or sha != scope["selected_sha256"]
            ):
                report.errors.append("Selected occurrence scope mismatch.")
            firmware = row["assignments"]["firmware_revision_id"]
            if firmware is not None:
                _uuid(firmware)
                if firmware not in revisions:
                    report.errors.append("Required contextual firmware missing.")
                elif revisions[firmware]["kind"] != "firmware":
                    report.errors.append("Contextual firmware kind mismatch.")
        if () not in addresses or any(path[:-1] not in addresses for path in addresses if path):
            report.errors.append("Occurrence root or parent missing.")
        children_by_parent = {}
        for address, rid in occurrence_pins.items():
            if address:
                children_by_parent.setdefault(address[:-1], {})[address[-1]] = rid
        for address, rid in occurrence_pins.items():
            body = bodies.get(rid)
            if body is None:
                continue
            assembly = body["content"].get("assembly")
            children = children_by_parent.get(address, {})
            if assembly is None:
                if children:
                    report.errors.append("Occurrences contradict canonical assembly structure.")
            else:
                if assembly["schema_version"] != VERSION:
                    raise ValueError("unsupported canonical assembly format")
                expected = {}
                for child in assembly["occurrences"]:
                    local = _address([child["local_id"]])[0]
                    if local in expected:
                        raise ValueError("duplicate canonical occurrence identity")
                    expected[local] = _uuid(child["revision_id"])
                if children != expected:
                    report.errors.append("Occurrences contradict canonical assembly structure.")
        if (
            not isinstance(manifest["source_files"], list)
            or len(manifest["source_files"]) > MAX_FILES
        ):
            raise ValueError("invalid source count")
        sources = {}
        for source in manifest["source_files"]:
            rid = _uuid(source["source_revision_id"])
            source_path = _path(source["source_path"])
            key = rid, source_path
            if key in sources:
                raise ValueError("duplicate source identity")
            sources[key] = source
            _sha(source["sha256"])
            _size(source["bytes"])
            _sha(source["manifest_sha256"])
            if not isinstance(source["ancestry"], list) or len(source["ancestry"]) > MAX_REVISIONS:
                raise ValueError("invalid source ancestry count")
            for key in ("media_type", "declared_rights"):
                if not isinstance(source[key], str) or not source[key]:
                    raise ValueError("invalid source declarations")
            ancestry = {}
            for ancestor in source["ancestry"]:
                aid = _uuid(ancestor["source_revision_id"])
                if aid in ancestry:
                    raise ValueError("duplicate ancestry identity")
                ancestry[aid] = _sha(ancestor["manifest_sha256"])
            if ancestry.get(rid) != source["manifest_sha256"]:
                report.errors.append("Source provenance identity mismatch.")
            decision = _review(source["rights_review"], f"source:{rid}:{source_path}")
            if source["path"] is None:
                if source["status"] != "omitted_pending_rights" or decision == "permitted":
                    raise ValueError("contradictory omitted source")
                report.limitations.append("Required source dependency not included.")
            else:
                if (
                    source["path"] != f"sources/{rid}/{source_path}"
                    or source["status"] != "included_inert"
                    or decision != "permitted"
                ):
                    raise ValueError("contradictory included source")
                data = files.get(source["path"])
                entry = inventory.get(source["path"])
                if (
                    data is None
                    or len(data) != source["bytes"]
                    or hashlib.sha256(data).hexdigest() != source["sha256"]
                ):
                    report.errors.append("Required source bytes missing or changed.")
                if (
                    entry is None
                    or entry["sha256"] != source["sha256"]
                    or entry["bytes"] != source["bytes"]
                ):
                    report.errors.append("Source inventory pin mismatch.")
        expected_paths = {"README.txt", "review.html"} | {e["path"] for e in designs}
        expected_paths |= {s["path"] for s in sources.values() if s["path"] is not None}
        if set(inventory) != expected_paths:
            report.errors.append("File inventory differs from declared design/source closure.")
        for body in bodies.values():
            for rid, path, sha, manifest_sha in _source_pins(body["content"]):
                _uuid(rid)
                if path is None:
                    report.limitations.append("Declared package limitations remain unresolved.")
                    continue
                source = sources.get((rid, _path(path)))
                if source is None:
                    report.errors.append("Required source pin not included.")
                elif (sha is not None and source["sha256"] != _sha(sha)) or (
                    manifest_sha is not None and source["manifest_sha256"] != _sha(manifest_sha)
                ):
                    report.errors.append("Exact source pin mismatch.")
        if not isinstance(manifest["unresolved"], list):
            raise ValueError("invalid unresolved records")
        if manifest["unresolved"]:
            report.limitations.append("Declared package limitations remain unresolved.")
        if manifest["completeness"] not in {"limited", "complete_declared_data"}:
            raise ValueError("invalid completeness")
        if (manifest["completeness"] == "limited") != bool(report.limitations):
            report.errors.append("Package completeness contradicts unresolved dependencies.")
        if manifest["purpose"] not in {"authorized_review", "distribution"}:
            raise ValueError("invalid purpose")
        if manifest["purpose"] == "distribution" and report.limitations:
            report.errors.append("Distribution package has unresolved dependencies.")
        # Require the declared boundary sections; no discipline-specific qualification is inferred.
        for key in ("relationships", "boundary_interfaces", "boundary_crossings"):
            if not isinstance(manifest[key], list):
                raise ValueError("invalid boundary declarations")
    except (
        KeyError,
        TypeError,
        ValueError,
        UnicodeError,
        AttributeError,
        RecursionError,
        OverflowError,
    ):
        report.errors.append("Malformed package manifest or canonical file.")
    return report


def verify_files(files, *, manifest_sha256=None):
    """Compatibility helper returning both integrity failures and declared limitations."""
    report = inspect_files(files, manifest_sha256=manifest_sha256)
    return sorted(set(report.errors + report.limitations))


def verify_archive(archive, *, manifest_sha256):
    """Read a bounded ZIP without extraction, execution, network access or native parsing."""
    report = Verification()
    try:
        _sha(manifest_sha256)
        if not isinstance(archive, bytes) or len(archive) > MAX_ARCHIVE_BYTES:
            raise ValueError("archive exceeds limit")
        # Reject excessive central-directory counts before ZipFile allocates entry objects.
        end = archive.rfind(b"PK\x05\x06", max(0, len(archive) - 65557))
        if end < 0 or end + 22 > len(archive):
            raise ValueError("missing ZIP end")
        _, disk, start_disk, disk_count, count, size, offset, comment = struct.unpack_from(
            "<4s4H2LH", archive, end
        )
        if (
            disk
            or start_disk
            or disk_count != count
            or not 1 <= count <= MAX_FILES
            or size > 4 * 1024 * 1024
            or offset + size != end
            or end + 22 + comment != len(archive)
        ):
            raise ValueError("unsupported ZIP directory")
        with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
            infos = zipped.infolist()
            if len(infos) != count:
                raise ValueError("ZIP count mismatch")
            _file_tree([info.orig_filename for info in infos])
            total = 0
            for info in infos:
                mode = stat.S_IFMT(info.external_attr >> 16)
                if (
                    info.filename != info.orig_filename
                    or info.is_dir()
                    or info.flag_bits & (1 | 64)
                    or info.external_attr & 16
                    or mode not in {0, stat.S_IFREG}
                    or info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
                ):
                    raise ValueError("unsafe or unsupported ZIP entry")
                total += _size(info.file_size)
                if total > MAX_BYTES:
                    raise ValueError("uncompressed size exceeds limit")
            files = {}
            for info in infos:
                with zipped.open(info) as stream:
                    raw = stream.read(info.file_size + 1)
                    if len(raw) != info.file_size:
                        raise ValueError("ZIP byte count mismatch")
                    files[info.filename] = raw
        return inspect_files(files, manifest_sha256=manifest_sha256)
    except (
        OSError,
        ValueError,
        TypeError,
        struct.error,
        zipfile.BadZipFile,
        NotImplementedError,
        RuntimeError,
        EOFError,
        zlib.error,
    ):
        report.errors.append("Unsafe, malformed, unsupported or oversized ZIP package.")
        return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path, help="Selected-package ZIP (never extracted)")
    parser.add_argument(
        "--manifest-sha256",
        required=True,
        help="Manifest SHA-256 independently retained from authorized review",
    )
    args = parser.parse_args(argv)
    try:
        with args.package.open("rb") as stream:
            archive = stream.read(MAX_ARCHIVE_BYTES + 1)
        result = verify_archive(archive, manifest_sha256=args.manifest_sha256)
    except OSError:
        result = Verification(errors=["Package could not be read."])
    print(json.dumps(result.result(), sort_keys=True))
    return 1 if result.errors else 2 if result.limitations else 0


if __name__ == "__main__":
    sys.exit(main())
