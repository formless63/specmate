"""DOC-002/FW-001: exact inert firmware files within a selected repeated context."""

import copy
import hashlib
import io
import zipfile

import pytest
from django.test import Client

from specmate.operations import Conflict, NotFound, Unauthenticated, ValidationFailed
from specmate.selected_packages.contracts import Selection
from specmate.selected_packages.queries import build_package, source_pins
from specmate.selected_packages.verification import verify_files
from specmate.sources import blobstore

from .conftest import op, remove_member
from .scope_helpers import workspace_of
from .test_assemblies import create, firmware_part, freeze, occ
from .test_selected_packages import package, request
from .test_sources import register

CHOSEN = b"void selected_controller() { /* original synthetic input */ }\n"
UNSELECTED = b"void sibling_controller() { /* unrelated synthetic input */ }\n"
ATTACHMENT = b"unselected companion bytes\n"


def preserved(user, project, name, entries):
    files = []
    for path, data, rights in entries:
        register(user, project, data)
        files.append(
            {
                "path": path,
                "sha256": hashlib.sha256(data).hexdigest(),
                "media_type": "text/plain",
                "rights": rights,
            }
        )
    return op(
        user,
        "source.create_original_bundle",
        {
            "workspace_id": workspace_of(project),
            "name": name,
            "files": files,
        },
    )


@pytest.fixture
def firmware_context(users, project):
    owner = users["owner"]
    prototype, _ = firmware_part(owner, project, "Typed target fixture")
    target = prototype["content"]["firmware"]["target"]["population_revision_id"]
    original = preserved(
        owner,
        project,
        "Selected source origin",
        [
            ("chosen.cpp", CHOSEN, "unknown"),
            ("UNSELECTED_ATTACHMENT.txt", ATTACHMENT, "private"),
        ],
    )
    selected = op(
        owner,
        "source.derive_bundle",
        {
            "source_revision_id": original["revision_id"],
            "name": "Selected derivative",
        },
    )
    sibling = preserved(
        owner,
        project,
        "SIBLING_SOURCE_NAME",
        [
            ("SIBLING_FIRMWARE.cpp", UNSELECTED, "MIT"),
        ],
    )

    def firmware(source, path, data, rights):
        value = copy.deepcopy(prototype["content"]["firmware"])
        value["sources"] = [
            {
                "local_id": "app",
                "source_revision_id": source["revision_id"],
                "source_manifest_sha256": source["manifest_sha256"],
                "files": [
                    {
                        "path": path,
                        "sha256": hashlib.sha256(data).hexdigest(),
                        "rights": rights,
                        "role": "application",
                    }
                ],
            }
        ]
        draft = op(
            owner,
            "firmware.create",
            {
                "workspace_id": workspace_of(project),
                "name": "Exact firmware declaration",
                "firmware": value,
            },
        )
        return op(
            owner, "firmware.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"]
        ), value

    chosen_fw, chosen_content = firmware(selected, "chosen.cpp", CHOSEN, "unknown")
    sibling_fw, _ = firmware(sibling, "SIBLING_FIRMWARE.cpp", UNSELECTED, "MIT")
    nested = freeze(owner, create(owner, project, [occ("board", {"revision_id": target})]))
    root = freeze(
        owner,
        create(
            owner,
            project,
            [occ("a", nested), occ("b", nested)],
            assignments=[
                {
                    "path": ["a", "board"],
                    "assignments": {"firmware_revision_id": sibling_fw["revision_id"]},
                },
                {
                    "path": ["b", "board"],
                    "assignments": {"firmware_revision_id": chosen_fw["revision_id"]},
                },
            ],
        ),
    )
    payload = request(root, ["b"])
    subject = f"source:{selected['revision_id']}:chosen.cpp"
    rights = [{"subject": subject, "decision": "permitted", "basis": "Synthetic owner review"}]
    return {
        "root": root,
        "selected": selected,
        "original": original,
        "sibling": sibling,
        "chosen_fw": chosen_fw,
        "sibling_fw": sibling_fw,
        "nested": nested,
        "target": target,
        "content": {"firmware": chosen_content},
        "payload": payload,
        "rights": rights,
    }


