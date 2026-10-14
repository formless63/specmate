"""ACC-CFG-001 adoption: resolved occurrence choices enter an owning assembly draft only
through a reviewed diff, explicit confirmation and compare-and-set; frozen revisions and
captured resolutions never change. Synthetic fixtures on real PostgreSQL; no native tool.
"""

import pytest
from django.db import DatabaseError, connection, transaction

from specmate.configurations.models import ConfigurationAdoption
from specmate.design.models import Draft, Revision, Snapshot
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)

from .conftest import op
from .scope_helpers import workspace_of
from .test_configurations import capture, configuration, frozen
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

BASIS = "Reviewed synthetic adoption of resolved choices"


@pytest.fixture
def bench(users, project, sources, board):  # noqa: F811
    """A frozen root assembly with a direct part and a direct board population."""
    owner = users["owner"]
    parts = [frozen(owner, project, f"Synthetic sensor {n}") for n in ("A", "B")]
    slow = frozen_firmware(users, project, sources, board)
    fast = frozen_firmware(users, project, sources, board, value="900")
    population = board[0]["revision_id"]
    root = op(
        owner,
        "assembly.create",
        {
            "workspace_id": workspace_of(project),
            "name": "Synthetic sensor node",
            "assembly": {
                "occurrences": [
                    {
                        "local_id": "sensor",
                        "display_ref": "S1",
                        "revision_id": parts[0]["revision_id"],
                    },
                    {
                        "local_id": "board",
                        "display_ref": "A1",
                        "revision_id": population,
                        "assignments": {"firmware_revision_id": slow["revision_id"]},
                    },
                ]
            },
        },
    )
    target = op(
        owner, "assembly.freeze", {"draft_id": root["draft_id"]}, expected_state=root["state"]
    )
    content = {
        "option_set": {
            "target_revision_id": target["revision_id"],
            "options": [
                {
                    "key": "sensor",
                    "label": "Sensor part",
                    "domain": "part",
                    "path": ["sensor"],
                    "default_choice": "a",
                    "choices": [
                        {"key": "a", "label": "Sensor A", "revision_id": parts[0]["revision_id"]},
                        {"key": "b", "label": "Sensor B", "revision_id": parts[1]["revision_id"]},
                    ],
                },
                {
                    "key": "population",
                    "label": "Board population",
                    "domain": "population",
                    "path": ["board"],
                    "default_choice": "fitted",
                    "choices": [
                        {
                            "key": "fitted",
                            "label": "Fitted",
                            "revision_id": population,
                            "population_option_id": "default",
                        }
                    ],
                },
                {
                    "key": "firmware",
                    "label": "Controller firmware",
                    "domain": "firmware",
                    "path": ["board"],
                    "choices": [
                        {"key": "slow", "label": "Slow", "revision_id": slow["revision_id"]},
                        {"key": "fast", "label": "Fast", "revision_id": fast["revision_id"]},
                    ],
                },
                {
                    "key": "finish",
                    "label": "Enclosure finish",
                    "domain": "process",
                    "choices": [{"key": "paint", "label": "Painted", "value": "powder-coat"}],
                },
            ],
        }
    }
    options = frozen(owner, project, "Synthetic node options", "option_set", content)
    draft = configuration(
        users["editor"],
        project,
        options["revision_id"],
        [
            {"option_key": "sensor", "choice_key": "b"},
            {"option_key": "firmware", "choice_key": "fast"},
            {"option_key": "finish", "choice_key": "paint"},
        ],
    )
    resolved = capture(users["editor"], draft["draft_id"])
    original = Draft.objects.get(id=root["draft_id"])
    return {
        "parts": parts,
        "slow": slow,
        "fast": fast,
        "population": population,
        "target": target,
        "root_draft": {"draft_id": root["draft_id"], "state": original.state_token},
        "options": options,
        "resolved": resolved,
    }


def review(user, bench, **payload):
    return op(
        user,
        "configuration.review_adoption",
        {"resolved_configuration_id": bench["resolved"]["resolved_configuration_id"], **payload},
    )


def adopt(user, reviewed, *, draft_id=None, basis=BASIS, **ctx):
    payload = {
        "resolved_configuration_id": reviewed["resolved_configuration_id"],
        "option_keys": reviewed["option_keys"],
        "review_sha256": reviewed["review_sha256"],
        "basis": basis,
    }
    if draft_id:
        payload["draft_id"] = draft_id
    return op(user, "configuration.adopt", payload, **ctx)


