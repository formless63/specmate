"""Workspace settings authority, explicit document copies and unchanged retained files."""

import hashlib
import uuid

import pytest
from django.db import transaction
from django.test import Client

from specmate.design.operations import canonical_bytes
from specmate.operations import Conflict, NotFound, PermissionDenied, ValidationFailed
from specmate.preparation_documents.contracts import Configuration
from specmate.preparation_documents.projection import project as projection
from specmate.preparation_documents.rendering import render
from specmate.workspace_settings.models import WorkspaceSettings

from .conftest import op
from .test_preparation import cable
from .test_preparation_documents import configuration, files, retain


def get(user, workspace):
    return op(user, "workspace.settings.get", {"workspace_id": workspace})


def update(user, workspace, values, state=None):
    return op(
        user,
        "workspace.settings.update",
        {"workspace_id": workspace, "values": values},
        expected_state=state or get(user, workspace)["state_token"],
    )


def test_default_off_authority_and_cas(users, workspace, other_workspace):
    initial = get(users["viewer"], workspace)
    assert initial["version"] == 0
    assert initial["values"] == {"documents": {}}
    for role in ("viewer", "contributor", "editor"):
        with pytest.raises(PermissionDenied):
            update(users[role], workspace, {"documents": {"organization": "Example workshop"}})
    with pytest.raises(NotFound):
        get(users["outsider"], workspace)
    with pytest.raises(NotFound):
        update(users["owner"], other_workspace, {})
    saved = update(
        users["owner"],
        workspace,
        {"documents": {"organization": "Example workshop"}, "numbering": None},
    )
    assert saved["version"] == 1
    assert saved["values"]["documents"]["organization"] == "Example workshop"
    with pytest.raises(Conflict):
        update(users["owner"], workspace, {}, initial["state_token"])
    assert get(users["viewer"], workspace) == saved


@pytest.mark.parametrize(
    "values",
    [
        {"documents": {"label_qr_url": "javascript:alert(1)"}},
        {"documents": {"paper": "arbitrary-css"}},
        {
            "numbering": {
                "type": "declarative",
                "template": "{seq}",
                "segments": [{"id": "seq", "type": "counter", "width": 4}],
                "validation": {"regex": "(a|aa)+$"},
            }
        },
        {"documents": {"engineering_fact": True}},
        {"numbering": {"prefixes": {"cable": "bad prefix"}}},
        {"numbering": {"prefixes": {"cable": "CBL"}, "digits": True}},
        {
            "numbering": {
                "type": "declarative",
                "template": "{missing}",
                "segments": [{"id": "seq", "type": "counter", "width": 5}],
            }
        },
    ],
)
def test_invalid_settings_do_not_write(users, workspace, values):
    with pytest.raises(ValidationFailed):
        update(users["owner"], workspace, values)
    assert not WorkspaceSettings.objects.exists()


def test_rollback_and_prefix_setting_never_assigns_identifiers(users, workspace):
    with pytest.raises(RuntimeError), transaction.atomic():
        update(
            users["owner"], workspace, {"numbering": {"prefixes": {"cable": "CBL"}, "digits": 4}}
        )
        raise RuntimeError("Synthetic rollback")
    assert get(users["owner"], workspace)["version"] == 0
    saved = update(
        users["owner"], workspace, {"numbering": {"prefixes": {"cable": "CBL"}, "digits": 4}}
    )
    assert saved["values"]["numbering"]["digits"] == 4
    assert WorkspaceSettings.objects.count() == 1
    assert update(users["owner"], workspace, {"numbering": None})["values"] == {"documents": {}}


def test_http_calls_shared_operation(users, workspace):
    client = Client()
    client.force_login(users["owner"])
    payload = {
        "operation": "workspace.settings.update",
        "request_id": str(uuid.uuid4()),
        "expected_state": get(users["owner"], workspace)["state_token"],
        "payload": {
            "workspace_id": workspace,
            "values": {"documents": {"designer": "Example designer"}},
        },
    }
    response = client.post("/api/v0/operations", payload, content_type="application/json")
    assert response.status_code == 200
    assert get(users["viewer"], workspace)["values"]["documents"]["designer"] == "Example designer"


