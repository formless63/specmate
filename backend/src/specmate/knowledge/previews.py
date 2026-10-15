"""Read-only, bounded attachment previews. Original bytes and ownership never change."""

import base64
import binascii
import hashlib
import struct
import zlib
from pathlib import PurePosixPath

from specmate.access.permissions import Perm
from specmate.catalog_matching.queries import current_actor
from specmate.knowledge.queries import attachment_result, get_item
from specmate.knowledge.search_contracts import PreviewAttachment
from specmate.operations import Context, NotFound, ValidationFailed, operation
from specmate.sources import blobstore
from specmate.sources.zip_intake import MemberStream, inspect_archive

MAX_PREVIEW_BYTES = 2 * 1024 * 1024
MAX_TEXT_BYTES = 128 * 1024
MAX_PIXELS = 1024 * 1024
MAX_ZIP_BYTES = 8 * 1024 * 1024
MAX_ZIP_MEMBERS = 100
PNG = b"\x89PNG\r\n\x1a\n"


def _chunk(kind, data):
    return (
        struct.pack(">I", len(data)) + kind + data + struct.pack(">I", binascii.crc32(kind + data))
    )


def normalized_png(data):
    """Only bounded noninterlaced 8-bit grayscale/RGB(A); strip all ancillary metadata.

    Validate every chunk and the complete bounded pixel stream before giving a browser
    a fresh minimal PNG. No profiles, text, animation or external-reference metadata survives.
    """
    if not data.startswith(PNG):
        raise ValueError
    at, chunks, header, compressed, ended = 8, 0, None, bytearray(), False
    seen_data, data_ended = False, False
    while at < len(data):
        if len(data) - at < 12 or ended or chunks >= 1000:
            raise ValueError
        size = struct.unpack(">I", data[at : at + 4])[0]
        kind = data[at + 4 : at + 8]
        end = at + size + 12
        if (
            end > len(data)
            or not all(65 <= c <= 90 or 97 <= c <= 122 for c in kind)
            or kind[2] & 32
        ):
            raise ValueError
        body = data[at + 8 : end - 4]
        if binascii.crc32(kind + body) != struct.unpack(">I", data[end - 4 : end])[0]:
            raise ValueError
        if kind == b"IHDR":
            if chunks or size != 13:
                raise ValueError
            header = body
        elif header is None:
            raise ValueError
        elif kind == b"IDAT":
            if data_ended:
                raise ValueError
            seen_data = True
            compressed.extend(body)
        elif kind == b"IEND":
            if size or not seen_data:
                raise ValueError
            ended = True
        else:
            if seen_data:
                data_ended = True
            # Unknown critical data, animation and keyed transparency are unsupported.
            # Dropping tRNS would change pixel transparency, not just metadata.
            if not kind[0] & 32 or kind in (b"acTL", b"fcTL", b"fdAT", b"tRNS"):
                raise ValueError
        chunks += 1
        at = end
    if not ended or header is None:
        raise ValueError
    width, height, depth, color, compression, filtering, interlace = struct.unpack(
        ">IIBBBBB", header
    )
    channels = {0: 1, 2: 3, 4: 2, 6: 4}.get(color)
    if (
        not channels
        or depth != 8
        or compression
        or filtering
        or interlace
        or not 0 < width <= 2048
        or not 0 < height <= 2048
        or width * height > MAX_PIXELS
    ):
        raise ValueError
    stride = width * channels + 1
    expected = stride * height
    decoder = zlib.decompressobj()
    pixels = decoder.decompress(compressed, expected + 1)
    if (
        len(pixels) != expected
        or not decoder.eof
        or decoder.unused_data
        or decoder.unconsumed_tail
        or any(pixels[n] > 4 for n in range(0, expected, stride))
    ):
        raise ValueError
    result = (
        PNG
        + _chunk(b"IHDR", header)
        + _chunk(b"IDAT", zlib.compress(pixels))
        + _chunk(b"IEND", b"")
    )
    return result, width, height