def by_key(reviewed):
    return {row["option_key"]: row for row in reviewed["rows"]}


def test_review_shows_exact_diff_and_new_draft_adoption_keeps_frozen_target(users, bench):
    target_sha = Snapshot.objects.get(id=bench["target"]["snapshot_id"]).sha256
    reviewed = review(users["viewer"], bench)
    rows = by_key(reviewed)
    assert reviewed["owner"]["mode"] == "new_draft"
    assert reviewed["owner"]["base_revision_id"] == bench["target"]["revision_id"]
    assert rows["sensor"]["action"] == "replace_revision"
    assert rows["sensor"]["before"]["revision_id"] == bench["parts"][0]["revision_id"]
    # The population revision is already pinned; its option becomes an assignment.
    assert rows["population"]["action"] == "assign_population_option"
    assert rows["population"]["population_option_before"] is None
    assert rows["firmware"]["action"] == "assign_firmware"
    assert rows["firmware"]["before"]["revision_id"] == bench["slow"]["revision_id"]
    assert rows["finish"]["action"] == "not_applicable"
    assert reviewed["option_keys"] == ["firmware", "population", "sensor"]
    assert [(c["field"], c["path"], c["before"], c["after"]) for c in reviewed["changes"]] == [
        ("revision_id", ["sensor"], rows["sensor"]["before"], rows["sensor"]["choice"]["revision"]),
        ("population_option_id", ["board"], None, "default"),
        ("firmware", ["board"], rows["firmware"]["before"], rows["firmware"]["choice"]["revision"]),
    ]
    assert reviewed["propagation"] == [] and reviewed["requires"] == ["design.edit"]
    assert reviewed["eligible"] is True and reviewed["compatibility"] == "not_evaluated"
    assert reviewed["adoptions"] == []

    # Reviewing changes nothing; viewers cannot adopt.
    assert (
        not Draft.objects.filter(base_revision_id=bench["target"]["revision_id"])
        .exclude(id=bench["root_draft"]["draft_id"])
        .exists()
    )
    with pytest.raises(PermissionDenied):
        adopt(users["viewer"], reviewed)
    with pytest.raises(ValidationFailed):
        adopt(users["editor"], reviewed, expected_state="draft-v1")

    done = adopt(users["editor"], reviewed)
    assert done["created_draft"] is True and done["state"] == "draft-v1"
    assert done["base_revision_id"] == bench["target"]["revision_id"]
    assembly = done["content"]["assembly"]
    sensor = next(o for o in assembly["occurrences"] if o["local_id"] == "sensor")
    assert sensor["revision_id"] == bench["parts"][1]["revision_id"]
    assert assembly["assignments"] == [
        {
            "path": ["board"],
            "assignments": {
                "firmware_revision_id": bench["fast"]["revision_id"],
                "population_option_id": "default",
            },
        }
    ]
    assert done["propagated"] == []
    # The frozen target and the captured resolution are untouched.
    assert Snapshot.objects.get(id=bench["target"]["snapshot_id"]).sha256 == target_sha
    evidence = op(
        users["viewer"], "configuration.read_adoption", {"adoption_id": done["adoption_id"]}
    )
    assert evidence["resolved_configuration_id"] == bench["resolved"]["resolved_configuration_id"]
    assert evidence["review"]["review_sha256"] == reviewed["review_sha256"]
    assert evidence["created_draft"] is True
    history = review(users["viewer"], bench)["adoptions"]
    assert [item["adoption_id"] for item in history] == [done["adoption_id"]]
    # The adopted draft freezes into a new owning revision with the chosen exact pins.
    frozen_new = op(
        users["owner"], "assembly.freeze", {"draft_id": done["draft_id"]}, expected_state="draft-v1"
    )
    assert frozen_new["number"] == 2


