"""Original synthetic package oracles; no application, database or third-party packages."""

import copy
import hashlib
import io
import json
import runpy
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERIFIER = ROOT / "backend/src/specmate/selected_packages/verification.py"
VERIFY = runpy.run_path(str(VERIFIER))
RID = "00000000-0000-4000-8000-000000000001"
DID = "00000000-0000-4000-8000-000000000002"
SID = "00000000-0000-4000-8000-000000000003"
SOURCE = "00000000-0000-4000-8000-000000000004"
DEPENDENCY = "00000000-0000-4000-8000-000000000005"


def raw(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def fixture():
    """Hand-built expected pins; exporter implementation never supplies this oracle."""
    source = b"Original synthetic inert source.\n"
    snapshot = raw(
        {
            "schema_version": "0.1",
            "definition_id": DID,
            "kind": "part",
            "content": {"source_revision_id": SOURCE, "path": "data.txt", "sha256": sha(source)},
            "dependencies": [],
        }
    )
    manifest_hash = "a" * 64
    manifest = {
        "format": "specmate.selected-assembly-package",
        "schema_version": "0.1",
        "purpose": "authorized_review",
        "completeness": "complete_declared_data",
        "scope": {
            "root_revision_id": RID,
            "root_snapshot_id": SID,
            "root_sha256": sha(snapshot),
            "occurrence_path": [],
            "selected_revision_id": RID,
            "selected_sha256": sha(snapshot),
        },
        "design_revisions": [
            {
                "revision_id": RID,
                "snapshot_id": SID,
                "definition_id": DID,
                "kind": "part",
                "sha256": sha(snapshot),
                "path": f"designs/{RID}.json",
                "rights_review": {"subject": f"design:{RID}", "decision": "unknown", "basis": ""},
            }
        ],
        "occurrences": [
            {
                "path": [],
                "revision_id": RID,
                "sha256": sha(snapshot),
                "assignments": {"firmware_revision_id": None},
                "placement": {"status": "unknown"},
            }
        ],
        "source_files": [
            {
                "source_revision_id": SOURCE,
                "source_path": "data.txt",
                "manifest_sha256": manifest_hash,
                "ancestry": [{"source_revision_id": SOURCE, "manifest_sha256": manifest_hash}],
                "sha256": sha(source),
                "bytes": len(source),
                "media_type": "text/plain",
                "declared_rights": "synthetic",
                "status": "included_inert",
                "path": f"sources/{SOURCE}/data.txt",
                "rights_review": {
                    "subject": f"source:{SOURCE}:data.txt",
                    "decision": "permitted",
                    "basis": "Original fixture",
                },
            }
        ],
        "unresolved": [],
        "boundary_interfaces": [],
        "relationships": [],
        "boundary_crossings": [],
    }
    files = {
        f"designs/{RID}.json": snapshot,
        f"sources/{SOURCE}/data.txt": source,
        "review.html": b"<!doctype html><title>Original synthetic review</title>",
        "README.txt": b"Inert fixture.\n",
    }
    return seal(manifest, files)


def seal(manifest, files):
    files = {key: value for key, value in files.items() if key != "manifest.json"}
    manifest = copy.deepcopy(manifest)
    manifest["files"] = [
        {"path": key, "bytes": len(value), "sha256": sha(value)}
        for key, value in sorted(files.items())
    ]
    files["manifest.json"] = raw(manifest)
    return manifest, files


def archive(files, compression=zipfile.ZIP_DEFLATED):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=compression) as zipped:
        for key, value in sorted(files.items()):
            zipped.writestr(key, value)
    return output.getvalue()


def check(files):
    return VERIFY["verify_archive"](archive(files), manifest_sha256=sha(files["manifest.json"]))


def _run(command):
    # Only the current Python and trusted checkout verifier run, with synthetic argv.
    return subprocess.run(command, capture_output=True, check=False)  # noqa: S603


