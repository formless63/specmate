"""ACC-CFG-001: a build receives an exact resolved snapshot, not mutable option defaults.

Synthetic generic definitions and the shared PCB population/firmware fixtures on real
PostgreSQL. Compatibility is never inferred; no native tool runs.
"""

import json

import pytest
from django.db import DatabaseError, connection, transaction

from specmate.configurations.models import ResolvedConfiguration
from specmate.design.models import Snapshot, SnapshotDependency
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)

from .conftest import ensure_member, op, remove_member
from .scope_helpers import workspace_of
from .test_firmware import (  # noqa: F401
    CONFIG,
    MAIN,
    attempt,
    board,
    declaration,
    digest,
    intake,
    recipe,
    source,
    sources,
)
from .test_firmware_occurrences import frozen_firmware, pair  # noqa: F401
from .test_transports import api, post_op


def frozen(user, project, name, kind="component", content=None):
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
    revision = op(
        user, "draft.freeze", {"draft_id": created["draft_id"]}, expected_state=created["state"]
    )
    return {**created, **revision}


def option_set_content(parts, *, default="a", target=None, extra=()):
    return {
        "option_set": {
            "target_revision_id": target,
            "options": [
                {
                    "key": "sensor",
                    "label": "Sensor part",
                    "domain": "part",
                    "default_choice": default,
                    "choices": [
                        {"key": "a", "label": "Sensor A", "revision_id": parts[0]["revision_id"]},
                        {"key": "b", "label": "Sensor B", "revision_id": parts[1]["revision_id"]},
                    ],
                },
                {
                    "key": "finish",
                    "label": "Enclosure finish",
                    "domain": "process",
                    "choices": [
                        {"key": "bead", "label": "Bead blast", "value": "bead-blast"},
                        {"key": "paint", "label": "Painted", "value": "powder-coat"},
                    ],
                },
                {
                    "key": "sealing",
                    "label": "Sealing requirement",
                    "domain": "requirement",
                    "required": False,
                    "choices": [{"key": "splash", "label": "Splash", "value": "splash-resistant"}],
                },
                *extra,
            ],
        }
    }


@pytest.fixture
def parts(users, project):
    return [frozen(users["owner"], project, f"Synthetic sensor {n}") for n in ("A", "B")]


@pytest.fixture
def option_set(users, project, parts):
    created = op(
        users["owner"],
        "definition.create",
        {
            "workspace_id": workspace_of(project),
            "kind": "option_set",
            "name": "Synthetic sensor node options",
            "content": option_set_content(parts),
        },
    )
    revision = op(
        users["owner"],
        "draft.freeze",
        {"draft_id": created["draft_id"]},
        expected_state=created["state"],
    )
    return {**created, **revision}


def configuration(user, project, option_set_revision, selections=()):
    return op(
        user,
        "definition.create",
        {
            "workspace_id": workspace_of(project),
            "kind": "configuration",
            "name": "Synthetic build configuration",
            "content": {
                "configuration": {
                    "option_set_revision_id": option_set_revision,
                    "selections": list(selections),
                }
            },
        },
    )


def select(user, draft, selections, **changes):
    current = op(user, "configuration.resolve", {"draft_id": draft["draft_id"]})
    body = {**current["configuration"], "selections": selections, **changes}
    return op(
        user,
        "draft.update",
        {"draft_id": draft["draft_id"], "changes": {"configuration": body}},
        expected_state=current["state"],
    )


def capture(user, draft_id, basis="Reviewed synthetic resolution", **ctx):
    reviewed = op(user, "configuration.resolve", {"draft_id": draft_id})
    return op(
        user,
        "configuration.capture",
        {"draft_id": draft_id, "review_sha256": reviewed["review_sha256"], "basis": basis},
        expected_state=reviewed["state"],
        **ctx,
    )


def decisions(result):
    return {d["option_key"]: d for d in result["resolution"]["decisions"]}


