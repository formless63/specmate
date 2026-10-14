"""ACC-DOC-001: coherent exports cite identical intended revisions and scope quantities.

Expected quantities are derived here from the synthetic fixture's own structure, not
from the package generator. Nothing here runs a native tool or claims qualification.
"""

import base64
import csv
import hashlib
import io
import json
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

from specmate.export_packages import (
    operations,  # noqa: F401
    verification,
)
from specmate.export_packages.verification import verify_archive, verify_files
from specmate.operations import Conflict, NotFound, ValidationFailed

from .conftest import op, remove_member
from .test_assemblies import create, freeze, occ, part
from .test_bom import capture as freeze_bom
from .test_bom import create as create_bom
from .test_bom import policy
from .test_cable_test_intent import contact, expectation
from .test_cable_test_intent import create as create_tests
from .test_cable_test_intent import freeze as freeze_tests
from .test_preparation import cable as length_cable
from .test_preparation_documents import configuration, retain
from .test_transports import api

QUANTITY = 3


def review(user, payload):
    return op(user, "export_package.review", payload)


def download(user, payload, reviewed):
    # Revisions without a rights declaration count as unknown, so the review-only
    # acknowledgement is given unless the caller states otherwise.
    body = {"rights_acknowledged": True, **payload, "reviewed_sha256": reviewed["sha256"]}
    result = op(user, "export_package.download", body)
    raw = base64.b64decode(result["archive_base64"])
    assert hashlib.sha256(raw).hexdigest() == result["sha256"]
    with zipfile.ZipFile(io.BytesIO(raw)) as zipped:
        assert zipped.testzip() is None
        assert all(info.date_time == (1980, 1, 1, 0, 0, 0) for info in zipped.infolist())
        files = {name: zipped.read(name) for name in zipped.namelist()}
    return raw, files


def rows(data):
    return list(csv.DictReader(io.StringIO(data.decode())))


@pytest.fixture
def system(users, project):
    """Root: two contextual occurrences of one exact cable revision plus one board."""
    owner = users["owner"]
    _, cable = length_cable(owner, project)
    _, board = part(owner, project, name="Synthetic controller board")
    root = freeze(
        owner,
        create(
            owner,
            project,
            [
                occ("left", cable, "W1"),
                occ("right", cable, "W2"),
                occ("controller", board, "=HYPERLINK(1)"),
            ],
        ),
    )
    plan = freeze_bom(
        owner,
        create_bom(
            owner,
            project,
            {
                "assembly_revision_id": root["revision_id"],
                "quantity": {"status": "known", "amount": QUANTITY},
                "policies": [
                    policy([], root, "make"),
                    policy(["left"], cable, "make"),
                    policy(["right"], cable, "make"),
                    policy(["controller"], board, "buy"),
                ],
            },
        ),
        "bom.freeze",
    )
    tests = freeze_tests(
        owner,
        create_tests(
            owner,
            project,
            {
                "root_revision_id": root["revision_id"],
                "occurrence_path": ["left"],
                "cable_revision_id": cable["revision_id"],
                "pairs": [expectation(contact("left", "a"), contact("right", "b"), "continuity")],
                "labels": [],
            },
        ),
    )
    return {"cable": cable, "board": board, "root": root, "bom": plan, "tests": tests}


def documents(user, cable, quantity, key):
    _, saved = retain(user, configuration(cable, quantity=quantity), key)
    return saved["document_set_id"]


def run_bundled(work, target, manifest_sha256):
    """Run the package's own verifier with the interpreter in isolated mode."""
    script = work / "verify" / "verification.py"
    argv = [sys.executable, "-I", "-S", str(script), str(target), "--manifest-sha256"]
    return subprocess.run(  # noqa: S603
        [*argv, manifest_sha256], capture_output=True, text=True, check=False
    )


