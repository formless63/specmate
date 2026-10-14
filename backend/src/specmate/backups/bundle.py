"""Backup bundle format: one POSIX tar stream with a hashed manifest.

This module uses only the Python standard library and never imports Django, so an
operator can verify a bundle and recover its installation configuration on a host that
has no running installation yet::

    PYTHONPATH=backend/src python3 -m specmate.backups.bundle verify --input bundle.tar
    PYTHONPATH=backend/src python3 -m specmate.backups.bundle extract-config \
        --input bundle.tar --output-dir <new-stack-directory>

Members are never extracted by name. Every member must match a fixed allowlist, is
copied to a path this module computes, and is hashed while it is copied. The manifest
lists the SHA-256 and size of every other member; a bundle with a missing, extra,
altered or duplicated member is rejected before anything is restored.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import sys
import tarfile
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Any

FORMAT = "specmate-backup/1"
CHUNK = 1024 * 1024

DUMP = "database/specmate.pgdump"
RECIPES = "config/approved-recipes.json"
SECRETS = "secrets/installation.env"
MANIFEST = "manifest.json"
MANIFEST_DIGEST = "manifest.json.sha256"
BLOB = re.compile(r"^blobs/sha256/([0-9a-f]{2})/([0-9a-f]{2})/([0-9a-f]{64})$")
FIXED = frozenset({DUMP, RECIPES, SECRETS, MANIFEST, MANIFEST_DIGEST})
MAX_MANIFEST_BYTES = 64 * 1024 * 1024


class BundleError(Exception):
    """The bundle is incomplete, altered or not a Specmate backup."""


def blob_member(sha256: str) -> str:
    return f"blobs/sha256/{sha256[:2]}/{sha256[2:4]}/{sha256}"


def _allowed(name: str) -> bool:
    if name in FIXED:
        return True
    match = BLOB.match(name)
    return bool(match) and match.group(3).startswith(match.group(1) + match.group(2))


class _Hashing(io.RawIOBase):
    """Read-through wrapper that hashes exactly the bytes handed to the tar writer."""

    def __init__(self, stream: IO[bytes]):
        self.stream = stream
        self.digest = hashlib.sha256()
        self.size = 0

    def readable(self) -> bool:
        return True

    def read(self, size: int = -1) -> bytes:
        data = self.stream.read(size)
        self.digest.update(data)
        self.size += len(data)
        return data


@dataclass(frozen=True)
class Entry:
    path: str
    sha256: str
    size: int

    def as_dict(self) -> dict[str, Any]:
        return {"path": self.path, "sha256": self.sha256, "size": self.size}


class BundleWriter:
    """Streams members into a tar archive; the manifest is written last."""

    def __init__(self, output: IO[bytes]):
        self._tar = tarfile.open(fileobj=output, mode="w|", format=tarfile.PAX_FORMAT)
        self._entries: dict[str, Entry] = {}
        self._mtime = int(time.time())

    def _info(self, name: str, size: int) -> tarfile.TarInfo:
        if not _allowed(name) or name in self._entries or name in {MANIFEST, MANIFEST_DIGEST}:
            raise BundleError(f"Refusing bundle member {name!r}.")
        info = tarfile.TarInfo(name)
        info.size = size
        info.mode = 0o600
        info.mtime = self._mtime
        return info

    def add_file(self, name: str, path: Path, *, expected_sha256: str | None = None) -> Entry:
        with path.open("rb") as stream:
            size = os.fstat(stream.fileno()).st_size
            hashing = _Hashing(stream)
            self._tar.addfile(self._info(name, size), hashing)
        entry = Entry(name, hashing.digest.hexdigest(), hashing.size)
        if entry.size != size:
            raise BundleError(f"{name} changed size while it was copied.")
        if expected_sha256 is not None and entry.sha256 != expected_sha256:
            raise BundleError(f"{name} does not match its content address.")
        self._entries[name] = entry
        return entry

    def add_bytes(self, name: str, data: bytes) -> Entry:
        self._tar.addfile(self._info(name, len(data)), io.BytesIO(data))
        entry = Entry(name, hashlib.sha256(data).hexdigest(), len(data))
        self._entries[name] = entry
        return entry

    def finish(self, manifest: dict[str, Any]) -> dict[str, Any]:
        manifest = {
            **manifest,
            "format": FORMAT,
            "files": [e.as_dict() for e in sorted(self._entries.values(), key=lambda e: e.path)],
        }
        data = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
        for name, payload in (
            (MANIFEST, data),
            (MANIFEST_DIGEST, f"{hashlib.sha256(data).hexdigest()}  {MANIFEST}\n".encode()),
        ):
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            info.mode = 0o600
            info.mtime = self._mtime
            self._tar.addfile(info, io.BytesIO(payload))
        self._tar.close()
        return manifest


@dataclass(frozen=True)
class Verified:
    """A fully verified bundle copied into ``root``; paths are relative member names."""

    root: Path
    manifest: dict[str, Any]
    manifest_sha256: str

    def path(self, member: str) -> Path:
        return self.root / member

    def blobs(self) -> list[Entry]:
        return [
            Entry(f["path"], f["sha256"], f["size"])
            for f in self.manifest["files"]
            if f["path"].startswith("blobs/")
        ]

    def has(self, member: str) -> bool:
        return any(f["path"] == member for f in self.manifest["files"])


def read_bundle(stream: IO[bytes], staging: Path) -> Verified:
    """Copy and verify every member into ``staging`` (which must be empty)."""
    staging.mkdir(parents=True, exist_ok=True, mode=0o700)
    if any(staging.iterdir()):
        raise BundleError("The staging directory must be empty.")
    seen: dict[str, Entry] = {}
    try:
        archive = tarfile.open(fileobj=stream, mode="r|*")
    except tarfile.TarError as exc:
        raise BundleError("Input is not a readable backup archive.") from exc
    try:
        for member in archive:
            name = member.name
            if not member.isreg() or not _allowed(name):
                raise BundleError(f"Unexpected bundle member {name!r}.")
            if name in seen:
                raise BundleError(f"Duplicated bundle member {name!r}.")
            if name in {MANIFEST, MANIFEST_DIGEST} and member.size > MAX_MANIFEST_BYTES:
                raise BundleError("Bundle manifest is implausibly large.")
            source = archive.extractfile(member)
            if source is None:
                raise BundleError(f"Unreadable bundle member {name!r}.")
            target = staging / name
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            digest = hashlib.sha256()
            size = 0
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as out:
                while chunk := source.read(CHUNK):
                    digest.update(chunk)
                    size += len(chunk)
                    out.write(chunk)
                out.flush()
                os.fsync(out.fileno())
            seen[name] = Entry(name, digest.hexdigest(), size)
    except tarfile.TarError as exc:
        raise BundleError("The backup archive is truncated or damaged.") from exc
    finally:
        archive.close()
    return _verify(staging, seen)


def _verify(staging: Path, seen: dict[str, Entry]) -> Verified:
    if MANIFEST not in seen or MANIFEST_DIGEST not in seen:
        raise BundleError("The bundle has no manifest; it is incomplete.")
    data = (staging / MANIFEST).read_bytes()
    recorded = (staging / MANIFEST_DIGEST).read_text().split()
    manifest_sha256 = hashlib.sha256(data).hexdigest()
    if not recorded or recorded[0] != manifest_sha256:
        raise BundleError("The manifest does not match its recorded digest.")
    try:
        manifest = json.loads(data)
    except ValueError as exc:
        raise BundleError("The manifest is not valid JSON.") from exc
    if not isinstance(manifest, dict) or manifest.get("format") != FORMAT:
        raise BundleError("Unsupported or missing backup format.")
    listed: dict[str, Entry] = {}
    for item in manifest.get("files", []):
        entry = Entry(str(item["path"]), str(item["sha256"]), int(item["size"]))
        if entry.path in listed or not _allowed(entry.path):
            raise BundleError(f"Manifest lists an invalid member {entry.path!r}.")
        listed[entry.path] = entry
    actual = {k: v for k, v in seen.items() if k not in {MANIFEST, MANIFEST_DIGEST}}
    if set(actual) != set(listed):
        missing = sorted(set(listed) - set(actual))[:5]
        extra = sorted(set(actual) - set(listed))[:5]
        raise BundleError(
            f"Bundle members differ from the manifest (missing {missing}, unlisted {extra})."
        )
    for name, entry in listed.items():
        if actual[name] != entry:
            raise BundleError(f"{name} does not match the manifest hash or size.")
        match = BLOB.match(name)
        if match and match.group(3) != entry.sha256:
            raise BundleError(f"{name} does not match its content address.")
    if DUMP not in listed:
        raise BundleError("The bundle contains no application database dump.")
    return Verified(staging, manifest, manifest_sha256)


# ---- host-side command line (stdlib only) ------------------------------------------------


def _open_input(value: str):
    return sys.stdin.buffer if value == "-" else open(value, "rb")


def summary(verified: Verified) -> dict[str, Any]:
    m = verified.manifest
    return {
        "verified": True,
        "backup_id": m.get("backup_id"),
        "created_at": m.get("created_at"),
        "installation_id": m.get("installation_id"),
        "manifest_sha256": verified.manifest_sha256,
        "files": len(m["files"]),
        "blobs": len(verified.blobs()),
        "secrets_included": verified.has(SECRETS),
        "recipes_included": verified.has(RECIPES),
    }


def _write_exclusive(path: Path, data: bytes, mode: int) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, "wb") as out:
        out.write(data)
    path.chmod(mode)


def extract_config(verified: Verified, output_dir: Path) -> dict[str, Any]:
    """Recover installation secrets and the recipe registry for a new environment.

    The live registry starts empty, so a restored installation cannot run native tools
    until the operator re-approves recipes. Existing files are never overwritten.
    """
    if not verified.has(SECRETS):
        raise BundleError("This bundle was created without installation secrets.")
    output_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    written = []
    env = output_dir / ".env"
    _write_exclusive(env, verified.path(SECRETS).read_bytes(), 0o600)
    written.append(env.name)
    if verified.has(RECIPES):
        restored = output_dir / "recipes.restored.json"
        _write_exclusive(restored, verified.path(RECIPES).read_bytes(), 0o644)
        written.append(restored.name)
    live = output_dir / "recipes.json"
    if not live.exists():
        _write_exclusive(live, b"{}\n", 0o644)
        written.append(live.name)
    tools = output_dir / "tools-enabled.json"
    if not tools.exists():
        _write_exclusive(tools, b'{"format_version": 1, "enabled": {}}\n', 0o644)
        written.append(tools.name)
    # A pre-existing, non-empty live registry is reported, never silently replaced.
    return {"written": written, "live_registry_empty": live.read_text().strip() == "{}"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify a Specmate backup bundle.")
    sub = parser.add_subparsers(dest="action", required=True)
    for name in ("verify", "extract-config"):
        p = sub.add_parser(name)
        p.add_argument("--input", required=True, help="Bundle path, or - for standard input.")
        p.add_argument("--staging", help="Empty working directory (default: a new temporary).")
        if name == "extract-config":
            p.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args(argv)
    with tempfile.TemporaryDirectory(dir=args.staging) as tmp:
        try:
            with _open_input(args.input) as stream:
                verified = read_bundle(stream, Path(tmp) / "bundle")
            result: dict[str, Any] = summary(verified)
            if args.action == "extract-config":
                result["config"] = extract_config(verified, args.output_dir)
        except (BundleError, FileExistsError) as exc:
            print(json.dumps({"verified": False, "error": str(exc)}), file=sys.stderr)
            return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