def test_resolution_is_explicit_and_build_input_requires_complete_exact_snapshot(
    users, project, parts, option_set
):
    draft = configuration(users["editor"], project, option_set["revision_id"])
    preview = op(users["viewer"], "configuration.resolve", {"draft_id": draft["draft_id"]})
    by_key = decisions(preview)
    assert by_key["sensor"]["status"] == "resolved"
    assert by_key["sensor"]["source"] == "default"
    assert by_key["sensor"]["choice"]["revision"]["revision_id"] == parts[0]["revision_id"]
    assert by_key["finish"] == {**by_key["finish"], "status": "unresolved", "choice": None}
    assert by_key["sealing"]["status"] == "none" and by_key["sealing"]["source"] == "not_selected"
    assert preview["resolution"]["status"] == "incomplete"
    assert preview["resolution"]["compatibility"] == "not_evaluated"
    assert {o["option_key"] for o in preview["available"]} == {"sensor", "finish", "sealing"}

    partial = capture(users["editor"], draft["draft_id"])
    assert partial["status"] == "incomplete"
    with pytest.raises(ValidationFailed) as refused:
        op(
            users["viewer"],
            "configuration.build_input",
            {"resolved_configuration_id": partial["resolved_configuration_id"]},
        )
    assert refused.value.details == {"unresolved": ["finish"]}

    select(
        users["editor"],
        draft,
        [
            {"option_key": "finish", "choice_key": "paint"},
            {"option_key": "sealing", "choice_key": None},
        ],
    )
    complete = capture(users["editor"], draft["draft_id"])
    assert complete["status"] == "complete"
    built = op(
        users["viewer"],
        "configuration.build_input",
        {"resolved_configuration_id": complete["resolved_configuration_id"]},
    )
    choices = {c["option_key"]: c for c in built["choices"]}
    assert choices["sensor"]["revision_id"] == parts[0]["revision_id"]
    assert choices["sensor"]["source"] == "default"
    assert choices["finish"]["value"] == "powder-coat"
    assert choices["sealing"] == {**choices["sealing"], "status": "none", "source": "explicit_none"}
    assert {p["revision_id"] for p in built["pins"]} == {
        option_set["revision_id"],
        parts[0]["revision_id"],
    }
    snapshot = Snapshot.objects.get(id=complete["snapshot_id"])
    assert built["snapshot_sha256"] == snapshot.sha256
    assert json.loads(bytes(snapshot.canonical))["kind"] == "configuration"
    history = op(users["viewer"], "configuration.resolve", {"draft_id": draft["draft_id"]})
    assert [r["status"] for r in history["resolved"]] == ["complete", "incomplete"]
    # The exact snapshot resolves identically under current authority.
    exact = op(users["viewer"], "configuration.resolve", {"snapshot_id": complete["snapshot_id"]})
    assert exact["resolution"] == complete["resolution"]


