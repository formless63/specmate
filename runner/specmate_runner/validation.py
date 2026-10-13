"""Defence-in-depth validation of an application-approved execution manifest."""

import hashlib
import math
import os
import re
import stat
from pathlib import PurePosixPath

MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_INPUT_BYTES = 256 * 1024 * 1024
MAX_FILES = 512
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
IMAGE = re.compile(r"(?:[a-z0-9][a-z0-9._:/-]*@)?sha256:[0-9a-f]{64}\Z")


class Invalid(ValueError):
    """Unusable or unsafe manifest/output."""


def safe_path(value):
    if not isinstance(value, str) or not value or len(value) > 512:
        raise Invalid("Invalid relative path")
    if any(ord(char) < 32 for char in value) or "\\" in value or ":" in value:
        raise Invalid("Invalid relative path")
    parts = value.split("/")
    if (
        any(part in {"", ".", ".."} for part in parts)
        or PurePosixPath(value).is_absolute()
    ):
        raise Invalid("Unsafe relative path")
    return value


def bounded(value, minimum, maximum):
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or not minimum <= value <= maximum
    ):
        raise Invalid("Invalid resource bound")
    return value


def file_paths(items):
    if not isinstance(items, list) or len(items) > MAX_FILES:
        raise Invalid("Invalid file count")
    paths = set()
    for item in items:
        path = safe_path(item["path"])
        if path in paths:
            raise Invalid("Duplicate file path")
        paths.add(path)
        for field in ("rights", "media_type"):
            if (
                not isinstance(item[field], str)
                or not item[field]
                or len(item[field]) > 256
            ):
                raise Invalid("Missing file declaration")
    for path in paths:
        if any(str(parent) in paths for parent in PurePosixPath(path).parents):
            raise Invalid("File/directory path collision")


def validate_identity(lease):
    try:
        for key in ("stage_id", "build_id", "source_revision_id"):
            if not isinstance(lease[key], str) or not re.fullmatch(
                r"[A-Za-z0-9_-]{1,128}", lease[key]
            ):
                raise Invalid("Invalid lease identity")
        if not isinstance(lease["fencing_token"], (str, int)) or isinstance(
            lease["fencing_token"], bool
        ):
            raise Invalid("Invalid fencing token")
        if not 1 <= len(str(lease["fencing_token"])) <= 256:
            raise Invalid("Invalid fencing token")
    except (KeyError, TypeError) as exc:
        raise Invalid("Malformed lease identity") from exc
    return lease


def validate_manifest(lease):
    validate_identity(lease)
    try:
        recipe = lease["recipe"]
        if not IMAGE.fullmatch(recipe["image"]) or recipe["image"].endswith("0" * 64):
            raise Invalid("Executable image must use a nonzero digest")
        if not isinstance(recipe["id"], str) or not recipe["id"]:
            raise Invalid("Recipe identity required")
        if recipe.get("network") != "none":
            raise Invalid("This runner only supports denied network access")
        if (
            recipe.get("input_mount") != "/inputs"
            or recipe.get("output_mount") != "/outputs"
        ):
            raise Invalid("Unexpected tool mounts")
        argv = recipe["argv"]
        if (
            not isinstance(argv, list)
            or not 1 <= len(argv) <= 128
            or any(
                not isinstance(arg, str) or "\x00" in arg or len(arg) > 8192
                for arg in argv
            )
            or not argv[0].startswith("/")
        ):
            raise Invalid("Recipe requires an explicit executable argument vector")
        limits = recipe["limits"]
        bounded(limits["cpus"], 0.1, 32)
        for key, lower, upper in (
            ("memory_bytes", 16 * 1024 * 1024, 64 * 1024**3),
            ("timeout_seconds", 1, 86400),
            ("pids", 1, 1024),
            ("max_output_bytes", 1, MAX_FILE_BYTES),
        ):
            bounded(limits[key], lower, upper)
            if not isinstance(limits[key], int):
                raise Invalid("Resource bound must be an integer")
        file_paths(lease["inputs"])
        file_paths(recipe["outputs"])
        total = 0
        for item in lease["inputs"]:
            bounded(item["bytes"], 0, MAX_FILE_BYTES)
            if not isinstance(item["bytes"], int) or not SHA256.fullmatch(
                item["sha256"]
            ):
                raise Invalid("Invalid input size or digest")
            total += item["bytes"]
        if total > MAX_INPUT_BYTES:
            raise Invalid("Input bundle exceeds runner limit")
    except (KeyError, TypeError, AttributeError) as exc:
        raise Invalid("Malformed execution manifest") from exc
    return lease


def hash_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as content:
        for block in iter(lambda: content.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def inspect_outputs(root, declarations, maximum, *, complete):
    """Called while running for bounds and after confirmed stop for registration."""
    expected = {item["path"]: item for item in declarations}
    found = {}
    count, size = 0, 0
    for directory, subdirs, files in os.walk(root, followlinks=False):
        for name in subdirs + files:
            path = root / (os.path.relpath(directory, root)) / name
            info = path.lstat()
            count += 1
            if count > MAX_FILES * 4:
                raise Invalid("Too many output entries")
            relative = path.relative_to(root).as_posix()
            safe_path(relative)
            if len(PurePosixPath(relative).parts) > 32:
                raise Invalid("Output directory nesting exceeds limit")
            if stat.S_ISDIR(info.st_mode):
                continue
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise Invalid("Output links and special files are forbidden")
            if relative not in expected:
                raise Invalid("Undeclared output")
            size += info.st_size
            if size > maximum:
                raise Invalid("Outputs exceed byte limit")
            if complete:
                found[relative] = {
                    **expected[relative],
                    "bytes": info.st_size,
                    "sha256": hash_file(path),
                }
    if complete and set(found) != set(expected):
        raise Invalid("Declared output missing")
    return list(found.values())
