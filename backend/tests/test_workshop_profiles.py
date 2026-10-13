import hashlib
import json
from pathlib import Path

import pytest
from django.test import Client

from specmate.access.models import Membership
from specmate.design.models import Definition, Draft, Snapshot
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)
from specmate.sources.models import SourceBlob, SourceBundle, SourceBundleFile, SourceBundleRevision
from specmate.workshop_profiles import operations  # noqa: F401
from specmate.workshop_profiles.queries import (
    get_profile,
    list_profile_revisions,
    list_profiles,
    revision_result,
)
from specmate.workshop_profiles.schemas import WorkshopProfile

from .conftest import op

FIXTURE = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "wire-stock-coax.json"


def stock_revision(users, project):
    stock = json.loads(FIXTURE.read_text())["stock"]
    draft = op(
        users["owner"],
        "wire_stock.create",
        {"project_id": project, "name": "Synthetic coax", "stock": stock},
    )
    frozen = op(
        users["owner"],
        "wire_stock.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )
    return frozen["revision_id"], stock


def profile(revision_id, **changes):
    return {
        "stock_revision_id": revision_id,
        "foil_visibility": {
            "value": "hide",
            "basis": "preference",
            "note": "Show the braid clearly.",
        },
        "illustration_lay_length_mm": {"value": None, "basis": "unknown"},
        "element_rules": {
            "stock.jacket": {
                "a": {
                    "cutback_mm": {
                        "value": 12.0,
                        "basis": "documented",
                        "source": {"kind": "citation", "citation": "Synthetic bench instruction A"},
                    }
                }
            }
        },
        **changes,
    }


def create(users, project, body, **ctx):
    return op(
        users["owner"],
        "workshop_profile.create",
        {"project_id": project, "name": "Synthetic preparation", "profile": body},
        **ctx,
    )


def test_profile_requires_typed_frozen_stock_before_writing(users, project):
    draft = op(
        users["owner"],
        "definition.create",
        {"project_id": project, "kind": "wire_stock", "name": "Unspecified construction"},
    )
    revision = op(
        users["owner"],
        "draft.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )
    with pytest.raises(ValidationFailed, match="typed stock revision"):
        create(users, project, profile(revision["revision_id"]))
    assert not Definition.objects.filter(kind="workshop_profile").exists()


def test_profile_has_separate_identity_exact_stock_pin_and_immutable_revision(users, project):
    stock_id, stock = stock_revision(users, project)
    original = profile(stock_id)
    draft = create(users, project, original)
    assert Definition.objects.get(id=draft["definition_id"]).kind == "workshop_profile"
    assert (
        get_profile(users["viewer"], draft["draft_id"])["content"]["profile"]["stock_revision_id"]
        == stock_id
    )
    assert list_profiles(users["viewer"], project)[0]["definition_id"] == draft["definition_id"]
    frozen = op(
        users["owner"],
        "workshop_profile.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )
    snapshot = Snapshot.objects.get(id=frozen["snapshot_id"])
    first_bytes = bytes(snapshot.canonical)
    assert [
        str(value) for value in snapshot.dependencies.values_list("revision_id", flat=True)
    ] == [stock_id]
    assert (
        revision_result(users["viewer"], frozen["revision_id"])["content"]["profile"][
            "foil_visibility"
        ]["value"]
        == "hide"
    )
    changed = profile(
        stock_id,
        foil_visibility={
            "value": "show",
            "basis": "preference",
            "note": "Expose foil in this illustration.",
        },
        illustration_lay_length_mm={
            "value": 25.0,
            "basis": "inferred",
            "note": "Schematic spacing only.",
        },
    )
    update = op(
        users["editor"],
        "workshop_profile.update",
        {"draft_id": draft["draft_id"], "profile": changed},
        expected_state=frozen["draft"]["state"],
    )
    assert update["state"] == "draft-v3"
    assert bytes(Snapshot.objects.get(id=snapshot.id).canonical) == first_bytes
    assert json.loads(first_bytes)["content"]["profile"]["foil_visibility"]["value"] == "hide"
    assert stock["facts"]["impedance"]["value"] is None
    assert "bond" not in json.dumps(changed)


def test_profile_rejects_wrong_paths_and_unknown_as_known(users, project):
    stock_id, _ = stock_revision(users, project)
    before = Definition.objects.filter(kind="workshop_profile").count()
    with pytest.raises(ValidationFailed):
        create(users, project, profile(stock_id, hidden_element_paths=["stock.absent"]))
    with pytest.raises(ValidationFailed):
        create(
            users,
            project,
            profile(
                stock_id,
                foil_visibility={
                    "value": None,
                    "basis": "documented",
                    "source": {"kind": "citation", "citation": "Claim"},
                },
            ),
        )
    with pytest.raises(ValidationFailed):
        create(
            users,
            project,
            profile(stock_id, illustration_lay_length_mm={"value": 20.0, "basis": "unknown"}),
        )
    assert Definition.objects.filter(kind="workshop_profile").count() == before


def test_scope_cas_and_replay_are_enforced(users, project):
    stock_id, _ = stock_revision(users, project)
    body = profile(stock_id)
    draft = create(users, project, body, idempotency_key="profile-create")
    assert create(users, project, body, idempotency_key="profile-create") == draft
    with pytest.raises(IdempotencyMismatch):
        create(
            users,
            project,
            profile(stock_id, hidden_element_paths=["stock.jacket"]),
            idempotency_key="profile-create",
        )
    with pytest.raises(PermissionDenied):
        op(
            users["viewer"],
            "workshop_profile.update",
            {"draft_id": draft["draft_id"], "profile": body},
            expected_state=draft["state"],
        )
    with pytest.raises(NotFound):
        get_profile(users["outsider"], draft["draft_id"])
    with pytest.raises(Conflict):
        op(
            users["editor"],
            "workshop_profile.update",
            {"draft_id": draft["draft_id"], "profile": body},
            expected_state="draft-v0",
        )
    assert Draft.objects.get(id=draft["draft_id"]).version == 1
    with pytest.raises(PermissionDenied):
        op(
            users["editor"],
            "workshop_profile.freeze",
            {"draft_id": draft["draft_id"]},
            expected_state=draft["state"],
        )
    Membership.objects.filter(project_id=project, user=users["owner"]).delete()
    with pytest.raises(NotFound):
        create(users, project, body, idempotency_key="profile-create")


def test_profile_schema_rejects_unfounded_or_unsafe_values():
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        WorkshopProfile.model_validate(
            profile(
                "00000000-0000-0000-0000-000000000001",
                foil_visibility={"value": "hide", "basis": "preference"},
            )
        )
    with pytest.raises(ValidationError):
        WorkshopProfile.model_validate(
            profile(
                "00000000-0000-0000-0000-000000000001",
                omit_occluded={"value": "false", "basis": "preference", "note": "Illustrative"},
            )
        )
    with pytest.raises(ValidationError):
        WorkshopProfile.model_validate(
            profile(
                "00000000-0000-0000-0000-000000000001",
                element_rules={
                    "stock.jacket": {
                        "a": {
                            "cutback_mm": {"value": -1, "basis": "inferred", "note": "Impossible."}
                        }
                    }
                },
            )
        )


def test_generic_commands_keep_profile_validation_and_exact_dependency(users, project):
    stock_id, _ = stock_revision(users, project)
    incomplete = op(
        users["owner"],
        "definition.create",
        {
            "project_id": project,
            "kind": "workshop_profile",
            "name": "Incomplete",
            "content": {},
        },
    )
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "draft.freeze",
            {"draft_id": incomplete["draft_id"]},
            expected_state=incomplete["state"],
        )
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "draft.snapshot",
            {"draft_id": incomplete["draft_id"]},
            expected_state=incomplete["state"],
        )
    with pytest.raises(ValidationFailed):
        op(
            users["editor"],
            "draft.update",
            {
                "draft_id": incomplete["draft_id"],
                "changes": {"profile": profile(stock_id, hidden_element_paths=["stock.absent"])},
            },
            expected_state=incomplete["state"],
        )
    assert Draft.objects.get(id=incomplete["draft_id"]).version == 1
    updated = op(
        users["editor"],
        "draft.update",
        {
            "draft_id": incomplete["draft_id"],
            "changes": {"profile": profile(stock_id)},
        },
        expected_state=incomplete["state"],
    )
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "draft.freeze",
            {
                "draft_id": incomplete["draft_id"],
                "dependencies": ["00000000-0000-0000-0000-000000000001"],
            },
            expected_state=updated["state"],
        )
    frozen = op(
        users["owner"],
        "draft.freeze",
        {
            "draft_id": incomplete["draft_id"],
        },
        expected_state=updated["state"],
    )
    assert [
        str(r)
        for r in Snapshot.objects.get(id=frozen["snapshot_id"]).dependencies.values_list(
            "revision_id", flat=True
        )
    ] == [stock_id]
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "definition.create",
            {
                "project_id": project,
                "kind": "generic",
                "name": "Wrong kind",
                "content": {"profile": profile(stock_id)},
            },
        )


