"""ACC-CFG-001 adoption: resolved occurrence choices enter an owning assembly draft only
through a reviewed diff, explicit confirmation and compare-and-set; frozen revisions and
captured resolutions never change. Synthetic fixtures on real PostgreSQL; no native tool.
"""

import pytest
from django.db import DatabaseError, connection, transaction

from specmate.configurations.models import ConfigurationAdoption
from specmate.design.models import Draft, Snapshot
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
    assert rows["population"]["action"] == "unchanged"
    assert "Population option default is not an assembly field" in rows["population"]["reason"]
    assert rows["firmware"]["action"] == "assign_firmware"
    assert rows["firmware"]["before"]["revision_id"] == bench["slow"]["revision_id"]
    assert rows["finish"]["action"] == "not_applicable"
    assert reviewed["option_keys"] == ["firmware", "sensor"]
    assert [(c["field"], c["path"], c["after"]["revision_id"]) for c in reviewed["changes"]] == [
        ("revision_id", ["sensor"], bench["parts"][1]["revision_id"]),
        ("firmware", ["board"], bench["fast"]["revision_id"]),
    ]
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
        {"path": ["board"], "assignments": {"firmware_revision_id": bench["fast"]["revision_id"]}}
    ]
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
    assert [c["option_key"] for c in reviewed["changes"]] == ["sensor"]
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
    nothing = review(users["viewer"], bench, option_keys=["population"])
    assert nothing["eligible"] is False and nothing["changes"] == []

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


def test_nested_choices_assign_context_firmware_but_never_rewrite_nested_revisions(
    users,
    project,
    sources,  # noqa: F811
    board,  # noqa: F811
    pair,  # noqa: F811
):
    assembly, _, second = pair
    target = op(
        users["owner"],
        "assembly.freeze",
        {"draft_id": assembly["draft_id"]},
        expected_state=assembly["state"],
    )
    part = frozen(users["owner"], project, "Synthetic replacement board")
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
                        {"key": "fast", "label": "Fast", "revision_id": second["revision_id"]}
                    ],
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
            ],
        }
    }
    options = frozen(users["owner"], project, "Synthetic nested options", "option_set", content)
    draft = configuration(
        users["editor"],
        project,
        options["revision_id"],
        [
            {"option_key": "right-firmware", "choice_key": "fast"},
            {"option_key": "left-board", "choice_key": "alt"},
        ],
    )
    resolved = capture(users["editor"], draft["draft_id"])
    reviewed = op(
        users["viewer"],
        "configuration.review_adoption",
        {"resolved_configuration_id": resolved["resolved_configuration_id"]},
    )
    rows = by_key(reviewed)
    assert rows["left-board"]["action"] == "blocked"
    assert "containing assembly revision" in rows["left-board"]["reason"]
    assert rows["right-firmware"]["action"] == "assign_firmware"
    assert reviewed["option_keys"] == ["right-firmware"]
    done = adopt(users["editor"], reviewed)
    assert done["content"]["assembly"]["assignments"] == [
        {"path": ["right", "board"], "assignments": {"firmware_revision_id": second["revision_id"]}}
    ]
    explicit = op(
        users["viewer"],
        "configuration.review_adoption",
        {
            "resolved_configuration_id": resolved["resolved_configuration_id"],
            "option_keys": ["left-board"],
        },
    )
    assert explicit["eligible"] is False


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
