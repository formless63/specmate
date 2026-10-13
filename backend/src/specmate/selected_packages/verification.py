"""Offline package verification uses declared bytes, not application/database access."""

import hashlib
import json

from specmate.contracts import check_file_tree
from specmate.design.operations import canonical_bytes


def verify_files(files, *, manifest_sha256=None):
    """Return explicit integrity/dependency failures; qualification is never inferred."""
    problems = []
    try:
        check_file_tree(list(files))
        raw = files["manifest.json"]
        if manifest_sha256 and hashlib.sha256(raw).hexdigest() != manifest_sha256:
            problems.append("Manifest hash mismatch.")
        manifest = json.loads(raw)
        if manifest.get("format") != "specmate.selected-assembly-package":
            return [*problems, "Unsupported package format."]
        entries = manifest["files"]
        check_file_tree([entry["path"] for entry in entries])
        expected = {entry["path"] for entry in entries} | {"manifest.json"}
        if set(files) != expected:
            problems.append("Package file set differs from manifest.")
        for entry in entries:
            data = files.get(entry["path"])
            if data is None:
                problems.append("Required file missing.")
            elif len(data) != entry["bytes"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
                problems.append("File hash or byte count mismatch.")
        revisions = {entry["revision_id"]: entry for entry in manifest["design_revisions"]}
        for entry in revisions.values():
            data = files.get(entry["path"])
            if data is None or hashlib.sha256(data).hexdigest() != entry["sha256"]:
                problems.append("Required design snapshot missing or changed.")
                continue
            body = json.loads(data)
            if data != canonical_bytes(body) or body["definition_id"] != entry["definition_id"]:
                problems.append("Design canonical identity mismatch.")
            for pin in body["dependencies"]:
                dependency = revisions.get(pin["revision_id"])
                if dependency is None:
                    problems.append("Required design dependency not included.")
                elif dependency["sha256"] != pin["sha256"]:
                    problems.append("Exact dependency pin mismatch.")
        for row in manifest["occurrences"]:
            if row["revision_id"] not in revisions or (
                revisions[row["revision_id"]]["sha256"] != row["sha256"]
            ):
                problems.append("Occurrence pin missing or changed.")
            firmware = row["assignments"].get("firmware_revision_id")
            if firmware and firmware not in revisions:
                problems.append("Required contextual firmware missing.")
        for source in manifest["source_files"]:
            if source["path"] is None:
                problems.append("Required source dependency not included.")
            else:
                data = files.get(source["path"])
                if (
                    data is None
                    or len(data) != source["bytes"]
                    or (hashlib.sha256(data).hexdigest() != source["sha256"])
                ):
                    problems.append("Required source bytes missing or changed.")
        if manifest["unresolved"]:
            problems.append("Declared package limitations remain unresolved.")
    except (KeyError, TypeError, ValueError, UnicodeError):
        problems.append("Malformed package manifest or canonical file.")
    return sorted(set(problems))
