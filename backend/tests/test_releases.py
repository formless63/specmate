"""ACC-EVD-004: a reviewed release freezes its exact closure and unresolved items.

A release is reconstructable from its pins and retained archive, and cannot silently adopt
a later model revision. Synthetic generic definitions on real PostgreSQL; no native tool
runs and nothing here is physical qualification.
"""

import base64
import hashlib
from uuid import UUID

import pytest
from django.db import DatabaseError, transaction

from specmate.design.models import Draft
from specmate.operations import Conflict, NotFound, PermissionDenied, ValidationFailed
from specmate.releases.models import Release, ReleaseConfiguration, ReleasePin

from .conftest import op
from .scope_helpers import workspace_of
from .test_assemblies import create as create_assembly
from .test_assemblies import freeze as freeze_assembly
from .test_assemblies import occ
from .test_configurations import capture, option_set_content, select
from .test_configurations import configuration as create_configuration
from .test_facts import append, fact, subject
from .test_transports import api, post_op


def define(user, project, name, content=None, kind="component"):
    created = op(
        user,
        "definition.create",
        {
            "workspace_id": workspace_of(project),
            "kind": kind,
            "name": name,
            "content": content or {},
        },
    )
    return created, op(
        user, "draft.freeze", {"draft_id": created["draft_id"]}, expected_state=created["state"]
    )


def revise(user, draft_id, changes):
    """Edit the definition's draft and freeze the next exact revision."""
    state = Draft.objects.get(id=draft_id).state_token
    updated = op(
        user, "draft.update", {"draft_id": draft_id, "changes": changes}, expected_state=state
    )
    return op(user, "draft.freeze", {"draft_id": draft_id}, expected_state=updated["state"])


@pytest.fixture
def closure(users, project):
    """Root assembly pinning sensor r2; r1 carries a revision claim that is now stale."""
    owner = users["owner"]
    sensor_draft, sensor_r1 = define(owner, project, "Synthetic sensor", {"variant": 1})
    claim = append(
        owner,
        subject(owner, {"kind": "revision", "revision_id": sensor_r1["revision_id"]}),
        fact(
            "continuity_checked",
            role="actual",
            value={"kind": "boolean", "value": True},
            provenance={
                "method": "source_observation",
                "evidence": [{"kind": "citation", "citation": "Synthetic review note"}],
            },
        ),
    )
    sensor_r2 = revise(owner, sensor_draft["draft_id"], {"variant": 2})
    _, alternative = define(owner, project, "Synthetic alternative sensor")
    root = freeze_assembly(owner, create_assembly(owner, project, [occ("sensor", sensor_r2, "U1")]))
    options = op(
        owner,
        "definition.create",
        {
            "workspace_id": workspace_of(project),
            "kind": "option_set",
            "name": "Synthetic release options",
            "content": option_set_content([sensor_r2, alternative], target=root["revision_id"]),
        },
    )
    options_revision = op(
        owner, "draft.freeze", {"draft_id": options["draft_id"]}, expected_state=options["state"]
    )
    draft = create_configuration(owner, project, options_revision["revision_id"])
    select(
        owner,
        draft,
        [
            {"option_key": "sensor", "choice_key": "a"},
            {"option_key": "finish", "choice_key": "bead"},
        ],
    )
    resolved = capture(owner, draft["draft_id"])
    return {
        "root": root,
        "sensor_draft": sensor_draft,
        "sensor_r1": sensor_r1,
        "sensor_r2": sensor_r2,
        "claim": claim,
        "configuration": resolved,
        "project": project,
    }


def request(closure, **changes):
    body = {
        "root_revision_id": closure["root"]["revision_id"],
        "quantity": 2,
        "resolved_configuration_ids": [closure["configuration"]["resolved_configuration_id"]],
        "rights_reviews": [
            {"subject": f"design:{rid}", "decision": "permitted", "basis": "Synthetic original"}
            for rid in (closure["root"]["revision_id"], closure["sensor_r2"]["revision_id"])
        ],
    }
    return {**body, **changes}


def review(user, payload):
    return op(user, "release.review", payload)


def release(user, payload, reviewed, **extra):
    return op(
        user,
        "release.create",
        {**payload, "name": "Synthetic release A", "reviewed_sha256": reviewed["sha256"], **extra},
    )


def categories(reviewed):
    return {row["category"] for row in reviewed["review"]["unresolved"]}


ACK = {"acknowledgement": {"reason": "Synthetic evaluation release; open items tracked."}}