def test_typed_file_boundary_is_explicit_and_arbitrary_native_shapes_stay_opaque(
    users, project, firmware_context
):
    context = firmware_context
    rid = context["selected"]["revision_id"]
    assert list(source_pins(context["content"], kind="firmware")) == [(rid, "chosen.cpp", None)]
    # Similar extension data has no established typed file-selection meaning.
    opaque = {"source_revision_id": rid, "files": [{"path": "chosen.cpp"}]}
    assert list(source_pins(opaque, kind="unknown_native")) == [(rid, None, None)]
    draft = op(
        users["owner"],
        "definition.create",
        {
            "workspace_id": workspace_of(project),
            "kind": "unknown_native",
            "name": "Opaque declaration",
            "content": opaque,
        },
    )
    frozen = op(
        users["owner"],
        "draft.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )
    reviewed, _, files = package(users["viewer"], request(frozen))
    assert reviewed["manifest"]["source_files"] == []
    assert {"reason": "Source bundle reference lacks an exact selected file boundary."} in reviewed[
        "manifest"
    ]["unresolved"]
    assert reviewed["manifest"]["completeness"] == "limited"
    assert CHOSEN not in b"".join(files.values())


def test_selected_firmware_files_require_review_and_exclude_sibling_context(
    users, firmware_context
):
    context = firmware_context
    payload = context["payload"]
    initial, _, absent = package(users["viewer"], payload)
    manifest = initial["manifest"]
    assert len(manifest["source_files"]) == 1
    source = manifest["source_files"][0]
    assert source["source_path"] == "chosen.cpp"
    assert source["declared_rights"] == "unknown"
    assert source["status"] == "omitted_pending_rights" and source["path"] is None
    assert not any(path.startswith("sources/") for path in absent)
    assert {row["source_revision_id"] for row in source["ancestry"]} == {
        context["original"]["revision_id"],
        context["selected"]["revision_id"],
    }
    withheld, _, withheld_files = package(
        users["viewer"],
        {
            **payload,
            "rights_reviews": [{**context["rights"][0], "decision": "withheld"}],
        },
    )
    assert withheld["manifest"]["source_files"][0]["rights_review"]["decision"] == "withheld"
    assert not any(path.startswith("sources/") for path in withheld_files)
    reviewed_payload = {**payload, "rights_reviews": context["rights"]}
    reviewed, _, files = package(users["viewer"], reviewed_payload)
    manifest = reviewed["manifest"]
    expected_path = f"sources/{context['selected']['revision_id']}/chosen.cpp"
    assert {path for path in files if path.startswith("sources/")} == {expected_path}
    assert files[expected_path] == CHOSEN
    assert manifest["source_files"][0]["sha256"] == hashlib.sha256(CHOSEN).hexdigest()
    assert manifest["source_files"][0]["declared_rights"] == "unknown"
    assert manifest["source_files"][0]["rights_review"] == context["rights"][0]
    assert {row["revision_id"] for row in manifest["design_revisions"]} == {
        context["nested"]["revision_id"],
        context["target"],
        context["chosen_fw"]["revision_id"],
    }
    assert manifest["occurrences"][1]["path"] == ["board"]
    assert (
        manifest["occurrences"][1]["assignments"]["firmware_revision_id"]
        == context["chosen_fw"]["revision_id"]
    )
    joined = b"\n".join(files.values())
    for forbidden in (
        b"SIBLING_SOURCE_NAME",
        b"SIBLING_FIRMWARE.cpp",
        b"UNSELECTED_ATTACHMENT.txt",
        UNSELECTED,
        ATTACHMENT,
        context["sibling_fw"]["revision_id"].encode(),
    ):
        assert forbidden not in joined
    assert manifest["completeness"] == "limited"
    firmware_unknown = next(
        row for row in manifest["unresolved"] if row.get("kinds") == ["firmware"]
    )
    assert firmware_unknown["toolchain_support"] == "declared_not_verified"
    assert firmware_unknown["compilation"] == firmware_unknown["flashing"] == "not_performed"
    assert manifest["physical_qualification"] == "not_evaluated"
    assert verify_files(files, manifest_sha256=reviewed["sha256"]) == [
        "Declared package limitations remain unresolved."
    ]
    # A changed source-rights decision cannot reuse an earlier reviewed package hash.
    with pytest.raises(Conflict):
        op(
            users["viewer"],
            "selected_package.download",
            {
                **reviewed_payload,
                "reviewed_sha256": initial["sha256"],
            },
        )
    all_reviews = [
        {
            "subject": row["rights_review"]["subject"],
            "decision": "permitted",
            "basis": "Synthetic review",
        }
        for row in manifest["source_files"] + manifest["design_revisions"]
    ]
    with pytest.raises(ValidationFailed, match="semantics remain unresolved"):
        op(
            users["owner"],
            "selected_package.review",
            {**payload, "purpose": "distribution", "rights_reviews": all_reviews},
        )


def test_firmware_reviewed_http_download_checks_current_bytes(users, firmware_context):
    context = firmware_context
    payload = {**context["payload"], "rights_reviews": context["rights"]}
    review = op(users["viewer"], "selected_package.review", payload)
    client = Client()
    client.force_login(users["viewer"])
    download = {**payload, "reviewed_sha256": review["sha256"]}
    response = client.post(
        "/api/v0/selected-packages/download", download, content_type="application/json"
    )
    assert response.status_code == 200 and response["Cache-Control"] == "private, no-store"
    with zipfile.ZipFile(io.BytesIO(response.content)) as zipped:
        assert zipped.read(f"sources/{context['selected']['revision_id']}/chosen.cpp") == CHOSEN
    path = blobstore.blob_path(hashlib.sha256(CHOSEN).hexdigest())
    path.chmod(0o600)
    path.write_bytes(b"corrupt current bytes")
    rejected = client.post(
        "/api/v0/selected-packages/download", download, content_type="application/json"
    )
    assert rejected.status_code == 422 and "integrity" in rejected.json()["error"]["message"]


def test_firmware_source_ancestry_denial_precedes_selection_rights_and_review_diagnostics(
    users, firmware_context
):
    context = firmware_context
    payload = {**context["payload"], "rights_reviews": context["rights"]}
    review = op(users["owner"], "selected_package.review", payload)
    # Authority over the whole source ancestry is the workspace role: losing membership
    # after review denies before selection, rights or review-hash diagnostics.
    remove_member(users["owner"])
    for sha, path in ((review["sha256"], ["b"]), ("0" * 64, ["missing"])):
        with pytest.raises(NotFound) as failure:
            op(
                users["owner"],
                "selected_package.download",
                {
                    **payload,
                    "occurrence_path": path,
                    "reviewed_sha256": sha,
                    "rights_reviews": [{"subject": "wrong", "decision": "unknown"}],
                },
            )
        assert failure.value.details == {}
    client = Client()
    client.force_login(users["owner"])
    response = client.post(
        "/api/v0/selected-packages/download",
        {
            **payload,
            "reviewed_sha256": review["sha256"],
        },
        content_type="application/json",
    )
    assert response.status_code == 404


def test_firmware_package_refreshes_actor_liveness(users, firmware_context):
    payload = {**firmware_context["payload"], "rights_reviews": firmware_context["rights"]}
    reviewed = op(users["owner"], "selected_package.review", payload)
    type(users["owner"]).objects.filter(pk=users["owner"].pk).update(is_active=False)
    assert users["owner"].is_active  # deliberately retain a stale authenticated object
    with pytest.raises(Unauthenticated):
        build_package(users["owner"], Selection(**payload))
    with pytest.raises(Unauthenticated):
        op(
            users["owner"],
            "selected_package.download",
            {**payload, "reviewed_sha256": reviewed["sha256"]},
        )