def test_selected_draft_adoption_uses_compare_and_set(users, bench):
    owner = bench["root_draft"]
    reviewed = review(users["viewer"], bench, draft_id=owner["draft_id"], option_keys=["sensor"])
    assert reviewed["owner"]["mode"] == "existing_draft"
    assert [c["option_keys"] for c in reviewed["changes"]] == [["sensor"]]
    assert by_key(reviewed)["firmware"]["selected"] is False
    with pytest.raises(ValidationFailed):
        adopt(users["editor"], reviewed, draft_id=owner["draft_id"])
    with pytest.raises(Conflict):
        adopt(users["editor"], reviewed, draft_id=owner["draft_id"], expected_state="draft-v99")
    with pytest.raises(Conflict):
        adopt(
            users["editor"],
            {**reviewed, "review_sha256": "0" * 64},
            draft_id=owner["draft_id"],
            expected_state=owner["state"],
        )
    assert not ConfigurationAdoption.objects.exists()
    done = adopt(
        users["editor"], reviewed, draft_id=owner["draft_id"], expected_state=owner["state"]
    )
    assert done["draft_id"] == owner["draft_id"] and done["created_draft"] is False
    draft = Draft.objects.get(id=owner["draft_id"])
    assert draft.state_token == done["state"] != owner["state"]
    board_occurrence = next(
        o for o in draft.content["assembly"]["occurrences"] if o["local_id"] == "board"
    )
    assert board_occurrence["assignments"]["firmware_revision_id"] == bench["slow"]["revision_id"]
    assert draft.content["assembly"]["assignments"] == []
    # The same review cannot apply twice: the draft state moved on.
    with pytest.raises(Conflict):
        adopt(users["editor"], reviewed, draft_id=owner["draft_id"], expected_state=owner["state"])
    # A draft of another definition is refused.
    other = op(
        users["owner"],
        "assembly.create",
        {"workspace_id": str(draft.definition.workspace_id), "name": "Unrelated assembly"},
    )
    with pytest.raises(ValidationFailed):
        review(users["viewer"], bench, draft_id=other["draft_id"])


def test_selection_validation_authority_and_idempotency(users, bench):
    with pytest.raises(NotFound):
        review(users["outsider"], bench)
    with pytest.raises(ValidationFailed):
        review(users["viewer"], bench, option_keys=["absent"])
    refused = review(users["viewer"], bench, option_keys=["sensor", "finish"])
    assert refused["eligible"] is False and "finish" in refused["message"]
    with pytest.raises(ValidationFailed):
        adopt(users["editor"], refused)

    reviewed = review(users["viewer"], bench, option_keys=["sensor"])
    first = adopt(users["editor"], reviewed, idempotency_key="cfg-adopt")
    again = adopt(users["editor"], reviewed, idempotency_key="cfg-adopt")
    assert again == first
    assert ConfigurationAdoption.objects.count() == 1
    with pytest.raises(IdempotencyMismatch):
        adopt(users["editor"], reviewed, basis="Different basis", idempotency_key="cfg-adopt")
    with pytest.raises(NotFound):
        adopt(users["outsider"], reviewed, idempotency_key="cfg-adopt")


def test_database_keeps_adoption_evidence_immutable_and_linked(users, bench):
    done = adopt(users["editor"], review(users["viewer"], bench))
    row = ConfigurationAdoption.objects.get(id=done["adoption_id"])
    for statement in (
        "UPDATE configurations_configurationadoption SET basis = 'x' WHERE id = %s",
        "DELETE FROM configurations_configurationadoption WHERE id = %s",
    ):
        with pytest.raises(DatabaseError), transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute(statement, [row.id])
    tampered = {**row.review, "option_keys": ["sensor"]}
    with pytest.raises(DatabaseError), transaction.atomic():
        ConfigurationAdoption.objects.create(
            workspace_id=row.workspace_id,
            resolved_configuration_id=row.resolved_configuration_id,
            draft_id=row.draft_id,
            draft_version=row.draft_version + 1,
            created_draft=True,
            base_revision_id=row.base_revision_id,
            option_keys=["sensor"],
            review=tampered,
            review_canonical=bytes(row.review_canonical),
            review_sha256=row.review_sha256,
            before_content=row.before_content,
            before_canonical=bytes(row.before_canonical),
            after_content=row.after_content,
            basis="tampered",
            adopted_by=users["editor"],
        )