def test_later_defaults_and_revisions_never_change_a_captured_resolution(
    users, project, parts, option_set
):
    draft = configuration(
        users["editor"],
        project,
        option_set["revision_id"],
        [{"option_key": "finish", "choice_key": "bead"}],
    )
    first = capture(users["editor"], draft["draft_id"])
    assert first["status"] == "complete"
    # Mutate the option-set draft default and freeze revision 2.
    changed = op(
        users["owner"],
        "draft.update",
        {
            "draft_id": option_set["draft"]["draft_id"],
            "changes": option_set_content(parts, default="b"),
        },
        expected_state=option_set["draft"]["state"],
    )
    second_set = op(
        users["owner"],
        "draft.freeze",
        {"draft_id": option_set["draft"]["draft_id"]},
        expected_state=changed["state"],
    )
    # A newer revision of the chosen part does not move the exact pin either.
    part_draft = op(
        users["owner"],
        "draft.update",
        {"draft_id": parts[0]["draft_id"], "changes": {"note": "later"}},
        expected_state=parts[0]["draft"]["state"],
    )
    op(
        users["owner"],
        "draft.freeze",
        {"draft_id": parts[0]["draft_id"]},
        expected_state=part_draft["state"],
    )

    still = op(users["viewer"], "configuration.resolve", {"draft_id": draft["draft_id"]})
    assert decisions(still)["sensor"]["choice"]["key"] == "a"
    select(
        users["editor"],
        draft,
        [{"option_key": "finish", "choice_key": "bead"}],
        option_set_revision_id=second_set["revision_id"],
    )
    later = capture(users["editor"], draft["draft_id"])
    assert (
        decisions(later)["sensor"]["choice"]["revision"]["revision_id"] == parts[1]["revision_id"]
    )
    assert decisions(later)["sensor"]["reason"] == "Default declared by option-set revision 2."

    original = op(
        users["viewer"],
        "configuration.build_input",
        {"resolved_configuration_id": first["resolved_configuration_id"]},
    )
    sensor = next(c for c in original["choices"] if c["option_key"] == "sensor")
    assert sensor["revision_id"] == parts[0]["revision_id"]
    assert original["option_set_revision_id"] == option_set["revision_id"]
    retained = op(
        users["viewer"],
        "configuration.read_resolved",
        {"resolved_configuration_id": first["resolved_configuration_id"]},
    )
    assert retained["resolution"] == first["resolution"]


def test_invalid_selections_and_content_are_rejected(users, project, parts, option_set):
    draft = configuration(
        users["editor"],
        project,
        option_set["revision_id"],
        [
            {"option_key": "finish", "choice_key": "chrome"},
            {"option_key": "colour", "choice_key": "x"},
        ],
    )
    preview = op(users["editor"], "configuration.resolve", {"draft_id": draft["draft_id"]})
    assert preview["resolution"]["status"] == "invalid"
    assert [i["option_key"] for i in preview["resolution"]["invalid_selections"]] == [
        "colour",
        "finish",
    ]
    with pytest.raises(ValidationFailed):
        capture(users["editor"], draft["draft_id"])
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "draft.freeze",
            {"draft_id": draft["draft_id"]},
            expected_state=draft["state"],
        )
    assert not ResolvedConfiguration.objects.exists()

    def create(kind, content):
        return op(
            users["owner"],
            "definition.create",
            {
                "workspace_id": workspace_of(project),
                "kind": kind,
                "name": "Synthetic invalid",
                "content": content,
            },
        )

    both = option_set_content(parts)
    both["option_set"]["options"][1]["choices"][0]["revision_id"] = parts[0]["revision_id"]
    no_path = option_set_content(
        parts,
        extra=[
            {
                "key": "fw",
                "label": "Firmware",
                "domain": "firmware",
                "choices": [{"key": "x", "label": "X", "revision_id": parts[0]["revision_id"]}],
            }
        ],
    )
    nested = option_set_content([parts[0], option_set])
    for kind, content in (
        ("option_set", both),
        ("option_set", no_path),
        ("option_set", nested),
        ("option_set", {}),
        ("component", option_set_content(parts)),
        ("configuration", {"configuration": {"option_set_revision_id": parts[0]["revision_id"]}}),
    ):
        with pytest.raises(ValidationFailed):
            create(kind, content)
    missing = option_set_content(parts)
    missing["option_set"]["options"][0]["choices"][0]["revision_id"] = parts[0]["draft_id"]
    with pytest.raises(NotFound):
        create("option_set", missing)
    with pytest.raises(ValidationFailed):
        op(users["editor"], "configuration.resolve", {"draft_id": parts[0]["draft_id"]})
    with pytest.raises(ValidationFailed):
        op(users["editor"], "configuration.resolve", {})


