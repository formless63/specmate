"""Bounded, deliberately narrow ZIP parsing; member paths are never host paths.

Classic ZIP with stored/deflated entries only. No execution, nested expansion,
filesystem extraction, permissions restoration, ZIP64 or data descriptors.
"""

from __future__ import annotations

import binascii
import io
import stat
import struct
import zlib
from dataclasses import dataclass

from specmate.contracts import check_file_tree, check_package_path
from specmate.operations import ValidationFailed
from specmate.sources import blobstore

MAX_ARCHIVE = 16 * 1024 * 1024
MAX_DIRECTORY = 1024 * 1024
MAX_ENTRIES = 1000
MAX_MEMBER = 16 * 1024 * 1024
MAX_EXPANDED = 64 * 1024 * 1024
MAX_RATIO = 200
CHUNK = 64 * 1024


@dataclass(frozen=True)
class Member:
    path: str
    size: int
    compressed_size: int
    crc: int
    method: int
    start: int
    directory: bool


def reject(reason="The ZIP structure, member paths, metadata or integrity is unsupported."):
    raise ValidationFailed(
        "Unsupported or unsafe ZIP archive; no expanded bundle was created. " + reason
    )


def _extra(value: bytes):
    # Only inert timestamps and uid/gid metadata; never restore them. Reject
    # ZIP64, Unix link metadata and unrecognized extension semantics.
    while value:
        if len(value) < 4:
            reject()
        tag, size = struct.unpack_from("<HH", value)
        if tag not in {0x5455, 0x000A, 0x7875} or size > len(value) - 4:
            reject("ZIP64, link and unrecognized metadata extensions are unsupported.")
        value = value[4 + size :]


def inspect_archive(data: bytes) -> list[Member]:
    if len(data) > MAX_ARCHIVE:
        reject("The archive exceeds the 16 MiB input limit.")
    end = data.rfind(b"PK\x05\x06", max(0, len(data) - 65557))
    if end < 0 or end + 22 > len(data):
        reject()
    disk, directory_disk, disk_count, count, size, offset, comment = struct.unpack_from(
        "<4H2IH", data, end + 4
    )
    if (
        disk
        or directory_disk
        or disk_count != count
        or not 0 < count <= MAX_ENTRIES
        or size > MAX_DIRECTORY
        or offset + size != end
        or end + 22 + comment != len(data)
    ):
        reject()
    cursor = offset
    members = []
    intervals = []
    names = set()
    directories = set()
    expanded = 0
    for _ in range(count):
        if cursor + 46 > end or data[cursor : cursor + 4] != b"PK\x01\x02":
            reject()
        values = struct.unpack_from("<6H3I5H2I", data, cursor + 4)
        made, needed, flags, method, _, _, crc, compressed, raw_size = values[:9]
        name_size, extra_size, comment_size, start_disk, _, attrs, local = values[9:]
        next_cursor = cursor + 46 + name_size + extra_size + comment_size
        if (
            next_cursor > end
            or start_disk
            or raw_size > MAX_MEMBER
            or raw_size > max(1, compressed) * MAX_RATIO
        ):
            reject()
        if (
            made >> 8 not in {0, 3}
            or attrs & 0xFFFF & ~0x37
            or needed > 20
            or flags & ~0x800
            or method not in {0, 8}
        ):
            reject("Use classic stored/deflated ZIP without encryption, data descriptors or ZIP64.")
        raw_name = data[cursor + 46 : cursor + 46 + name_size]
        try:
            name = raw_name.decode("utf-8" if flags & 0x800 else "cp437")
            directory = name.endswith("/")
            path = check_package_path(name[:-1] if directory else name)
        except (UnicodeError, ValueError):
            reject()
        normalized = path.casefold()
        if normalized in names:
            reject()
        names.add(normalized)
        mode = stat.S_IFMT(attrs >> 16)
        if mode not in {0, stat.S_IFREG, stat.S_IFDIR}:
            reject()
        if bool(mode == stat.S_IFDIR or attrs & 0x10) != directory:
            # A trailing slash may be the sole directory marker in DOS archives.
            if not (directory and mode == 0 and not attrs & 0x10):
                reject()
        if directory:
            directories.add(normalized)
            if raw_size or crc:
                reject()
        _extra(data[cursor + 46 + name_size : cursor + 46 + name_size + extra_size])
        if local + 30 > offset or data[local : local + 4] != b"PK\x03\x04":
            reject()
        local_values = struct.unpack_from("<5H3I2H", data, local + 4)
        ln, lf, lm, _, _, lc, lz, ls, lnames, lextra = local_values
        start = local + 30 + lnames + lextra
        if (
            (ln, lf, lm, lc, lz, ls) != (needed, flags, method, crc, compressed, raw_size)
            or start + compressed > offset
            or data[local + 30 : local + 30 + lnames] != raw_name
        ):
            reject()
        _extra(data[local + 30 + lnames : start])
        intervals.append((local, start + compressed))
        members.append(Member(path, raw_size, compressed, crc, method, start, directory))
        expanded += raw_size
        if expanded > MAX_EXPANDED:
            reject()
        cursor = next_cursor
    if cursor != end:
        reject()
    # Reject prepended executables, hidden local entries, overlap and unexplained gaps.
    position = 0
    for start, stop in sorted(intervals):
        if start != position:
            reject()
        position = stop
    if position != offset:
        reject()
    files = [m.path for m in members if not m.directory]
    if not files:
        reject()
    try:
        check_file_tree(files, max_depth=32)
        # Explicit directory records can also collide with a file ancestor.
        file_names = {name.casefold() for name in files}
        for directory in directories:
            parts = directory.split("/")
            if any("/".join(parts[:i]) in file_names for i in range(1, len(parts) + 1)):
                reject()
    except ValueError:
        reject()
    return members


class MemberStream:
    """Bound every decompressor allocation and verify actual length, EOF and CRC."""

    def __init__(self, data: bytes, member: Member):
        self.source = io.BytesIO(data[member.start : member.start + member.compressed_size])
        self.member = member
        self.decoder = zlib.decompressobj(-15) if member.method == 8 else None
        self.pending = b""
        self.size = 0
        self.crc = 0
        self.finished = False

    def read(self, requested: int) -> bytes:
        if self.finished:
            return b""
        limit = min(requested, CHUNK, self.member.size - self.size + 1)
        try:
            if self.decoder:
                while True:
                    compressed = self.pending or self.source.read(CHUNK)
                    chunk = self.decoder.decompress(compressed, limit)
                    self.pending = self.decoder.unconsumed_tail
                    if self.decoder.unused_data:
                        reject()
                    if chunk or not compressed:
                        break
            else:
                chunk = self.source.read(limit)
        except zlib.error:
            reject()
        self.size += len(chunk)
        self.crc = binascii.crc32(chunk, self.crc)
        if self.size > self.member.size:
            reject()
        if not chunk:
            if self.size != self.member.size or self.crc != self.member.crc:
                reject()
            if self.decoder and not self.decoder.eof:
                reject()
            self.finished = True
        return chunk


def stage_members(
    data: bytes, max_member_bytes: int = MAX_MEMBER
) -> list[tuple[Member, blobstore.Staged]]:
    members = inspect_archive(data)
    if any(member.size > max_member_bytes for member in members):
        reject("An expanded member exceeds the configured source byte limit.")
    staged = []
    try:
        for member in members:
            item = blobstore.stage(MemberStream(data, member), member.size)
            if member.directory:
                blobstore.discard(item)
            else:
                staged.append((member, item))
        return staged
    except BaseException:
        for _, item in staged:
            blobstore.discard(item)
        raise