def test_population_option_is_recorded_validated_and_checked_against_firmware(
    users, project, bench
):
    owner = bench["root_draft"]
    content = {
        "option_set": {
            "target_revision_id": bench["target"]["revision_id"],
            "options": [
                {
                    "key": "population",
                    "label": "Board population",
                    "domain": "population",
                    "path": ["board"],
                    "choices": [
                        {
                            "key": "bare",
                            "label": "Without controller",
                            "revision_id": bench["population"],
                            "population_option_id": "no-mcu",
                        }
                    ],
                },
                {
                    "key": "firmware",
                    "label": "Controller firmware",
                    "domain": "firmware",
                    "path": ["board"],
                    "choices": [
                        {
                            "key": "fast",
                            "label": "Fast",
                            "revision_id": bench["fast"]["revision_id"],
                        }
                    ],
                },
            ],
        }
    }
    options = frozen(users["owner"], project, "Synthetic fitted options", "option_set", content)
    draft = configuration(
        users["editor"],
        project,
        options["revision_id"],
        [
            {"option_key": "population", "choice_key": "bare"},
            {"option_key": "firmware", "choice_key": "fast"},
        ],
    )
    resolved = capture(users["editor"], draft["draft_id"])
    payload = {
        "resolved_configuration_id": resolved["resolved_configuration_id"],
        "draft_id": owner["draft_id"],
    }
    reviewed = op(users["viewer"], "configuration.review_adoption", payload)
    rows = by_key(reviewed)
    assert rows["population"]["action"] == "assign_population_option"
    # Firmware declared for option "default" cannot run on a board fitted as "no-mcu".
    assert rows["firmware"]["action"] == "blocked"
    assert "no-mcu" in rows["firmware"]["reason"]
    assert reviewed["option_keys"] == ["population"]

    done = adopt(
        users["editor"], reviewed, draft_id=owner["draft_id"], expected_state=owner["state"]
    )
    assert done["content"]["assembly"]["assignments"] == [
        {
            "path": ["board"],
            "assignments": {
                "firmware_revision_id": bench["slow"]["revision_id"],
                "population_option_id": "no-mcu",
            },
        }
    ]
    again = op(users["viewer"], "configuration.review_adoption", payload)
    assert by_key(again)["population"]["action"] == "unchanged"
    assert by_key(again)["population"]["population_option_before"] == "no-mcu"

    # The assembly contract validates the option against the exact pinned revision.
    assembly = done["content"]["assembly"]
    for bad in (
        {"path": ["board"], "assignments": {"population_option_id": "absent"}},
        {"path": ["sensor"], "assignments": {"population_option_id": "no-mcu"}},
    ):
        with pytest.raises(ValidationFailed):
            op(
                users["editor"],
                "assembly.update",
                {"draft_id": owner["draft_id"], "assembly": {**assembly, "assignments": [bad]}},
                expected_state=done["state"],
            )


def test_firmware_occurrence_adoption_keeps_a_recorded_population_option(users, bench):
    owner = bench["root_draft"]
    reviewed = review(
        users["viewer"], bench, draft_id=owner["draft_id"], option_keys=["population"]
    )
    done = adopt(
        users["editor"], reviewed, draft_id=owner["draft_id"], expected_state=owner["state"]
    )
    preview = op(
        users["viewer"],
        "firmware_occurrence.review",
        {
            "draft_id": owner["draft_id"],
            "path": ["board"],
            "firmware_revision_id": bench["fast"]["revision_id"],
        },
    )
    payload = {
        key: preview[key] for key in ("draft_id", "path", "firmware_revision_id", "review_sha256")
    }
    op(
        users["editor"],
        "firmware_occurrence.adopt",
        {**payload, "basis": BASIS},
        expected_state=done["state"],
    )
    records = Draft.objects.get(id=owner["draft_id"]).content["assembly"]["assignments"]
    assert records == [
        {
            "path": ["board"],
            "assignments": {
                "firmware_revision_id": bench["fast"]["revision_id"],
                "population_option_id": "default",
            },
        }
    ]


def nested_resolution(users, project, target, options):
    content = {"option_set": {"target_revision_id": target["revision_id"], "options": options}}
    option_set = frozen(users["owner"], project, "Synthetic nested options", "option_set", content)
    draft = configuration(
        users["editor"],
        project,
        option_set["revision_id"],
        [{"option_key": o["key"], "choice_key": o["choices"][0]["key"]} for o in options],
    )
    return capture(users["editor"], draft["draft_id"])


def freeze_root(users, assembly):
    return op(
        users["owner"],
        "assembly.freeze",
        {"draft_id": assembly["draft_id"]},
        expected_state=assembly["state"],
    )