def test_authority_cross_workspace_and_stale_review(users, project, parts, option_set):
    draft = configuration(users["editor"], project, option_set["revision_id"])
    reviewed = op(users["viewer"], "configuration.resolve", {"draft_id": draft["draft_id"]})
    payload = {
        "draft_id": draft["draft_id"],
        "review_sha256": reviewed["review_sha256"],
        "basis": "Synthetic",
    }
    with pytest.raises(PermissionDenied):
        op(users["viewer"], "configuration.capture", payload, expected_state=reviewed["state"])
    with pytest.raises(NotFound):
        op(users["outsider"], "configuration.resolve", {"draft_id": draft["draft_id"]})
    with pytest.raises(NotFound):
        op(
            users["outsider"],
            "configuration.capture",
            payload,
            expected_state=reviewed["state"],
            idempotency_key="k-out",
        )
    with pytest.raises(Conflict):
        op(
            users["editor"],
            "configuration.capture",
            {**payload, "review_sha256": "0" * 64},
            expected_state=reviewed["state"],
        )
    select(users["editor"], draft, [{"option_key": "finish", "choice_key": "bead"}])
    with pytest.raises(Conflict):
        op(users["editor"], "configuration.capture", payload, expected_state=reviewed["state"])
    assert not ResolvedConfiguration.objects.exists()

    done = capture(users["editor"], draft["draft_id"])
    ref = {"resolved_configuration_id": done["resolved_configuration_id"]}
    for name in ("configuration.read_resolved", "configuration.build_input"):
        with pytest.raises(NotFound):
            op(users["outsider"], name, ref)
    with pytest.raises(NotFound):
        op(users["outsider"], "configuration.resolve", {"snapshot_id": done["snapshot_id"]})

    # A foreign workspace's option set never resolves, even for an actor in both
    # workspaces: the pin reads as missing before the database guard.
    other = op(users["outsider"], "project.create", {"name": "Synthetic other bench"})["project_id"]
    foreign_parts = [frozen(users["outsider"], other, f"Foreign {n}") for n in "AB"]
    foreign = frozen(
        users["outsider"], other, "Foreign options", "option_set", option_set_content(foreign_parts)
    )
    with pytest.raises(NotFound):
        configuration(users["editor"], project, foreign["revision_id"])
    ensure_member(users["editor"], "viewer", project=other)
    with pytest.raises(NotFound, match=r"^Not found\.$"):
        configuration(users["editor"], project, foreign["revision_id"])
    # Same-workspace reuse of a shared option set resolves and captures.
    shared = configuration(users["editor"], project, option_set["revision_id"])
    assert (
        op(users["editor"], "configuration.resolve", {"draft_id": shared["draft_id"]})[
            "resolution"
        ]["status"]
        == "incomplete"
    )
    shared_capture = capture(users["editor"], shared["draft_id"])
    # Losing membership hides the retained record and the draft closure.
    remove_member(users["editor"], project=project)
    with pytest.raises(NotFound):
        op(
            users["editor"],
            "configuration.read_resolved",
            {"resolved_configuration_id": shared_capture["resolved_configuration_id"]},
        )
    with pytest.raises(NotFound):
        op(users["editor"], "configuration.resolve", {"draft_id": shared["draft_id"]})


