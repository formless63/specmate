"""Content-addressed, application-owned blob storage on the filesystem.

Bytes are streamed to a staging file while hashing, verified against the declared
hash and size, then promoted. Promotion happens before the database commit, so a
committed reference never points at missing bytes; an aborted transaction can leave
an unreferenced blob for bounded reconciliation, never a dangling reference.
Storage identity (the hash) is not authority: access is decided by database records.
"""

from __future__ import annotations

import hashlib
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import IO

from django.conf import settings

CHUNK = 1024 * 1024


@dataclass(frozen=True)
class Staged:
    path: Path
    sha256: str
    size: int


class TooLarge(Exception):
    pass


def root() -> Path:
    return Path(settings.SPECMATE_ARTIFACT_ROOT)


def blob_path(sha256: str) -> Path:
    return root() / "blobs" / "sha256" / sha256[:2] / sha256[2:4] / sha256


def stage(stream: IO[bytes], max_bytes: int) -> Staged:
    staging = root() / "staging"
    staging.mkdir(parents=True, exist_ok=True, mode=0o700)
    digest = hashlib.sha256()
    size = 0
    fd, name = tempfile.mkstemp(dir=staging, prefix="upload-")
    path = Path(name)
    try:
        with os.fdopen(fd, "wb") as out:
            while chunk := stream.read(CHUNK):
                size += len(chunk)
                if size > max_bytes:
                    raise TooLarge
                digest.update(chunk)
                out.write(chunk)
            out.flush()
            os.fsync(out.fileno())
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return Staged(path, digest.hexdigest(), size)


def discard(staged: Staged) -> None:
    staged.path.unlink(missing_ok=True)


def promote(staged: Staged) -> Path:
    target = blob_path(staged.sha256)
    if target.exists():
        if target.stat().st_size != staged.size:
            discard(staged)
            raise OSError("Stored blob does not match its content address.")
        discard(staged)
        return target
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    staged.path.chmod(0o444)
    os.replace(staged.path, target)
    return target


def open_blob(sha256: str) -> IO[bytes]:
    return blob_path(sha256).open("rb")