def _inspect(data, file):
    media_type = file.media_type.lower().split(";", 1)[0].strip()
    suffix = PurePosixPath(file.path).suffix.lower()
    if media_type == "image/png" and suffix == ".png":
        value, width, height = normalized_png(data)
        return {
            "kind": "png",
            "width": width,
            "height": height,
            "bytes_base64": base64.b64encode(value).decode(),
            "preview_sha256": hashlib.sha256(value).hexdigest(),
            "preview_size": len(value),
            "transformation": "bounded-png-pixels-with-ancillary-metadata-removed-v1",
        }
    if media_type in ("text/plain", "text/markdown", "text/csv", "application/json") and suffix in (
        ".txt",
        ".md",
        ".csv",
        ".log",
        ".json",
    ):
        if len(data) > MAX_TEXT_BYTES:
            raise ValueError
        text = data.decode("utf-8", errors="strict")
        if any(ord(c) < 32 and c not in "\r\n\t" for c in text):
            raise ValueError
        return {
            "kind": "text",
            "text": text,
            "preview_sha256": hashlib.sha256(data).hexdigest(),
            "preview_size": len(data),
            "transformation": "utf8-as-inert-text-v1",
        }
    if media_type in ("application/zip", "application/x-zip-compressed") and suffix == ".zip":
        members = inspect_archive(data)
        if len(members) > MAX_ZIP_MEMBERS or sum(m.size for m in members) > MAX_ZIP_BYTES:
            raise ValueError
        for member in members:
            reader = MemberStream(data, member)
            while reader.read(64 * 1024):
                pass
        return {
            "kind": "zip",
            "members": [
                {"path": m.path, "size": m.size, "directory": m.directory} for m in members
            ],
            "transformation": "bounded-zip-directory-and-member-crc-check-v1",
        }
    raise ValueError


def _preview_attachment(user, payload):
    user = current_actor(user)
    item, entries, by_entry = get_item(user, payload.item_id)
    entry = next((e for e in entries if e.id == payload.entry_id), None)
    attachment = next(
        (
            a
            for a in by_entry.get(payload.entry_id, [])
            if a.source_file.revision_id == payload.bundle_revision_id
            and a.source_file.path == payload.path
        ),
        None,
    )
    if entry is None or attachment is None:
        raise NotFound("Knowledge attachment not found.")
    file = attachment.source_file
    result = {
        "item_id": str(item.id),
        "entry_id": str(entry.id),
        "entry_number": entry.number,
        "attachment": attachment_result(attachment),
        "qualification": "not_evaluated",
    }
    if file.blob.size > MAX_PREVIEW_BYTES:
        get_item(current_actor(user), item.id)
        return {
            **result,
            "kind": "download_only",
            "reason": "Preview byte limit exceeded.",
            "integrity": "not_read_for_preview",
        }
    with blobstore.open_blob(file.blob.sha256) as stream:
        data = stream.read(MAX_PREVIEW_BYTES + 1)
    # Current source authority precedes even integrity diagnostics after I/O.
    get_item(current_actor(user), item.id)
    if len(data) != file.blob.size or hashlib.sha256(data).hexdigest() != file.blob.sha256:
        raise ValidationFailed("Attachment bytes do not match their registered integrity.")
    try:
        preview = _inspect(data, file)
    except (ValueError, zlib.error, ValidationFailed):
        preview = {
            "kind": "download_only",
            "reason": "Unsupported format or preview safety bounds; download original bytes.",
        }
    # Byte parsing may overlap a separately committed account/source revocation.
    get_item(current_actor(user), item.id)
    return {**result, "integrity": "original_sha256_and_size_verified", **preview}


def preview_attachment(user, payload):
    """Do not reveal whether a denied item/entry/source/attachment reference exists."""
    try:
        return _preview_attachment(user, payload)
    except NotFound:
        raise NotFound("Knowledge attachment not found.") from None


@operation(
    "knowledge.preview",
    PreviewAttachment,
    supports_idempotency=False,
    summary="Inspect a bounded inert preview of an exact currently readable knowledge attachment.",
    access=Perm.WORKSPACE_READ,
)
def preview(ctx: Context, payload: PreviewAttachment):
    return preview_attachment(ctx.user, payload)