def test_idempotent_capture_replay_mismatch_and_rollback(users, project, option_set, monkeypatch):
    draft = configuration(
        users["editor"],
        project,
        option_set["revision_id"],
        [{"option_key": "finish", "choice_key": "bead"}],
    )
    reviewed = op(users["editor"], "configuration.resolve", {"draft_id": draft["draft_id"]})
    payload = {
        "draft_id": draft["draft_id"],
        "review_sha256": reviewed["review_sha256"],
        "basis": "Synthetic",
    }
    first = op(
        users["editor"],
        "configuration.capture",
        payload,
        expected_state=reviewed["state"],
        idempotency_key="cap-1",
    )
    again = op(
        users["editor"],
        "configuration.capture",
        payload,
        expected_state=reviewed["state"],
        idempotency_key="cap-1",
    )
    assert again == first
    assert ResolvedConfiguration.objects.count() == 1
    with pytest.raises(IdempotencyMismatch):
        op(
            users["editor"],
            "configuration.capture",
            {**payload, "basis": "Different"},
            expected_state=reviewed["state"],
            idempotency_key="cap-1",
        )
    with pytest.raises(PermissionDenied):
        op(
            users["viewer"],
            "configuration.capture",
            payload,
            expected_state=reviewed["state"],
            idempotency_key="cap-1",
        )

    snapshots, pins = Snapshot.objects.count(), SnapshotDependency.objects.count()

    def broken(*args, **kwargs):
        raise RuntimeError("synthetic failure after snapshot capture")

    monkeypatch.setattr(ResolvedConfiguration.objects, "create", broken)
    with pytest.raises(RuntimeError):
        op(
            users["editor"],
            "configuration.capture",
            payload,
            expected_state=reviewed["state"],
            idempotency_key="cap-2",
        )
    assert (Snapshot.objects.count(), SnapshotDependency.objects.count()) == (snapshots, pins)
    assert ResolvedConfiguration.objects.count() == 1


def test_database_keeps_resolution_evidence_immutable_and_consistent(users, project, option_set):
    draft = configuration(
        users["editor"],
        project,
        option_set["revision_id"],
        [{"option_key": "finish", "choice_key": "bead"}],
    )
    done = capture(users["editor"], draft["draft_id"])
    row = ResolvedConfiguration.objects.get(id=done["resolved_configuration_id"])
    for statement in (
        "UPDATE configurations_resolvedconfiguration SET basis = 'x' WHERE id = %s",
        "DELETE FROM configurations_resolvedconfiguration WHERE id = %s",
    ):
        with pytest.raises(DatabaseError), transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute(statement, [row.id])
    tampered = {**row.resolution, "status": "incomplete"}
    with pytest.raises(DatabaseError), transaction.atomic():
        ResolvedConfiguration.objects.create(
            workspace_id=row.workspace_id,
            draft_id=row.draft_id,
            draft_version=row.draft_version,
            snapshot=Snapshot.objects.get(
                id=op(
                    users["editor"],
                    "draft.snapshot",
                    {"draft_id": draft["draft_id"]},
                    expected_state=row.draft.state_token,
                )["snapshot_id"]
            ),
            option_set_revision_id=row.option_set_revision_id,
            status="complete",
            resolution=tampered,
            resolution_canonical=bytes(row.resolution_canonical),
            resolution_sha256=row.resolution_sha256,
            review_sha256=row.review_sha256,
            basis="tampered",
            created_by=users["editor"],
        )