class PortableVerificationTests(unittest.TestCase):
    def test_intact_complete_data_and_explicit_unknowns(self):
        _, files = fixture()
        result = check(files)
        self.assertEqual(result.errors, [])
        self.assertEqual(result.limitations, [])
        self.assertEqual(result.result()["authenticity"], "not_verified")
        self.assertEqual(result.result()["physical_qualification"], "not_evaluated")
        self.assertIn(b'"status":"unknown"', files["manifest.json"])

    def test_changed_bytes_and_replaced_manifest(self):
        _, files = fixture()
        expected = sha(files["manifest.json"])
        files[f"sources/{SOURCE}/data.txt"] += b"corrupt"
        self.assertIn("Required source bytes missing or changed.", check(files).errors)
        files["manifest.json"] += b" "
        result = VERIFY["verify_archive"](archive(files), manifest_sha256=expected)
        self.assertIn("Manifest hash mismatch.", result.errors)

    def test_exact_file_set(self):
        _, files = fixture()
        for path in ("README.txt", f"designs/{RID}.json", f"sources/{SOURCE}/data.txt"):
            with self.subTest(path=path):
                changed = dict(files)
                del changed[path]
                self.assertIn("Package file set differs from manifest.", check(changed).errors)
        files["surprise.txt"] = b"unlisted"
        self.assertIn("Package file set differs from manifest.", check(files).errors)

    def test_independent_dependency_omission_and_wrong_pin(self):
        manifest, files = fixture()
        body = json.loads(files[f"designs/{RID}.json"])
        body["dependencies"] = [{"revision_id": DEPENDENCY, "sha256": "b" * 64}]
        files[f"designs/{RID}.json"] = raw(body)
        manifest["design_revisions"][0]["sha256"] = sha(raw(body))
        manifest["scope"]["root_sha256"] = manifest["scope"]["selected_sha256"] = sha(raw(body))
        manifest["occurrences"][0]["sha256"] = sha(raw(body))
        _, files = seal(manifest, files)
        self.assertIn("Required design dependency not included.", check(files).errors)
        body["dependencies"] = [{"revision_id": RID, "sha256": "b" * 64}]
        files[f"designs/{RID}.json"] = raw(body)
        manifest["design_revisions"][0]["sha256"] = sha(raw(body))
        _, files = seal(manifest, files)
        self.assertIn("Exact dependency pin mismatch.", check(files).errors)

    def test_canonical_identity_duplicate_json_and_version(self):
        manifest, files = fixture()
        path = f"designs/{RID}.json"
        for bad in (
            files[path] + b" ",
            files[path].replace(DID.encode(), SID.encode()),
            files[path].replace(b'"part"', b'"cable"'),
        ):
            with self.subTest(bad=bad):
                changed = dict(files)
                changed[path] = bad
                manifest["design_revisions"][0]["sha256"] = sha(bad)
                _, changed = seal(manifest, changed)
                self.assertIn("Design canonical identity mismatch.", check(changed).errors)
        _, files = fixture()
        for bad in (
            b'{"format":"x","format":"y"}',
            b"[]",
            b'{"x":NaN}',
            b"[" * 65 + b"0" + b"]" * 65,
            b'{"x":1e999}',
        ):
            files["manifest.json"] = bad
            self.assertTrue(check(files).errors)
        manifest, files = fixture()
        files["manifest.json"] = files["manifest.json"][:-1] + b',"overflow":1e999}'
        self.assertTrue(check(files).errors)
        for field, value in (("format", "unrecognized"), ("schema_version", "999")):
            manifest, files = fixture()
            manifest[field] = value
            _, files = seal(manifest, files)
            self.assertIn("Unsupported package format or schema version.", check(files).errors)

    def test_occurrence_source_provenance_and_duplicate_identities(self):
        for section, key, value, expected in (
            ("occurrences", "sha256", "c" * 64, "Occurrence pin missing or changed."),
            ("occurrences", "revision_id", DEPENDENCY, "Occurrence pin missing or changed."),
            ("source_files", "manifest_sha256", "c" * 64, "Source provenance identity mismatch."),
            ("source_files", "sha256", "c" * 64, "Exact source pin mismatch."),
        ):
            with self.subTest(section=section, key=key):
                manifest, files = fixture()
                manifest[section][0][key] = value
                _, files = seal(manifest, files)
                self.assertIn(expected, check(files).errors)
        for section in ("design_revisions", "occurrences", "source_files"):
            manifest, files = fixture()
            manifest[section].append(copy.deepcopy(manifest[section][0]))
            _, files = seal(manifest, files)
            self.assertTrue(check(files).errors)
        manifest, files = fixture()
        manifest["occurrences"][0]["assignments"]["firmware_revision_id"] = DEPENDENCY
        _, files = seal(manifest, files)
        self.assertIn("Required contextual firmware missing.", check(files).errors)

    def test_omitted_sources_remain_limited_not_corrupt_or_complete(self):
        manifest, files = fixture()
        del files[f"sources/{SOURCE}/data.txt"]
        source = manifest["source_files"][0]
        source.update(path=None, status="omitted_pending_rights")
        source["rights_review"].update(decision="unknown", basis="")
        manifest["unresolved"] = [{"reason": "Explicit omitted required source"}]
        manifest["completeness"] = "limited"
        _, files = seal(manifest, files)
        result = check(files)
        self.assertEqual(result.errors, [])
        self.assertIn("Required source dependency not included.", result.limitations)
        self.assertEqual(result.result()["completeness"], "limited")
        manifest["completeness"] = "complete_declared_data"
        _, files = seal(manifest, files)
        self.assertIn(
            "Package completeness contradicts unresolved dependencies.", check(files).errors
        )

    def test_missing_source_pin_and_unpermitted_inclusion(self):
        manifest, files = fixture()
        manifest["source_files"] = []
        _, files = seal(manifest, files)
        self.assertIn("Required source pin not included.", check(files).errors)
        manifest, files = fixture()
        manifest["source_files"][0]["rights_review"]["decision"] = "withheld"
        _, files = seal(manifest, files)
        self.assertTrue(check(files).errors)
        manifest, files = fixture()
        manifest["purpose"] = "distribution"
        _, files = seal(manifest, files)
        self.assertIn("Distribution design lacks explicit permission.", check(files).errors)

    def test_typed_source_manifest_pin_and_inventory_closure(self):
        manifest, files = fixture()
        body = json.loads(files[f"designs/{RID}.json"])
        body["content"] = {
            "firmware": {
                "sources": [
                    {
                        "source_revision_id": SOURCE,
                        "source_manifest_sha256": "b" * 64,
                        "files": [
                            {"path": "data.txt", "sha256": sha(files[f"sources/{SOURCE}/data.txt"])}
                        ],
                    }
                ]
            }
        }
        files[f"designs/{RID}.json"] = raw(body)
        manifest["design_revisions"][0]["sha256"] = sha(raw(body))
        manifest["scope"]["root_sha256"] = manifest["scope"]["selected_sha256"] = sha(raw(body))
        manifest["occurrences"][0]["sha256"] = sha(raw(body))
        _, files = seal(manifest, files)
        self.assertIn("Exact source pin mismatch.", check(files).errors)
        manifest, files = fixture()
        files["unrelated-source.txt"] = b"surplus data with internally matching inventory"
        _, files = seal(manifest, files)
        self.assertIn(
            "File inventory differs from declared design/source closure.", check(files).errors
        )

    def test_occurrence_addresses_agree_with_frozen_assembly(self):
        manifest, files = fixture()
        body = json.loads(files[f"designs/{RID}.json"])
        body["content"]["assembly"] = {
            "schema_version": "0.1",
            "occurrences": [{"local_id": "required", "revision_id": DEPENDENCY}],
        }
        files[f"designs/{RID}.json"] = raw(body)
        manifest["design_revisions"][0]["sha256"] = sha(raw(body))
        manifest["scope"]["root_sha256"] = manifest["scope"]["selected_sha256"] = sha(raw(body))
        manifest["occurrences"][0]["sha256"] = sha(raw(body))
        _, files = seal(manifest, files)
        self.assertIn("Occurrences contradict canonical assembly structure.", check(files).errors)

    def test_zip_duplicates_unsafe_paths_and_special_files(self):
        _, files = fixture()
        for name in (
            "../escape",
            "/absolute",
            "a/../b",
            "a\\b",
            "C:/drive",
            "a//b",
            "a\x00tail",
            "README.TXT",
            "README.txt/child",
            "cafe\u0301.txt",
        ):
            with self.subTest(name=name):
                changed = dict(files)
                changed[name] = b"inert"
                self.assertTrue(check(changed).errors)
        for mode in (stat.S_IFLNK, stat.S_IFDIR, stat.S_IFCHR, stat.S_IFIFO):
            with self.subTest(mode=mode):
                output = io.BytesIO()
                with zipfile.ZipFile(output, "w") as zipped:
                    info = zipfile.ZipInfo("linked")
                    info.create_system = 3
                    info.external_attr = (mode | 0o644) << 16
                    zipped.writestr(info, b"target")
                self.assertTrue(
                    VERIFY["verify_archive"](output.getvalue(), manifest_sha256="a" * 64).errors
                )
        output = io.BytesIO()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(output, "w") as zipped:
                zipped.writestr("manifest.json", files["manifest.json"])
                zipped.writestr("manifest.json", files["manifest.json"])
        self.assertTrue(
            VERIFY["verify_archive"](output.getvalue(), manifest_sha256="a" * 64).errors
        )

    def test_zip_encryption_compression_bounds_and_corruption(self):
        _, files = fixture()
        data = archive(files)
        for bit in (1, 64):
            changed = bytearray(data)
            central = changed.index(b"PK\x01\x02")
            flags = struct.unpack_from("<H", changed, central + 8)[0]
            struct.pack_into("<H", changed, central + 8, flags | bit)
            self.assertTrue(
                VERIFY["verify_archive"](bytes(changed), manifest_sha256="a" * 64).errors
            )
        for changed in (
            data[:-1],
            b"not zip",
            data + b"trailing",
            b"x" * (VERIFY["MAX_ARCHIVE_BYTES"] + 1),
            archive({"bomb": b"x" * (VERIFY["MAX_BYTES"] + 1)}),
            archive(files, zipfile.ZIP_BZIP2),
        ):
            self.assertTrue(VERIFY["verify_archive"](changed, manifest_sha256="a" * 64).errors)
        changed = bytearray(data)
        end = changed.rfind(b"PK\x05\x06")
        struct.pack_into("<H", changed, end + 10, 4001)
        self.assertTrue(VERIFY["verify_archive"](bytes(changed), manifest_sha256="a" * 64).errors)

    def test_manifest_invalid_counts_and_duplicate_inventory(self):
        for count in (-1, True, "10", VERIFY["MAX_BYTES"] + 1):
            manifest, files = fixture()
            manifest["files"][0]["bytes"] = count
            files["manifest.json"] = raw(manifest)
            self.assertTrue(check(files).errors)
        manifest, files = fixture()
        manifest["files"].append(copy.deepcopy(manifest["files"][0]))
        files["manifest.json"] = raw(manifest)
        self.assertTrue(check(files).errors)

    def test_real_cli_without_site_packages_and_required_external_digest(self):
        manifest, files = fixture()
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory) / "synthetic.zip"
            package.write_bytes(archive(files))
            # -I -S removes site packages and PYTHONPATH; trusted module runs independently.
            cmd = [sys.executable, "-I", "-S", str(VERIFIER), str(package)]
            self.assertEqual(_run(cmd).returncode, 2)
            result = _run([*cmd, "--manifest-sha256", sha(files["manifest.json"])])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["integrity"], "verified")
            result = _run([*cmd, "--manifest-sha256", "0" * 64])
            self.assertEqual(result.returncode, 1)
            manifest["unresolved"] = [{"reason": "Native interpretation unavailable"}]
            manifest["completeness"] = "limited"
            _, files = seal(manifest, files)
            package.write_bytes(archive(files))
            result = _run([*cmd, "--manifest-sha256", sha(files["manifest.json"])])
            self.assertEqual(result.returncode, 2)
            self.assertEqual(json.loads(result.stdout)["integrity"], "verified")


if __name__ == "__main__":
    unittest.main()