def test_legacy_configuration_omits_optional_field_byte_for_byte():
    root = "10000000-0000-4000-8000-000000000001"
    value = Configuration.model_validate({"root_revision_id": root})
    expected = {
        "root_revision_id": root,
        "quantity": 1,
        "bom_plan_revision_id": None,
        "standalone_decision": "unknown",
        "standalone_basis": None,
        "bindings": [],
        "purpose": "authorized_review",
        "rights_reviews": [],
        "output_rights": "unknown",
        "output_rights_basis": None,
    }
    assert value.model_dump(mode="json") == expected
    assert (
        Configuration.model_validate({**expected, "document_settings": None}).model_dump(
            mode="json"
        )
        == expected
    )


def test_titleblock_copy_is_reviewed_hashed_escaped_and_retained(users, workspace, project):
    user = users["owner"]
    _, root = cable(user, project)
    legacy = configuration(root)
    old_projection = projection(user, Configuration.model_validate(legacy))
    old_manifest, old_bytes = render(old_projection)
    assert old_manifest["inputs"]["generator"] == "specmate.preparation-documents/2"
    setting = update(
        user,
        workspace,
        {
            "documents": {
                "organization": "<Example workshop>",
                "designer": "Default designer",
                "rights_line": "Internal review text",
                "paper": "A4",
                "title_block": "iso7200",
            }
        },
    )
    snapshot = {
        **setting["values"]["documents"],
        "source_settings_version": setting["version"],
        "designer": "Reviewed designer",
    }
    current = configuration(root, document_settings=snapshot)
    reviewed, saved = retain(user, current, key="titleblock-copy")
    retained = files(user, saved)
    sheet = retained["build-sheet.html"].decode()
    assert "&lt;Example workshop&gt;" in sheet and "<Example workshop>" not in sheet
    assert "Reviewed designer" in sheet and "Internal review text" in sheet
    assert "@page{size:A4;}" in sheet
    assert reviewed["manifest"]["inputs"]["generator"] == "specmate.preparation-documents/3"
    assert reviewed["manifest"]["inputs"]["configuration"]["output_rights"] == "unknown"
    assert reviewed["state"] != "document-inputs-" + old_projection["inputs_sha256"]
    update(
        user,
        workspace,
        {"documents": {"organization": "Changed workshop", "designer": "Later designer"}},
    )
    assert files(user, saved) == retained
    now_manifest, now_bytes = render(projection(user, Configuration.model_validate(legacy)))
    assert now_manifest == old_manifest and now_bytes == old_bytes
    assert hashlib.sha256(retained["build-sheet.html"]).hexdigest() == next(
        output["sha256"]
        for output in saved["manifest"]["outputs"]
        if output["filename"] == "build-sheet.html"
    )


def test_legacy_generator_two_output_hashes():
    # Independent synthetic golden captured from the pre-title-block /2 generator.
    root = "10000000-0000-4000-8000-000000000001"
    inputs = {
        "generator": "specmate.preparation-documents/2",
        "root": {"revision_id": root},
        "configuration": Configuration.model_validate({"root_revision_id": root}).model_dump(
            mode="json"
        ),
    }
    value = {
        "inputs": inputs,
        "inputs_sha256": hashlib.sha256(canonical_bytes(inputs)).hexdigest(),
        "readiness": "declared_with_unknowns",
        "document_assessments": {},
        "sections": {
            key: []
            for key in [
                "issues",
                "cut_preparation",
                "terminations",
                "revision_specifications",
                "specifications",
                "test_intent",
                "end_preparation",
                "schematic",
                "procurement",
            ]
        },
    }
    _, rendered = render(value)
    assert {name: hashlib.sha256(data).hexdigest() for name, (_, data) in rendered.items()} == {
        "specifications.json": "38235852686141e3931a88d990d3ba4744a094f7c57e02d44f5683ad5c407062",
        "terminations.json": "dfb4f77ceeb5464de9ca7fe9105b1b1a63851e1b5c2bd315c2d83affdbf69659",
        "test-intent.json": "dfb4f77ceeb5464de9ca7fe9105b1b1a63851e1b5c2bd315c2d83affdbf69659",
        "cut-preparation.csv": "304d0238fa772c3370441f8dfa12487548c97abd4d126e2cf10e13b2a4b02757",
        "schematic.svg": "6d4c2e8cdc488a78014a56bb370aa4a13b07824061adde90fe2dc3c962e5049a",
        "build-sheet.html": "735bab0002f350c8d57b96f07abf2207ddbc0c1447f1f1efca3d820aba65d618",
    }