def test_release_freezes_exact_closure_and_is_reconstructable(users, closure):
    payload = request(closure)
    reviewed = review(users["viewer"], payload)
    body = reviewed["review"]
    root_id, sensor_id = closure["root"]["revision_id"], closure["sensor_r2"]["revision_id"]
    assert {r["revision_id"]: r["role"] for r in body["revisions"]} == {
        root_id: "root",
        sensor_id: "occurrence",
    }
    # Configuration choices are pinned with exact hashes; artifacts carry the package hash.
    [config] = body["configurations"]
    assert config["target_revision_id"] == root_id and config["status"] == "complete"
    assert body["artifacts"]["coherence"] == "coherent"
    assert body["rights"]["uncleared"] == 0 and body["rights"]["cleared"] == 2
    # The stale claim about r1 is listed even though everything else is resolved.
    assert categories(reviewed) == {"evidence"}
    [stale] = body["unresolved"]
    assert stale["status"] == "stale_earlier_revision"
    assert stale["evidence_id"] == f"fact:{closure['claim']['assertion']['assertion_id']}"
    assert body["semantics"]["physical_qualification"] == "not_evaluated"

    created = release(users["editor"], payload, reviewed, **ACK)
    assert created["status"] == "unresolved" and created["unresolved_count"] == 1
    assert created["record"]["review"] == body
    assert created["record"]["acknowledgement"]["unresolved_ids"] == [stale["id"]]
    row = Release.objects.get(id=created["release_id"])
    assert hashlib.sha256(bytes(row.record_canonical)).hexdigest() == row.record_sha256
    assert set(ReleasePin.objects.filter(release=row).values_list("revision_id", "role")) == {
        (row.root_revision_id, "root"),
        (UUID(sensor_id), "occurrence"),
    }
    assert ReleaseConfiguration.objects.filter(release=row).count() == 1

    verified = op(users["viewer"], "release.verify", {"release_id": created["release_id"]})
    assert verified == {
        "release_id": created["release_id"],
        "status": "verified",
        "reconstruction": "identical",
        "problems": [],
        "pins": 2,
        "configurations": 1,
    }
    archive = op(users["viewer"], "release.download", {"release_id": created["release_id"]})
    data = base64.b64decode(archive["archive_base64"])
    assert hashlib.sha256(data).hexdigest() == archive["sha256"] == row.archive_sha256
    assert archive["manifest_sha256"] == body["artifacts"]["package_manifest_sha256"]

    # The approval record is immutable in the database.
    for statement in (
        lambda: Release.objects.filter(id=row.id).update(name="Edited"),
        lambda: ReleasePin.objects.filter(release=row).delete(),
        lambda: Release.objects.filter(id=row.id).delete(),
    ):
        with pytest.raises(DatabaseError), transaction.atomic():
            statement()


def test_unresolved_items_need_explicit_acknowledgement_with_reason(users, closure):
    payload = request(closure, quantity=None, rights_reviews=[])
    reviewed = review(users["editor"], payload)
    assert reviewed["review"]["status"] == "unresolved"
    assert categories(reviewed) == {"quantity", "evidence", "rights"}
    rights = [r for r in reviewed["review"]["unresolved"] if r["category"] == "rights"]
    assert {r["decision"] for r in rights} == {"unknown"} and len(rights) == 2
    with pytest.raises(ValidationFailed, match="acknowledgement"):
        release(users["editor"], payload, reviewed)
    with pytest.raises(ValidationFailed):
        release(users["editor"], payload, reviewed, acknowledgement={"reason": "   "})
    assert not Release.objects.exists()
    created = release(users["editor"], payload, reviewed, **ACK)
    assert created["unresolved_count"] == len(reviewed["review"]["unresolved"])
    assert created["record"]["acknowledgement"]["reason"] == ACK["acknowledgement"]["reason"]


def test_release_cannot_silently_adopt_a_later_model_revision(users, closure):
    payload = request(closure)
    reviewed = review(users["editor"], payload)
    created = release(users["editor"], payload, reviewed, **ACK)
    recorded = Release.objects.get(id=created["release_id"])

    # A later model revision appears after the release.
    sensor_r3 = revise(users["owner"], closure["sensor_draft"]["draft_id"], {"variant": 3})
    read = op(users["viewer"], "release.read", {"release_id": created["release_id"]})
    assert read["record"] == created["record"]
    assert Release.objects.get(id=recorded.id).record_sha256 == recorded.record_sha256
    pinned = {r["revision_id"] for r in read["record"]["review"]["revisions"]}
    assert closure["sensor_r2"]["revision_id"] in pinned
    assert sensor_r3["revision_id"] not in pinned
    verified = op(users["viewer"], "release.verify", {"release_id": created["release_id"]})
    assert verified["status"] == "verified" and verified["reconstruction"] == "identical"

    # A fresh review of the same root still pins r2 and reports, not adopts, r3.
    again = review(users["editor"], payload)
    sensor = next(
        r
        for r in again["review"]["revisions"]
        if r["revision_id"] == closure["sensor_r2"]["revision_id"]
    )
    assert sensor["later_revision_number"] == sensor_r3["number"]
    # The earlier review hash no longer matches the closure: re-review is required.
    with pytest.raises(Conflict) as exc:
        release(users["editor"], payload, reviewed, **ACK)
    assert exc.value.details["current_sha256"] == again["sha256"]