def test_nested_choice_propagates_through_a_new_containing_revision(
    users,
    project,
    sources,  # noqa: F811
    board,  # noqa: F811
    pair,  # noqa: F811
):
    assembly, _, second = pair
    target = freeze_root(users, assembly)
    root_snapshot = Snapshot.objects.get(id=target["snapshot_id"])
    module_pin = op(users["viewer"], "assembly.read", {"snapshot_id": str(root_snapshot.id)})
    module_revision = next(
        o["revision_id"] for o in module_pin["occurrences"] if o["address"]["path"] == ["left"]
    )
    module_sha = Revision.objects.get(id=module_revision).snapshot.sha256
    part = frozen(users["owner"], project, "Synthetic replacement board")
    resolved = nested_resolution(
        users,
        project,
        target,
        [
            {
                "key": "right-firmware",
                "label": "Right controller firmware",
                "domain": "firmware",
                "path": ["right", "board"],
                "choices": [{"key": "fast", "label": "Fast", "revision_id": second["revision_id"]}],
            },
            {
                "key": "left-board",
                "label": "Left board part",
                "domain": "part",
                "path": ["left", "board"],
                "choices": [
                    {"key": "alt", "label": "Alternative", "revision_id": part["revision_id"]}
                ],
            },
            {
                "key": "left-fitted",
                "label": "Left board population",
                "domain": "population",
                "path": ["left", "board"],
                "choices": [
                    {
                        "key": "bare",
                        "label": "Bare",
                        "revision_id": board[0]["revision_id"],
                        "population_option_id": "no-mcu",
                    }
                ],
            },
        ],
    )
    payload = {"resolved_configuration_id": resolved["resolved_configuration_id"]}
    reviewed = op(users["viewer"], "configuration.review_adoption", payload)
    rows = by_key(reviewed)
    assert rows["left-board"]["action"] == "propagate_revision"
    # A population option of the same pinned revision needs no propagation; it is a
    # contextual assignment of the owning draft. Combined with a replaced pin it conflicts,
    # so the default selection keeps the first declared option and notes the overlap.
    assert rows["left-fitted"]["action"] == "assign_population_option"
    assert rows["left-fitted"]["selected"] is False
    assert "Option left-board changes this occurrence" in rows["left-fitted"]["reason"]
    assert rows["right-firmware"]["action"] == "assign_firmware"
    assert reviewed["option_keys"] == ["left-board", "right-firmware"]
    assert reviewed["requires"] == ["design.edit", "design.freeze"]
    # Multi-level diff: the owning draft re-pins `left`; the module level replaces `board`.
    root_changes = {(c["field"], tuple(c["path"])): c for c in reviewed["changes"]}
    repin = root_changes[("revision_id", ("left",))]
    assert repin["before"]["revision_id"] == module_revision
    assert repin["after"]["proposed"] is True and repin["after"]["path"] == ["left"]
    assert repin["option_keys"] == ["left-board"]
    assert ("firmware", ("right", "board")) in root_changes
    [level] = reviewed["propagation"]
    assert level["path"] == ["left"] and level["pinned"]["revision_id"] == module_revision
    assert level["draft"]["mode"] == "new_draft" and level["result"] == "freeze_new_revision"
    assert [(c["local_id"], c["after"]["revision_id"]) for c in level["changes"]] == [
        ("board", part["revision_id"])
    ]
    assert [w["path"] for w in reviewed["warnings"]] == [["left", "board"]]
    assert reviewed["eligible"] is True

    # An explicit selection that combines conflicting changes is refused.
    conflicting = op(
        users["viewer"],
        "configuration.review_adoption",
        {**payload, "option_keys": ["left-board", "left-fitted"]},
    )
    assert conflicting["eligible"] is False
    assert by_key(conflicting)["left-fitted"]["action"] == "blocked"

    # A stale owning draft rolls back every level: no new revision or draft remains.
    revisions = Revision.objects.count()
    owned = op(
        users["viewer"],
        "configuration.review_adoption",
        {**payload, "draft_id": assembly["draft_id"]},
    )
    with pytest.raises(Conflict):
        adopt(users["editor"], owned, draft_id=assembly["draft_id"], expected_state="draft-v99")
    assert Revision.objects.count() == revisions

    done = adopt(users["editor"], reviewed)
    [propagated] = done["propagated"]
    assert propagated["path"] == ["left"] and propagated["base_revision_id"] == module_revision
    assert propagated["number"] == 2
    new_module = Revision.objects.get(id=propagated["revision_id"])
    assert new_module.definition_id == Revision.objects.get(id=module_revision).definition_id
    assert Draft.objects.get(id=propagated["draft_id"]).base_revision_id == new_module.id
    # Frozen revisions are untouched: the old module and the target keep their bytes.
    assert Revision.objects.get(id=module_revision).snapshot.sha256 == module_sha
    assert Snapshot.objects.get(id=target["snapshot_id"]).sha256 == root_snapshot.sha256
    occurrences = {o["local_id"]: o for o in done["content"]["assembly"]["occurrences"]}
    assert occurrences["left"]["revision_id"] == propagated["revision_id"]
    assert occurrences["right"]["revision_id"] == module_revision
    assert done["content"]["assembly"]["assignments"] == [
        {"path": ["right", "board"], "assignments": {"firmware_revision_id": second["revision_id"]}}
    ]
    # The database guard ties propagated levels to the reviewed levels.
    row = ConfigurationAdoption.objects.get(id=done["adoption_id"])
    fields = {
        name: getattr(row, name)
        for name in (
            "workspace_id",
            "resolved_configuration_id",
            "draft_id",
            "draft_version",
            "created_draft",
            "base_revision_id",
            "option_keys",
            "review",
            "review_sha256",
            "before_content",
            "after_content",
            "basis",
        )
    }
    fields |= {
        "review_canonical": bytes(row.review_canonical),
        "before_canonical": bytes(row.before_canonical),
        "adopted_by": users["editor"],
    }
    for propagated_rows, code in (
        (row.propagated, "23505"),  # valid evidence reaches the unique constraint
        ([], "23514"),
        ([{**row.propagated[0], "base_revision_id": target["revision_id"]}], "23514"),
    ):
        with pytest.raises(DatabaseError) as failure, transaction.atomic():
            ConfigurationAdoption.objects.create(**fields, propagated=propagated_rows)
        assert failure.value.__cause__.sqlstate == code
    # The adopted draft freezes into a closure with the replaced nested pin only on the left.
    root = op(
        users["owner"],
        "assembly.freeze",
        {"draft_id": done["draft_id"]},
        expected_state=done["state"],
    )
    read = op(users["viewer"], "assembly.read", {"snapshot_id": root["snapshot_id"]})
    pins = {tuple(o["address"]["path"]): o["revision_id"] for o in read["occurrences"]}
    assert pins[("left", "board")] == part["revision_id"]
    assert pins[("right", "board")] == board[0]["revision_id"]
    evidence = op(
        users["viewer"], "configuration.read_adoption", {"adoption_id": done["adoption_id"]}
    )
    assert evidence["propagated"] == done["propagated"]