def test_package_pins_every_output_to_identical_revisions_and_independent_quantities(
    users, system, tmp_path
):
    owner, viewer = users["owner"], users["viewer"]
    root, cable, board = system["root"], system["cable"], system["board"]
    # Independent oracle: the cable occurs twice per root, the board once.
    expected = {cable["revision_id"]: 2 * QUANTITY, board["revision_id"]: 1 * QUANTITY}
    document_set = documents(owner, cable, expected[cable["revision_id"]], "cable-docs")
    payload = {
        "root_revision_id": root["revision_id"],
        "quantity": QUANTITY,
        "bom_plan_revision_id": system["bom"]["revision_id"],
        "preparation_document_set_ids": [document_set],
        "test_plan_revision_ids": [system["tests"]["revision_id"]],
    }
    reviewed = review(viewer, payload)
    manifest = reviewed["manifest"]
    assert manifest["coherence"] == "coherent", manifest["outputs"]
    # BOM unknowns (undeclared waste) stay visible; they limit, not contradict, the package.
    assert manifest["completeness"] == "limited"
    assert manifest["unresolved"]
    assert {u["output"] for u in manifest["unresolved"]} == {
        f"bom_plan:{system['bom']['revision_id']}"
    }
    assert manifest["scope"]["root"]["revision_id"] == root["revision_id"]
    assert manifest["scope"]["root"]["sha256"] == root["sha256"]
    pins = {row["revision_id"]: row for row in manifest["pins"]}
    for rid, amount in expected.items():
        assert pins[rid]["scope_quantity"] == {
            "status": "known",
            "amount": amount,
            "per_root": amount // QUANTITY,
        }
    assert {o["kind"] for o in manifest["outputs"]} == {
        "bom_plan",
        "preparation_document_set",
        "cable_test_plan",
    }
    by_definition = {}
    for row in manifest["pins"]:
        by_definition.setdefault(row["definition_id"], set()).add(row["revision_id"])
    for output in manifest["outputs"]:
        assert output["coherence"] == "coherent"
        assert output["cited_revisions"]
        for cited in output["cited_revisions"]:
            assert cited["status"] in {"pinned", "supplementary"}
            if cited["definition_id"] in by_definition:
                assert cited["revision_id"] in by_definition[cited["definition_id"]]
    prep = next(o for o in manifest["outputs"] if o["kind"] == "preparation_document_set")
    assert prep["scope_quantity"]["amount"] == expected[cable["revision_id"]]
    tests = next(o for o in manifest["outputs"] if o["kind"] == "cable_test_plan")
    assert tests["anchor"]["occurrence_paths"] == [["left"]]
    assert tests["scope_quantity"] == {"status": "known", "amount": QUANTITY, "per_root": 1}
    assert {u["id"] for u in manifest["unsupported"]} >= {
        "mechanical.native_cad_export",
        "pcb.assembly_outputs",
        "test.results",
    }

    raw, files = download(viewer, payload, reviewed)
    assert hashlib.sha256(files["manifest.json"]).hexdigest() == reviewed["sha256"]
    assert json.loads(files["manifest.json"]) == manifest
    inventory = {row["path"]: row for row in manifest["files"]}
    assert set(inventory) == set(files) - {"manifest.json"}
    for path, row in inventory.items():
        assert hashlib.sha256(files[path]).hexdigest() == row["sha256"]
        assert len(files[path]) == row["bytes"]
    # Every pinned canonical snapshot is embedded with its recorded hash.
    for row in manifest["pins"]:
        assert hashlib.sha256(files[row["design_path"]]).hexdigest() == row["sha256"]
    quantities = {r["revision_id"]: r for r in rows(files["spreadsheet/revision-quantities.csv"])}
    for rid, amount in expected.items():
        assert quantities[rid]["scope_quantity"] == str(amount)
        assert quantities[rid]["role"] == "occurrence"
    occurrences = rows(files["spreadsheet/occurrences.csv"])
    assert sorted(r["path"] for r in occurrences) == ["controller", "left", "right"]
    controller = next(r for r in occurrences if r["path"] == "controller")
    assert controller["display_ref"] == "'=HYPERLINK(1)"
    bom = rows(files["spreadsheet/bom-procurement.csv"])
    assert {(r["path"], r["quantity"]) for r in bom} == {("controller", str(QUANTITY))}
    # Retained preparation bytes and test package are embedded unchanged.
    stored = op(
        viewer,
        "preparation_documents.download",
        {"document_set_id": document_set, "filename": "cut-preparation.csv"},
    )
    assert files[f"cable/preparation/{document_set}/cut-preparation.csv"] == base64.b64decode(
        stored["data_base64"]
    )
    package = json.loads(files[f"test/{system['tests']['revision_id']}/cable-test-package.json"])
    assert package["scope"]["root_revision_id"] == root["revision_id"]
    cable_json = json.loads(files[f"cable/{cable['revision_id']}/cable.json"])
    assert cable_json["sha256"] == cable["sha256"]
    assert b"<script" not in files["review.html"]
    assert verify_archive(raw, reviewed["sha256"]) == []
    tampered = {**files, f"cable/{cable['revision_id']}/conductors.csv": b"altered"}
    assert verify_files(tampered, reviewed["sha256"]) == [
        f"hash or size mismatch: cable/{cable['revision_id']}/conductors.csv"
    ]
    assert verify_files(files, "0" * 64) == [
        "manifest.json does not match the retained review hash"
    ]
    # Fixed timestamps and sorted entries: an unchanged review yields identical bytes.
    assert download(viewer, payload, reviewed)[0] == raw

    # The offline verifier travels in the package, listed and hashed like any other file.
    bundled = files["verify/verification.py"]
    frozen = Path(verification.__file__).with_name("verifiers") / "v2.py"
    assert bundled == frozen.read_bytes()
    # Released verifier bytes never change; a verifier change needs a new package format.
    assert (
        hashlib.sha256(bundled).hexdigest()
        == "19c90ac0c8877f06b4d0b28690ac423259158bf192370d7a6ad367368c0c63d4"
    )
    assert json.loads(files["manifest.json"])["package_format"] == 2
    listed = {row["path"]: row for row in json.loads(files["manifest.json"])["files"]}
    assert listed["verify/verification.py"]["sha256"] == hashlib.sha256(bundled).hexdigest()
    assert b"verify/verification.py" in files["README.txt"]
    work = tmp_path / "extracted"
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        archive.extractall(work)
    (tmp_path / "package.zip").write_bytes(raw)
    for target in (work, tmp_path / "package.zip"):
        done = run_bundled(work, target, reviewed["sha256"])
        assert (done.returncode, done.stdout.strip()) == (0, "verified"), done.stdout
    (work / "cable" / cable["revision_id"] / "conductors.csv").write_bytes(b"altered")
    done = run_bundled(work, work, reviewed["sha256"])
    assert done.returncode == 1 and "hash or size mismatch" in done.stdout