def test_blockers_prevent_release_even_with_acknowledgement(users, closure, project):
    owner = users["owner"]
    _, other_part = define(owner, project, "Synthetic unrelated part")
    other_root = freeze_assembly(owner, create_assembly(owner, project, [occ("p", other_part)]))
    options = op(
        owner,
        "definition.create",
        {
            "workspace_id": workspace_of(project),
            "kind": "option_set",
            "name": "Synthetic foreign-target options",
            "content": option_set_content(
                [closure["sensor_r2"], closure["sensor_r2"]], target=other_root["revision_id"]
            ),
        },
    )
    frozen = op(
        owner, "draft.freeze", {"draft_id": options["draft_id"]}, expected_state=options["state"]
    )
    draft = create_configuration(owner, project, frozen["revision_id"])
    select(owner, draft, [{"option_key": "finish", "choice_key": "paint"}])
    resolved = capture(owner, draft["draft_id"])
    payload = request(closure, resolved_configuration_ids=[resolved["resolved_configuration_id"]])
    reviewed = review(users["editor"], payload)
    assert reviewed["review"]["status"] == "blocked"
    assert any(b["id"].endswith("target_not_in_release") for b in reviewed["review"]["blockers"])
    with pytest.raises(ValidationFailed, match="blockers"):
        release(users["editor"], payload, reviewed, **ACK)
    assert not Release.objects.exists()


def test_authority_scope_project_reference_and_replay(users, closure):
    payload = request(closure)
    reviewed = review(users["viewer"], payload)
    with pytest.raises(PermissionDenied):
        release(users["viewer"], payload, reviewed, **ACK)
    with pytest.raises(PermissionDenied):
        release(users["contributor"], payload, reviewed, **ACK)
    with pytest.raises(NotFound):
        review(users["outsider"], payload)
    with pytest.raises(ValidationFailed):
        review(
            users["editor"],
            {
                **payload,
                "rights_reviews": [
                    {
                        "subject": "design:00000000-0000-0000-0000-000000000000",
                        "decision": "unknown",
                    }
                ],
            },
        )

    foreign = op(users["outsider"], "project.create", {"name": "Synthetic foreign bench"})
    with pytest.raises(NotFound):
        release(users["editor"], payload, reviewed, project_id=foreign["project_id"], **ACK)
    assert not Release.objects.exists()

    project = closure["project"]
    created = op(
        users["editor"],
        "release.create",
        {
            **payload,
            "name": "Synthetic release B",
            "reviewed_sha256": reviewed["sha256"],
            "project_id": project,
            **ACK,
        },
        idempotency_key="release-b",
    )
    replay = op(
        users["editor"],
        "release.create",
        {
            **payload,
            "name": "Synthetic release B",
            "reviewed_sha256": reviewed["sha256"],
            "project_id": project,
            **ACK,
        },
        idempotency_key="release-b",
    )
    assert replay["release_id"] == created["release_id"]
    assert Release.objects.count() == 1

    listed = op(
        users["viewer"],
        "release.list",
        {"workspace_id": workspace_of(project), "project_id": project},
    )
    assert [r["release_id"] for r in listed["releases"]] == [created["release_id"]]
    projected = op(users["viewer"], "project.references", {"project_id": project})
    [reference] = [r for r in projected["references"] if r["kind"] == "release"]
    assert reference["target_id"] == created["release_id"] and reference["pin"] == "exact"

    with pytest.raises(NotFound):
        op(users["outsider"], "release.read", {"release_id": created["release_id"]})
    with pytest.raises(NotFound):
        op(users["outsider"], "release.download", {"release_id": created["release_id"]})

    response = api(users["viewer"]).post(
        "/api/v0/releases/download",
        {"release_id": created["release_id"]},
        content_type="application/json",
    )
    assert response.status_code == 200
    assert hashlib.sha256(response.content).hexdigest() == created["archive_sha256"]
    response = post_op(api(users["viewer"]), "release.read", {"release_id": created["release_id"]})
    assert response.status_code == 200