def test_deep_nested_choice_freezes_every_containing_level_bottom_up(
    users,
    project,
    sources,  # noqa: F811
    board,  # noqa: F811
    pair,  # noqa: F811
):
    assembly, _, _ = pair
    module_revision = Draft.objects.get(id=assembly["draft_id"]).content["assembly"]["occurrences"][
        0
    ]["revision_id"]
    workspace = workspace_of(project)
    bay = op(
        users["owner"],
        "assembly.create",
        {
            "workspace_id": workspace,
            "name": "Synthetic bay",
            "assembly": {"occurrences": [{"local_id": "inner", "revision_id": module_revision}]},
        },
    )
    bay_revision = freeze_root(users, bay)
    rack = op(
        users["owner"],
        "assembly.create",
        {
            "workspace_id": workspace,
            "name": "Synthetic rack",
            "assembly": {
                "occurrences": [
                    {"local_id": "upper", "revision_id": bay_revision["revision_id"]},
                    {"local_id": "lower", "revision_id": bay_revision["revision_id"]},
                ]
            },
        },
    )
    target = freeze_root(users, rack)
    part = frozen(users["owner"], project, "Synthetic deep replacement")
    resolved = nested_resolution(
        users,
        project,
        target,
        [
            {
                "key": "deep",
                "label": "Deep board part",
                "domain": "part",
                "path": ["upper", "inner", "board"],
                "choices": [{"key": "alt", "label": "Alt", "revision_id": part["revision_id"]}],
            }
        ],
    )
    reviewed = op(
        users["viewer"],
        "configuration.review_adoption",
        {"resolved_configuration_id": resolved["resolved_configuration_id"]},
    )
    assert [level["path"] for level in reviewed["propagation"]] == [["upper"], ["upper", "inner"]]
    upper, inner = reviewed["propagation"]
    assert upper["changes"][0]["after"] == {
        "proposed": True,
        "definition_id": inner["pinned"]["definition_id"],
        "kind": "assembly",
        "name": "Synthetic controller module",
        "path": ["upper", "inner"],
    }
    assert inner["changes"][0]["after"]["revision_id"] == part["revision_id"]
    with pytest.raises(PermissionDenied):
        adopt(users["contributor"], reviewed)
    done = adopt(users["editor"], reviewed)
    levels = {tuple(item["path"]): item for item in done["propagated"]}
    new_bay = Revision.objects.get(id=levels[("upper",)]["revision_id"])
    bay_content = Snapshot.objects.get(id=new_bay.snapshot_id).canonical
    assert levels[("upper", "inner")]["revision_id"] in bytes(bay_content).decode()
    occurrences = {o["local_id"]: o for o in done["content"]["assembly"]["occurrences"]}
    assert occurrences["upper"]["revision_id"] == str(new_bay.id)
    assert occurrences["lower"]["revision_id"] == bay_revision["revision_id"]