def test_incoherent_revisions_and_quantities_block_the_package(users, project, system):
    owner = users["owner"]
    root, cable = system["root"], system["cable"]
    # A separate standalone cable is outside the root closure.
    _, other = length_cable(owner, project)
    wrong_quantity = documents(owner, cable, 2, "wrong-quantity")
    outside = documents(owner, other, 1, "outside")
    payload = {
        "root_revision_id": root["revision_id"],
        "quantity": QUANTITY + 1,
        "bom_plan_revision_id": system["bom"]["revision_id"],
        "preparation_document_set_ids": [wrong_quantity, outside],
    }
    reviewed = review(users["viewer"], payload)
    manifest = reviewed["manifest"]
    assert manifest["coherence"] == "incoherent"
    reasons = {
        (o["kind"], o["id"].split(":")[1]): {f["reason"] for f in o["findings"]}
        for o in manifest["outputs"]
    }
    assert reasons[("bom_plan", system["bom"]["revision_id"])] == {"bom_quantity_differs"}
    # Expected 2 occurrences x 4 roots = 8; the retained set declared 2.
    assert reasons[("preparation_document_set", wrong_quantity)] == {"document_quantity_differs"}
    finding = next(
        f for o in manifest["outputs"] if o["id"].endswith(wrong_quantity) for f in o["findings"]
    )
    assert finding["expected_quantity"] == 2 * (QUANTITY + 1)
    assert "document_root_not_in_package" in reasons[("preparation_document_set", outside)]
    with pytest.raises(ValidationFailed):
        download(users["viewer"], payload, reviewed)


