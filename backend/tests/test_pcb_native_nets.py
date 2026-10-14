"""Controlled native report acceptance; synthetic outputs are not tool qualification."""

import hashlib
import io
import json
from copy import deepcopy
from uuid import UUID

import pytest
from django.db import DatabaseError, connection, transaction
from django.test import Client

from specmate.access.models import WorkspaceMember
from specmate.builds.models import BuildStage, StageOutput
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    Unsupported,
    ValidationFailed,
)
from specmate.pcb_disagreement.models import SourceNetAttempt, SourceNetInterpretation
from specmate.pcb_disagreement.native_operations import list_native, source_pin
from specmate.pcb_disagreement.pack import REPORT_PATH, XML_PATH, recipe_for
from specmate.pcb_disagreement.queries import inspect_revision
from specmate.pcb_disagreement.xml_extract import normalize_xml
from specmate.sources import blobstore
from specmate.sources.models import SourceBundleFile

from .conftest import member, op, remove_member
from .scope_helpers import workspace_of
from .test_pcb_disagreement import assertion, create, freeze, update
from .test_pcb_disagreement import source_pin as manual_source
from .test_pcb_net_xml import document


@pytest.fixture
def native_request(users, workspace, settings):
    raw = document()
    sha = hashlib.sha256(raw).hexdigest()
    op(
        users["owner"],
        "source.register_blob",
        {
            "workspace_id": workspace_of(workspace),
            "sha256": sha,
            "size": len(raw),
            "media_type": "application/xml",
        },
        attachments={"content": io.BytesIO(raw)},
    )
    bundle = op(
        users["owner"],
        "source.create_original_bundle",
        {
            "workspace_id": workspace_of(workspace),
            "name": "Original synthetic XML",
            "files": [
                {
                    "path": "source.xml",
                    "sha256": sha,
                    "media_type": "application/xml",
                    "rights": "synthetic",
                }
            ],
        },
    )
    file = SourceBundleFile.objects.select_related("revision", "blob").get(
        revision_id=bundle["revision_id"]
    )
    recipe = recipe_for(file.path, file.rights, "netlist")
    settings.SPECMATE_APPROVED_RECIPES = {recipe["id"]: recipe}
    return {
        "workspace_id": workspace_of(workspace),
        "source": source_pin(file),
        "source_role": "netlist",
        "recipe_id": recipe["id"],
    }


def request(user, payload):
    return op(user, "pcb_disagreement.request_native", payload, idempotency_key="native-request")


def output_pair(attempt, mutate=None, output_mutate=None, receipt_mutate=None):
    stage = BuildStage.objects.get(build_id=attempt["build_id"])
    raw = document()
    sha = hashlib.sha256(raw).hexdigest()
    report = {
        "format_version": 1,
        "adapter": "kicad-net-assertions-v1",
        "tool_version": "10.0.6",
        "source_role": "netlist",
        "method": "preserved_netlist_parser",
        "source_sha256": sha,
        "native_format_version": "E",
        "physical_qualification": False,
        **normalize_xml(raw, sha),
    }
    if mutate:
        mutate(report)
    outputs = []
    for path, content, media in (
        (REPORT_PATH, json.dumps(report).encode(), "application/json"),
        (XML_PATH, raw, "application/xml"),
    ):
        staged = blobstore.stage(io.BytesIO(content), 2 * 1024**2)
        blobstore.promote(staged)
        values = {
            "stage": stage,
            "path": path,
            "sha256": staged.sha256,
            "size": staged.size,
            "media_type": media,
            "rights": "synthetic",
            "source_revision_id": stage.build.source_revision_id,
        }
        if output_mutate:
            output_mutate(values)
        output = StageOutput.objects.create(**values)
        outputs.append({"path": output.path, "sha256": output.sha256})
    stage.state = "succeeded"
    stage.receipt = {"outcome": "succeeded", "exit_code": 0, "outputs": outputs}
    if receipt_mutate:
        receipt_mutate(stage.receipt)
    stage.save()


def accept(user, attempt):
    return op(
        user,
        "pcb_disagreement.accept_native",
        {"attempt_id": attempt["attempt_id"]},
        idempotency_key="accept-nets",
    )