def test_population_and_firmware_choices_pin_exact_occurrence_revisions(
    users,
    project,
    sources,  # noqa: F811
    board,  # noqa: F811
    pair,  # noqa: F811
):
    assembly, first, second = pair
    target = op(
        users["owner"],
        "assembly.freeze",
        {"draft_id": assembly["draft_id"]},
        expected_state=assembly["state"],
    )
    target_sha = Snapshot.objects.get(id=target["snapshot_id"]).sha256
    population = board[0]["revision_id"]
    content = {
        "option_set": {
            "target_revision_id": target["revision_id"],
            "options": [
                {
                    "key": "right-firmware",
                    "label": "Right controller firmware",
                    "domain": "firmware",
                    "path": ["right", "board"],
                    "choices": [
                        {"key": "slow", "label": "Slow blink", "revision_id": first["revision_id"]},
                        {
                            "key": "fast",
                            "label": "Fast blink",
                            "revision_id": second["revision_id"],
                        },
                    ],
                },
                {
                    "key": "left-population",
                    "label": "Left board population",
                    "domain": "population",
                    "path": ["left", "board"],
                    "default_choice": "fitted",
                    "choices": [
                        {
                            "key": "fitted",
                            "label": "Fitted",
                            "revision_id": population,
                            "population_option_id": "default",
                        },
                        {
                            "key": "bare",
                            "label": "Bare",
                            "revision_id": population,
                            "population_option_id": "no-mcu",
                        },
                    ],
                },
            ],
        }
    }
    options = frozen(users["owner"], project, "Synthetic controller options", "option_set", content)
    draft = configuration(
        users["editor"],
        project,
        options["revision_id"],
        [{"option_key": "right-firmware", "choice_key": "fast"}],
    )
    done = capture(users["editor"], draft["draft_id"])
    by_key = decisions(done)
    assert by_key["right-firmware"]["choice"]["revision"]["revision_id"] == second["revision_id"]
    assert by_key["right-firmware"]["base"]["firmware_revision_id"] == first["revision_id"]
    assert (
        by_key["right-firmware"]["choice"]["declared_target"]["population_revision_id"]
        == population
    )
    assert by_key["right-firmware"]["compatibility"] == "not_evaluated"
    assert by_key["left-population"]["choice"]["population_option_id"] == "default"
    assert by_key["left-population"]["source"] == "default"
    assert done["resolution"]["target"]["revision_id"] == target["revision_id"]
    # The frozen consumer assembly is untouched; its pins stay exact.
    assert Snapshot.objects.get(id=target["snapshot_id"]).sha256 == target_sha
    pins = set(
        SnapshotDependency.objects.filter(snapshot_id=done["snapshot_id"]).values_list(
            "revision_id", flat=True
        )
    )
    assert {str(p) for p in pins} >= {
        options["revision_id"],
        target["revision_id"],
        second["revision_id"],
        population,
    }

    bad = json.loads(json.dumps(content))
    bad["option_set"]["options"][1]["choices"][1]["population_option_id"] = "absent"
    bad_path = json.loads(json.dumps(content))
    bad_path["option_set"]["options"][0]["path"] = ["right", "nowhere"]
    swapped = json.loads(json.dumps(content))
    swapped["option_set"]["options"][0]["choices"][0]["revision_id"] = population
    for invalid in (bad, bad_path, swapped):
        with pytest.raises(ValidationFailed):
            op(
                users["owner"],
                "definition.create",
                {
                    "workspace_id": workspace_of(project),
                    "kind": "option_set",
                    "name": "Invalid",
                    "content": invalid,
                },
            )


def test_api_uses_the_same_operations(users, project, option_set):
    draft = configuration(users["editor"], project, option_set["revision_id"])
    client = api(users["viewer"])
    response = post_op(client, "configuration.resolve", {"draft_id": draft["draft_id"]})
    assert response.status_code == 200
    reviewed = response.json()["result"]
    denied = post_op(
        client,
        "configuration.capture",
        {"draft_id": draft["draft_id"], "review_sha256": reviewed["review_sha256"], "basis": "x"},
        expected_state=reviewed["state"],
    )
    assert denied.status_code == 403
    allowed = post_op(
        api(users["editor"]),
        "configuration.capture",
        {"draft_id": draft["draft_id"], "review_sha256": reviewed["review_sha256"], "basis": "x"},
        expected_state=reviewed["state"],
        idempotency_key="api-cap",
    )
    assert allowed.status_code == 200
    assert allowed.json()["result"]["status"] == "incomplete"