def test_registered_source_digest_and_rights_are_checked_on_profile_read(users, project):
    stock_id, _ = stock_revision(users, project)
    source_path = " instructions/strip.txt "
    raw = b"synthetic workshop instruction\n"
    digest = hashlib.sha256(raw).hexdigest()
    blob = SourceBlob.objects.create(
        project_id=project,
        sha256=digest,
        size=len(raw),
        media_type="text/plain",
        registered_by=users["owner"],
    )
    bundle = SourceBundle.objects.create(
        project_id=project, name="Synthetic source", role="original", created_by=users["owner"]
    )
    revision = SourceBundleRevision.objects.create(
        bundle=bundle,
        number=1,
        manifest=b"{}",
        manifest_sha256=hashlib.sha256(b"{}").hexdigest(),
        created_by=users["owner"],
    )
    SourceBundleFile.objects.create(
        revision=revision,
        path=source_path,
        blob=blob,
        media_type="text/plain",
        rights="synthetic-test",
    )
    source = {
        "kind": "source_file",
        "bundle_revision_id": str(revision.id),
        "path": source_path,
        "locator": "line 1",
        "sha256": digest,
        "rights": "synthetic-test",
    }
    documented = profile(
        stock_id, foil_visibility={"value": "hide", "basis": "documented", "source": source}
    )
    draft = create(users, project, documented, idempotency_key="documented-profile")
    assert (
        get_profile(users["viewer"], draft["draft_id"])["content"]["profile"]["foil_visibility"][
            "source"
        ]
        == source
    )
    with pytest.raises(NotFound):
        create(
            users,
            project,
            profile(
                stock_id,
                foil_visibility={
                    "value": "hide",
                    "basis": "documented",
                    "source": {**source, "path": source_path.strip()},
                },
            ),
        )
    for key, bad in [("sha256", "0" * 64), ("rights", "different")]:
        altered = {**source, key: bad}
        with pytest.raises(ValidationFailed):
            create(
                users,
                project,
                profile(
                    stock_id,
                    foil_visibility={"value": "hide", "basis": "documented", "source": altered},
                ),
            )
    with pytest.raises(NotFound):
        create(
            users,
            project,
            profile(
                stock_id,
                foil_visibility={
                    "value": "hide",
                    "basis": "documented",
                    "source": {**source, "path": "instructions/missing.txt"},
                },
            ),
        )
    op(
        users["editor"],
        "workshop_profile.update",
        {"draft_id": draft["draft_id"], "profile": profile(stock_id)},
        expected_state=draft["state"],
    )
    other_project = op(users["owner"], "project.create", {"name": "Separate project"})["project_id"]
    bundle.project_id = other_project
    bundle.save(update_fields=["project"])
    with pytest.raises(ValidationFailed):
        create(users, project, documented, idempotency_key="documented-profile")


def test_http_adapter_lists_and_reads_exact_profile_revision(users, project):
    stock_id, _ = stock_revision(users, project)
    client = Client()
    client.force_login(users["owner"])
    response = client.post(
        "/api/v0/operations",
        data=json.dumps(
            {
                "operation": "workshop_profile.create",
                "request_id": "profile-http-1",
                "payload": {
                    "project_id": project,
                    "name": "Synthetic display",
                    "profile": profile(stock_id),
                },
            }
        ),
        content_type="application/json",
    )
    assert response.status_code == 200, response.content
    draft = response.json()["result"]
    listed = client.get(f"/api/v0/projects/{project}/workshop-profiles")
    assert listed.status_code == 200
    assert listed.json()[0]["definition_id"] == draft["definition_id"]
    frozen = op(
        users["owner"],
        "workshop_profile.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )
    exact = client.get(f"/api/v0/workshop-profile-revisions/{frozen['revision_id']}")
    assert exact.status_code == 200
    assert exact.json()["content"]["profile"]["stock_revision_id"] == stock_id
    assert len(list_profile_revisions(users["viewer"], draft["definition_id"])) == 1
    with pytest.raises(NotFound):
        list_profile_revisions(users["outsider"], draft["definition_id"])