def test_nested_choice_with_feature_relationships_stays_blocked(
    users,
    project,
    sources,  # noqa: F811
    board,  # noqa: F811
    pair,  # noqa: F811
):
    assembly, _, _ = pair
    content = Draft.objects.get(id=assembly["draft_id"]).content["assembly"]
    content["relationships"] = [
        {
            "kind": "electrical",
            "local_id": "link",
            "a": {"kind": "occurrence", "path": ["left", "board"], "feature_id": "J1.1"},
            "b": {"kind": "occurrence", "path": ["right", "board"], "feature_id": "J1.1"},
        }
    ]
    updated = op(
        users["owner"],
        "assembly.update",
        {"draft_id": assembly["draft_id"], "assembly": content},
        expected_state=assembly["state"],
    )
    target = freeze_root(users, {**assembly, "state": updated["state"]})
    part = frozen(users["owner"], project, "Synthetic replacement board")
    resolved = nested_resolution(
        users,
        project,
        target,
        [
            {
                "key": "left-board",
                "label": "Left board part",
                "domain": "part",
                "path": ["left", "board"],
                "choices": [{"key": "alt", "label": "Alt", "revision_id": part["revision_id"]}],
            }
        ],
    )
    reviewed = op(
        users["viewer"],
        "configuration.review_adoption",
        {"resolved_configuration_id": resolved["resolved_configuration_id"]},
    )
    assert by_key(reviewed)["left-board"]["action"] == "blocked"
    assert "feature correspondence" in by_key(reviewed)["left-board"]["reason"]
    assert reviewed["propagation"] == [] and reviewed["eligible"] is False


def test_authoring_context_describes_exact_pins(users, bench):
    context = op(
        users["viewer"],
        "configuration.authoring_context",
        {
            "target_revision_id": bench["target"]["revision_id"],
            "revision_ids": [bench["population"], bench["fast"]["revision_id"]],
        },
    )
    occurrences = {tuple(o["path"]): o for o in context["target"]["occurrences"]}
    assert occurrences[("board",)]["firmware_revision_id"] == bench["slow"]["revision_id"]
    options = occurrences[("board",)]["revision"]["population_options"]
    assert {o["local_id"] for o in options} >= {"default", "no-mcu"}
    population, firmware = context["revisions"]
    assert population["kind"] == "pcb_population"
    assert firmware["declared_target"]["population_revision_id"] == bench["population"]
    with pytest.raises(ValidationFailed):
        op(
            users["viewer"],
            "configuration.authoring_context",
            {"target_revision_id": bench["parts"][0]["revision_id"]},
        )
    with pytest.raises(NotFound):
        op(
            users["outsider"],
            "configuration.authoring_context",
            {"revision_ids": [bench["population"]]},
        )


def test_api_uses_the_same_adoption_operations(users, bench):
    reviewed = post_op(
        api(users["viewer"]),
        "configuration.review_adoption",
        {"resolved_configuration_id": bench["resolved"]["resolved_configuration_id"]},
    )
    assert reviewed.status_code == 200
    body = reviewed.json()["result"]
    payload = {
        "resolved_configuration_id": body["resolved_configuration_id"],
        "option_keys": body["option_keys"],
        "review_sha256": body["review_sha256"],
        "basis": BASIS,
    }
    assert post_op(api(users["viewer"]), "configuration.adopt", payload).status_code == 403
    allowed = post_op(api(users["editor"]), "configuration.adopt", payload, idempotency_key="api")
    assert allowed.status_code == 200
    assert allowed.json()["result"]["created_draft"] is True