def test_test_plan_citing_another_revision_of_a_pinned_definition_conflicts(users, project, system):
    owner = users["owner"]
    root, cable = system["root"], system["cable"]
    second_root = freeze(owner, create(owner, project, [occ("left", cable, "W1")]))
    stale = freeze_tests(
        owner,
        create_tests(
            owner,
            project,
            {
                "root_revision_id": second_root["revision_id"],
                "occurrence_path": ["left"],
                "cable_revision_id": cable["revision_id"],
                "pairs": [],
                "labels": [],
            },
        ),
    )
    payload = {
        "root_revision_id": root["revision_id"],
        "quantity": QUANTITY,
        "test_plan_revision_ids": [stale["revision_id"]],
    }
    manifest = review(users["viewer"], payload)["manifest"]
    (output,) = manifest["outputs"]
    assert output["coherence"] == "incoherent"
    assert {f["reason"] for f in output["findings"]} == {"test_root_not_in_package"}
    # The cable itself is the same pinned revision even though the plan's root is not.
    cited = {c["revision_id"]: c["status"] for c in output["cited_revisions"]}
    assert cited[cable["revision_id"]] == "pinned"


def test_unknown_quantity_stays_unknown_and_limits_the_package(users, system):
    owner = users["owner"]
    document_set = documents(owner, system["cable"], 6, "unknown-scope")
    payload = {
        "root_revision_id": system["root"]["revision_id"],
        "preparation_document_set_ids": [document_set],
    }
    reviewed = review(users["viewer"], payload)
    manifest = reviewed["manifest"]
    assert manifest["scope"]["quantity_status"] == "unknown"
    assert manifest["coherence"] == "unknown"
    assert manifest["completeness"] == "limited"
    (output,) = manifest["outputs"]
    assert output["coherence"] == "unknown"
    assert {f["reason"] for f in output["findings"]} == {"scope_quantity_unknown"}
    _, files = download(users["viewer"], payload, reviewed)
    quantities = rows(files["spreadsheet/revision-quantities.csv"])
    cable_row = next(r for r in quantities if r["revision_id"] == system["cable"]["revision_id"])
    assert cable_row["scope_quantity"] == "" and cable_row["scope_quantity_status"] == "unknown"
    assert cable_row["per_root_occurrences"] == "2"


def test_stale_review_access_and_http_download(users, workspace, system):
    payload = {"root_revision_id": system["root"]["revision_id"], "quantity": 1}
    reviewed = review(users["viewer"], payload)
    with pytest.raises(Conflict):
        op(
            users["viewer"],
            "export_package.download",
            {**payload, "quantity": 2, "reviewed_sha256": reviewed["sha256"]},
        )
    with pytest.raises(NotFound):
        review(users["outsider"], payload)
    response = api(users["viewer"]).post(
        "/api/v0/export-packages/download",
        {**payload, "reviewed_sha256": reviewed["sha256"], "rights_acknowledged": True},
        content_type="application/json",
    )
    assert response.status_code == 200
    assert response["Content-Type"] == "application/zip"
    assert response["Digest"] == "sha-256=" + hashlib.sha256(response.content).hexdigest()
    remove_member(users["viewer"], workspace=workspace)
    with pytest.raises(NotFound):
        review(users["viewer"], payload)


def test_candidates_list_only_readable_outputs_rooted_in_the_closure(users, project, system):
    owner = users["owner"]
    _, other = length_cable(owner, project)
    inside = documents(owner, system["cable"], 6, "candidate-inside")
    documents(owner, other, 1, "candidate-outside")
    elsewhere = freeze_tests(
        owner,
        create_tests(
            owner,
            project,
            {
                "root_revision_id": other["revision_id"],
                "cable_revision_id": other["revision_id"],
                "pairs": [],
                "labels": [],
            },
        ),
    )
    payload = {"root_revision_id": system["root"]["revision_id"]}
    listed = op(users["viewer"], "export_package.candidates", payload)
    assert [row["document_set_id"] for row in listed["preparation_document_sets"]] == [inside]
    assert listed["preparation_document_sets"][0]["quantity"] == 6
    plans = [row["revision_id"] for row in listed["test_plans"]]
    assert plans == [system["tests"]["revision_id"]]
    assert elsewhere["revision_id"] not in plans
    assert listed["scene_drawings"] == [] and listed["pcb_fabrication_builds"] == []
    with pytest.raises(NotFound):
        op(users["outsider"], "export_package.candidates", payload)