def test_acceptance_preserves_outputs_and_manual_disagreement_freezes_without_native_alias(
    users, workspace, native_request
):
    owner = users["owner"]
    attempt = request(owner, native_request)
    assert request(owner, native_request) == attempt
    output_pair(attempt)
    accepted = accept(owner, attempt)
    assert accept(owner, attempt) == accepted
    assert accepted["report"]["method"] == "preserved_netlist_parser"
    manual = freeze(owner, create(owner, workspace, assertion(manual_source(owner, workspace))))
    terminal = next(t for t in accepted["report"]["terminals"] if t["component_ref"] == "J1")
    assert terminal["native_terminal_id"] is None
    value = {
        "kind": "pcb_comparison",
        "left": {
            "kind": "source_net_interpretation",
            "interpretation_id": accepted["interpretation_id"],
            "report_sha256": accepted["report_sha256"],
            "source": accepted["source"],
        },
        "right": {
            "kind": "assertion_revision",
            "revision_id": manual["revision_id"],
            "snapshot_sha256": manual["sha256"],
        },
        "correspondences": [
            {
                "local_id": "reviewed",
                "left_terminal_id": terminal["local_id"],
                "right_terminal_id": "first",
                "basis": "Independent explicit correspondence",
            }
        ],
    }
    draft = create(owner, workspace, value)
    changed = update(owner, draft, value)
    with pytest.raises(Conflict):
        update(owner, draft, value)
    frozen = freeze(owner, changed)
    result = inspect_revision(owner, frozen["revision_id"])
    assert any(f["kind"] == "net_name_difference" for f in result["projection"]["findings"])
    assert (
        result["projection"]["inputs"]["left"]["extractor"]["xml_sha256"]
        == accepted["report"]["xml_sha256"]
    )
    assert list_native(users["viewer"], UUID(workspace))["attempts"][0]["interpretation"] == {
        "interpretation_id": accepted["interpretation_id"],
        "report_sha256": accepted["report_sha256"],
    }
    for model in (SourceNetAttempt, SourceNetInterpretation):
        for statement in ("UPDATE {table} SET id=id", "DELETE FROM {table}"):
            with pytest.raises(DatabaseError, match="immutable record"), transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute(statement.format(table=model._meta.db_table))
    with pytest.raises(DatabaseError), transaction.atomic():
        SourceNetInterpretation.objects.update(sha256="0" * 64)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda r: r.update(source_sha256="0" * 64),
        lambda r: r.update(xml_sha256="0" * 64),
        lambda r: r.update(tool_version="unsupported"),
        lambda r: r.update(method="native_schematic_export"),
        lambda r: r["terminals"][0].update(native_terminal_id="invented"),
        lambda r: r["terminals"][0].update(local_id="invented"),
        lambda r: r["terminals"][0].update(net_state="unconnected", net_name=None),
    ],
)
def test_reject_report_provenance_without_accepting_rows(users, native_request, mutation):
    attempt = request(users["owner"], native_request)
    output_pair(attempt, mutate=mutation)
    with pytest.raises(ValidationFailed):
        accept(users["owner"], attempt)
    assert not SourceNetInterpretation.objects.exists()


@pytest.mark.parametrize("field,value", [("rights", "wrong"), ("media_type", "text/plain")])
def test_reject_output_provenance(users, native_request, field, value):
    attempt = request(users["owner"], native_request)
    output_pair(attempt, output_mutate=lambda values: values.update({field: value}))
    with pytest.raises(ValidationFailed):
        accept(users["owner"], attempt)


def test_missing_or_wrong_receipt_and_client_report_are_not_acceptance(users, native_request):
    owner = users["owner"]
    attempt = request(owner, native_request)
    with pytest.raises(ValidationFailed):
        accept(owner, attempt)
    output_pair(attempt, receipt_mutate=lambda r: r.update(outputs=[]))
    with pytest.raises(ValidationFailed):
        accept(owner, attempt)
    with pytest.raises(ValidationFailed):
        op(
            owner,
            "pcb_disagreement.accept_native",
            {"attempt_id": attempt["attempt_id"], "report": {}},
        )


def test_current_membership_precedes_read_replay_and_diagnostics(users, workspace, native_request):
    editor = users["editor"]
    WorkspaceMember.objects.filter(user=editor, workspace_id=workspace).update(
        grants=["build.execute"]
    )
    attempt = request(editor, native_request)
    output_pair(attempt)
    accepted = accept(editor, attempt)
    remove_member(editor)
    bad = deepcopy(native_request)
    bad["source"]["path"] = "missing.xml"
    bad["source"]["sha256"] = "0" * 64
    for call in (
        lambda: request(editor, native_request),
        lambda: request(editor, bad),
        lambda: accept(editor, attempt),
        lambda: op(
            editor,
            "pcb_disagreement.read_native",
            {"interpretation_id": accepted["interpretation_id"]},
        ),
    ):
        with pytest.raises(NotFound):
            call()
    with pytest.raises(NotFound):
        list_native(editor, UUID(workspace))
    client = Client()
    client.force_login(editor)
    assert (
        client.get("/api/v0/pcb-disagreement/native/" + accepted["interpretation_id"]).status_code
        == 404
    )
    member(editor, "editor", grants=["build.execute"])
    assert (
        op(
            editor,
            "pcb_disagreement.read_native",
            {"interpretation_id": accepted["interpretation_id"]},
        )
        == accepted
    )


