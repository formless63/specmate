"""Standard-library offline check of a coherent export package (no application needed).

Usage: python3 -I -S verification.py package.zip|extracted-folder --manifest-sha256 <sha256>
(<sha256> is the manifest hash retained from the authorized review.)

This file ships inside every package as verify/verification.py and is listed in the manifest
like any other file. A copy inside the package can only vouch for the package it came with:
for independent assurance, run a copy obtained separately (for example from the application).

Checks the manifest against a separately retained review hash, the file inventory and
hashes, every pinned canonical design snapshot, and that each included output's files
are present. Byte integrity is not a signature, rights certification or qualification.
"""

import argparse
import hashlib
import io
import json
import os
import sys
import zipfile

FORMAT = "specmate.coherent-export-package"


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def verify_files(files, manifest_sha256=None):
    """Return a list of problems; empty means every recorded byte and pin matched."""
    problems = []
    raw = files.get("manifest.json")
    if raw is None:
        return ["manifest.json is missing"]
    if manifest_sha256 is not None and sha256(raw) != manifest_sha256:
        problems.append("manifest.json does not match the retained review hash")
    manifest = json.loads(raw)
    if manifest.get("format") != FORMAT:
        problems.append("unsupported package format")
    inventory = {row["path"]: row for row in manifest.get("files", [])}
    for path in sorted(set(files) - {"manifest.json"} - set(inventory)):
        problems.append(f"unlisted file: {path}")
    for path, row in sorted(inventory.items()):
        data = files.get(path)
        if data is None:
            problems.append(f"missing file: {path}")
        elif sha256(data) != row["sha256"] or len(data) != row["bytes"]:
            problems.append(f"hash or size mismatch: {path}")
    for pin in manifest.get("pins", []):
        data = files.get(pin["design_path"])
        if data is None or sha256(data) != pin["sha256"]:
            problems.append(f"pinned revision bytes differ: {pin['revision_id']}")
    for output in manifest.get("outputs", []):
        if output.get("coherence") == "incoherent":
            problems.append(f"incoherent output: {output['id']}")
        for path in output.get("files", []):
            if path not in inventory:
                problems.append(f"output file not listed: {output['id']} {path}")
    return problems


def verify_archive(data, manifest_sha256=None):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        files = {name: archive.read(name) for name in archive.namelist()}
    return verify_files(files, manifest_sha256)


def read_folder(root):
    files = {}
    for folder, _, names in os.walk(root):
        for name in names:
            path = os.path.join(folder, name)
            with open(path, "rb") as stream:
                files[os.path.relpath(path, root).replace(os.sep, "/")] = stream.read()
    return files


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("package")
    parser.add_argument("--manifest-sha256", required=True)
    args = parser.parse_args(argv)
    if os.path.isdir(args.package):
        problems = verify_files(read_folder(args.package), args.manifest_sha256)
    else:
        with open(args.package, "rb") as stream:
            problems = verify_archive(stream.read(), args.manifest_sha256)
    for problem in problems:
        print(problem)
    print("verified" if not problems else f"{len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
