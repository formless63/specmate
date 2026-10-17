"""Workspace settings authority, explicit document copies and unchanged retained files."""

import hashlib
import html
import json
import uuid

import pytest
from django.db import transaction
from django.test import Client

from specmate.design.operations import canonical_bytes
from specmate.operations import Conflict, NotFound, PermissionDenied, ValidationFailed
from specmate.preparation_documents.contracts import (
    COMPACT_GENERATOR,
    COMPACT_JSON_GENERATOR,
    Configuration,
)
from specmate.preparation_documents.projection import (
    _select_size_bounded_generator,
)
from specmate.preparation_documents.projection import (
    project as projection,
)
from specmate.preparation_documents.rendering import MAX_FILE_BYTES, build_sheet_html, render
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
    assert "html{color-scheme:light;background:#fff;color:#111}" in sheet
    assert "body{background:#fff;color:#111}" in sheet
    assert "color-scheme:light" not in old_bytes["build-sheet.html"][1].decode()
    assert reviewed["manifest"]["inputs"]["generator"] == "specmate.preparation-documents/4"
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


def test_compact_generator_six_outputs_keep_their_exact_bytes():
    root = "10000000-0000-4000-8000-000000000001"
    inputs = {
        "generator": COMPACT_GENERATOR,
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
        "specifications.json": "35d3e44acd63d51bf142bf7fd4cc4511bac03b6b3735327b48a55a40035d7957",
        "terminations.json": "a6681f9cab35da81133e9bf92f6356ba993de3c1ae9b4e4819a8a0131996c9f3",
        "test-intent.json": "a6681f9cab35da81133e9bf92f6356ba993de3c1ae9b4e4819a8a0131996c9f3",
        "cut-preparation.csv": "2cead305028aea8d6e9fb5cc123e2f0a8895d628f2353ff446b4b510d4bb06a9",
        "schematic.svg": "1803d2307ba59fb3f706c9bf7a0b8f770bd50cebed0567447529d295d3c509f6",
        "build-sheet.html": "e5ae3cf1ad43e1056f577558852ce1f53f0f425b27a2c47a44b5a9fc8b420f84",
    }


@pytest.mark.parametrize(
    ("generator", "expected_html_sha256"),
    [
        (
            "specmate.preparation-documents/4",
            "1afd2b41539f6b7f2bc0576c22d7880f718598ec00427a204fb7df54013dae9b",
        ),
        (
            "specmate.preparation-documents/5",
            "beb2e56b9377e58389124160d66f87bbca5606cbcd897ba03c2cf9a13133951b",
        ),
    ],
)
def test_legacy_generator_four_and_five_output_hashes(generator, expected_html_sha256):
    root = "10000000-0000-4000-8000-000000000001"
    inputs = {
        "generator": generator,
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
    assert hashlib.sha256(rendered["build-sheet.html"][1]).hexdigest() == expected_html_sha256


def test_dense_build_sheet_selects_compact_generator_without_losing_text():
    root = "10000000-0000-4000-8000-000000000001"
    hostile = '"' * 380_000 + '<script>&"end</script>'
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
            "issues": [],
            "cut_preparation": [],
            "terminations": [],
            "revision_specifications": [],
            "specifications": [],
            "test_intent": [],
            "end_preparation": [],
            "schematic": [],
            "procurement": {"dense_value": hostile},
        },
    }
    initial_hash = value["inputs_sha256"]
    assert len(build_sheet_html(value, escape_pre_quotes=True)) > MAX_FILE_BYTES

    with pytest.raises(ValidationFailed, match="bounded file size"):
        render(value)

    _select_size_bounded_generator(value)
    assert value["inputs"]["generator"] == COMPACT_GENERATOR
    assert value["inputs_sha256"] != initial_hash
    assert value["inputs_sha256"] == hashlib.sha256(canonical_bytes(inputs)).hexdigest()
    manifest, rendered = render(value)
    html_bytes = rendered["build-sheet.html"][1]
    assert len(html_bytes) < MAX_FILE_BYTES
    assert manifest["inputs"]["generator"] == COMPACT_GENERATOR
    assert b"<script>" not in html_bytes
    assert b"&lt;script&gt;&amp;" in html_bytes
    assert b"&quot;" not in html_bytes
    procurement_text = (
        html_bytes.decode()
        .split("<h2>Frozen procurement policy</h2><pre>", 1)[1]
        .split("</pre>", 1)[0]
    )
    assert json.loads(html.unescape(procurement_text)) == {"dense_value": hostile}
    assert render(value)[1] == rendered


def test_indented_build_sheet_uses_compact_json_only_after_generator_six_exceeds_bound():
    root = "10000000-0000-4000-8000-000000000001"
    dense = [{"i": index} for index in range(90_000)]
    hostile = '<script>&"close</pre>'
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
            ]
        }
        | {
            "procurement": {
                "a": {"b": {"c": {"d": {"e": {"groups": {"items": dense}}}}}},
                "hostile": hostile,
            }
        },
    }
    legacy_hash = value["inputs_sha256"]
    assert len(build_sheet_html(value, escape_pre_quotes=True)) > MAX_FILE_BYTES
    assert len(build_sheet_html(value, escape_pre_quotes=False)) > MAX_FILE_BYTES

    _select_size_bounded_generator(value)
    assert value["inputs"]["generator"] == COMPACT_JSON_GENERATOR
    assert value["inputs_sha256"] != legacy_hash
    assert value["inputs_sha256"] == hashlib.sha256(canonical_bytes(value["inputs"])).hexdigest()
    manifest, rendered = render(value)
    assert set(rendered) == {
        "specifications.json",
        "schematic.svg",
        "cut-preparation.csv",
        "build-sheet.html",
        "terminations.json",
        "test-intent.json",
    }
    assert sum(len(data) for _, data in rendered.values()) <= 8 * 1024 * 1024
    sheet = rendered["build-sheet.html"][1]
    assert len(sheet) <= MAX_FILE_BYTES
    assert manifest["inputs"]["generator"] == COMPACT_JSON_GENERATOR
    assert b'&lt;script&gt;&amp;\\"close&lt;/pre&gt;' in sheet
    assert b"<script>" not in sheet and b'</pre>"' not in sheet
    procurement_text = (
        sheet.decode().split("<h2>Frozen procurement policy</h2><pre>", 1)[1].split("</pre>", 1)[0]
    )
    procurement = json.loads(html.unescape(procurement_text))
    assert procurement == {
        "a": {"b": {"c": {"d": {"e": {"groups": {"items": dense}}}}}},
        "hostile": hostile,
    }
    assert render(value)[1] == rendered


@pytest.mark.django_db(transaction=True)
def test_concurrent_initial_settings_updates_share_one_version_zero_lock(users, workspace):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from django.db import close_old_connections, connection

    state = get(users["owner"], workspace)["state_token"]
    gate = Barrier(2)

    def change(label):
        close_old_connections()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_backend_pid()")
                pid = cursor.fetchone()[0]
            gate.wait(timeout=10)
            try:
                update(users["owner"], workspace, {"documents": {"organization": label}}, state)
                return pid, "saved"
            except Conflict:
                return pid, "conflict"
        finally:
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(change, ["Synthetic workshop A", "Synthetic workshop B"]))
    assert len({pid for pid, _ in results}) == 2
    assert sorted(result for _, result in results) == ["conflict", "saved"]
    assert WorkspaceSettings.objects.filter(workspace_id=workspace).count() == 1
    assert get(users["owner"], workspace)["version"] == 1