def test_only_exact_approved_program_and_permissions_can_request(users, native_request, settings):
    for role in ("editor", "viewer"):
        with pytest.raises(PermissionDenied):
            request(users[role], native_request)
    wrong = deepcopy(settings.SPECMATE_APPROVED_RECIPES)
    wrong[native_request["recipe_id"]]["argv"] = [
        "/usr/bin/python3",
        "-c",
        "print('not the adapter')",
    ]
    settings.SPECMATE_APPROVED_RECIPES = wrong
    with pytest.raises(Unsupported):
        request(users["owner"], native_request)
    assert not SourceNetAttempt.objects.exists()


def test_native_comparison_denies_draft_frozen_and_stored_replay_after_membership_loss(
    users, workspace, native_request
):
    owner, editor = users["owner"], users["editor"]
    attempt = request(owner, native_request)
    output_pair(attempt)
    accepted = accept(owner, attempt)
    native = {
        "kind": "source_net_interpretation",
        "interpretation_id": accepted["interpretation_id"],
        "report_sha256": accepted["report_sha256"],
        "source": accepted["source"],
    }
    value = {"kind": "pcb_comparison", "left": native, "right": native}
    draft = create(editor, workspace, value, idempotency_key="native-compare")
    frozen = freeze(owner, draft)
    unrelated = manual_source(owner, workspace)
    replacement = freeze(owner, create(owner, workspace, assertion(unrelated)))
    from specmate.queries import get_draft

    from .test_pcb_disagreement import pin

    current = get_draft(editor, draft["draft_id"])
    replacement_value = {
        "kind": "pcb_comparison",
        "left": pin(replacement),
        "right": pin(replacement),
    }
    update(editor, current, replacement_value)
    assert get_draft(editor, draft["draft_id"])
    remove_member(editor)
    with pytest.raises(NotFound):
        get_draft(editor, draft["draft_id"])
    with pytest.raises(NotFound):
        create(editor, workspace, value, idempotency_key="native-compare")
    with pytest.raises(NotFound):
        create(editor, workspace, replacement_value, idempotency_key="native-compare")
    with pytest.raises(NotFound):
        inspect_revision(editor, frozen["revision_id"])
    invalid = deepcopy(value)
    invalid["left"]["report_sha256"] = "0" * 64
    with pytest.raises(NotFound):
        create(editor, workspace, invalid)


def test_non_member_denied_before_file_or_recipe_diagnostics(users, workspace, native_request):
    editor = users["editor"]
    member(editor, "editor", grants=["build.execute"])
    remove_member(editor)
    payload = deepcopy(native_request)
    payload["workspace_id"] = workspace
    payload["recipe_id"] = "wrong-recipe"
    client = Client()
    client.force_login(editor)
    responses = []
    for path in ("source.xml", "missing.xml"):
        payload["source"]["path"] = path
        with pytest.raises(NotFound, match="Not found"):
            request(editor, payload)
        response = client.get(
            "/api/v0/pcb-disagreement/native-options",
            {
                "source_revision_id": payload["source"]["source_revision_id"],
                "path": path,
                "role": "netlist",
            },
        )
        responses.append((response.status_code, response.json()))
    assert responses[0] == responses[1]
    assert responses[0][0] == 404
    assert not SourceNetAttempt.objects.exists()


@pytest.mark.parametrize("operation", ["request_native", "accept_native"])
def test_changed_native_payload_authorizes_retained_source_before_key_mismatch(
    users, workspace, native_request, operation
):
    owner, editor = users["owner"], users["editor"]
    WorkspaceMember.objects.filter(user=editor, workspace_id=workspace).update(
        grants=["build.execute"]
    )
    old = request(editor, native_request)
    output_pair(old)
    accept(editor, old)
    # A separate, accessible bundle shares bytes; hashes do not transfer authority.
    other_bundle = op(
        owner,
        "source.create_original_bundle",
        {
            "workspace_id": workspace,
            "name": "Independent accessible native source",
            "files": [
                {
                    "path": "source.xml",
                    "sha256": native_request["source"]["sha256"],
                    "media_type": "application/xml",
                    "rights": "synthetic",
                }
            ],
        },
    )
    file = SourceBundleFile.objects.select_related("revision", "blob").get(
        revision_id=other_bundle["revision_id"]
    )
    changed_request = {**native_request, "source": source_pin(file)}
    other = op(
        editor,
        "pcb_disagreement.request_native",
        changed_request,
        idempotency_key="independent-native-request",
    )
    output_pair(other)
    name = "pcb_disagreement." + operation
    key = "native-request" if operation == "request_native" else "accept-nets"
    payload = (
        changed_request if operation == "request_native" else {"attempt_id": other["attempt_id"]}
    )
    with pytest.raises(IdempotencyMismatch):
        op(editor, name, payload, idempotency_key=key)
    assert list_native(editor, UUID(workspace))["attempts"][0]["attempt_id"] == other["attempt_id"]
    remove_member(editor)
    with pytest.raises(NotFound):
        op(editor, name, payload, idempotency_key=key)
    assert SourceNetAttempt.objects.count() == 2
    assert SourceNetInterpretation.objects.count() == 1