def firmware_target_results(users, project, target, first, population_choices, select=None):
    options = [
        {
            "key": "right-firmware",
            "label": "Right controller firmware",
            "domain": "firmware",
            "path": ["right", "board"],
            "choices": [{"key": "slow", "label": "Slow", "revision_id": first["revision_id"]}],
        }
    ]
    if population_choices:
        options.append(
            {
                "key": "right-population",
                "label": "Right board population",
                "domain": "population",
                "path": ["right", "board"],
                "default_choice": population_choices[0]["key"],
                "choices": population_choices,
            }
        )
    content = {"option_set": {"target_revision_id": target["revision_id"], "options": options}}
    created = frozen(users["owner"], project, "Synthetic firmware options", "option_set", content)
    selections = [{"option_key": "right-firmware", "choice_key": "slow"}]
    if select:
        selections.append({"option_key": "right-population", "choice_key": select})
    draft = configuration(users["editor"], project, created["revision_id"], selections)
    preview = op(users["viewer"], "configuration.resolve", {"draft_id": draft["draft_id"]})
    rule = {r["key"]: r for r in preview["resolution"]["constraints"]["results"]}
    return rule["firmware-target-right-firmware"], preview


def test_firmware_target_rule_compares_declared_and_chosen_population(
    users,
    project,
    sources,  # noqa: F811
    board,  # noqa: F811
    pair,  # noqa: F811
):
    assembly, first, _ = pair
    target = op(
        users["owner"],
        "assembly.freeze",
        {"draft_id": assembly["draft_id"]},
        expected_state=assembly["state"],
    )
    revision = board[0]["revision_id"]
    choices = [
        {
            "key": "fitted",
            "label": "Fitted",
            "revision_id": revision,
            "population_option_id": "default",
        },
        {"key": "bare", "label": "Bare", "revision_id": revision, "population_option_id": "no-mcu"},
    ]
    rule, preview = firmware_target_results(users, project, target, first, choices)
    assert rule["kind"] == "firmware_target" and rule["outcome"] == "valid"
    assert [r["code"] for r in rule["reasons"] if r["level"] == "fact"][-1] == "target_matches"
    assert preview["resolution"]["constraints"]["outcome"] == "valid"

    rule, _ = firmware_target_results(users, project, target, first, choices, "bare")
    assert rule["outcome"] == "invalid"
    assert [r["code"] for r in rule["reasons"] if r["level"] == "fact"][
        -1
    ] == "target_option_mismatch"

    # No population choice: the occurrence's population revision matches, but the option in
    # use is not stated while the firmware declares one, so the outcome is unknown.
    rule, _ = firmware_target_results(users, project, target, first, [])
    assert rule["outcome"] == "unknown"
    assert [r["code"] for r in rule["reasons"] if r["level"] == "fact"][-1] == (
        "population_option_unknown"
    )


def decision(**changes):
    base = {
        "option_key": "fw",
        "label": "Firmware",
        "domain": "firmware",
        "path": ["board"],
        "status": "resolved",
        "source": "selected",
        "choice": {
            "key": "a",
            "revision": {"revision_id": "r1"},
            "declared_target": {"population_revision_id": "p1", "option_id": None},
        },
        "base": {"population_revision_id": "p1"},
    }
    return {**base, **changes}


def test_firmware_target_rule_reports_mismatch_and_undeclared_sides():
    from specmate.configurations.constraints import _firmware_target_rule

    def run(firmware, population=None):
        by_key = {"fw": firmware, **({"pop": population} if population else {})}
        return _firmware_target_rule(firmware, by_key)[0]

    assert run(decision()) == "valid"
    assert run(decision(base={"population_revision_id": "p2"})) == "invalid"
    undeclared = decision()
    undeclared["choice"]["declared_target"] = {"population_revision_id": None, "option_id": None}
    assert run(undeclared) == "unknown"
    assert run(decision(base=None)) == "unknown"
    assert run(decision(status="unresolved", choice=None)) == "unknown"
    assert run(decision(status="none", choice=None)) == "not_evaluated"
    population = {
        "option_key": "pop",
        "label": "Population",
        "domain": "population",
        "path": ["board"],
        "status": "resolved",
        "source": "selected",
        "choice": {
            "key": "x",
            "revision": {"revision_id": "p2"},
            "population_option_id": "default",
        },
    }
    assert run(decision(), population) == "invalid"
    assert run(decision(), {**population, "status": "unresolved", "choice": None}) == "unknown"
