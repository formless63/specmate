"""ACC-CFG-003: development proposals linked to otherwise unmet configuration rules.

A proposal does not turn an invalid current combination into a valid completed design.
Synthetic generic definitions, option sets and fact ledgers on real PostgreSQL; no native
tool runs and nothing here is physical qualification.
"""

# ruff: noqa: F811
import pytest
from django.db import DatabaseError, transaction

from specmate.builds.models import BuildAttempt
from specmate.configurations.models import DevelopmentLink, ResolvedConfiguration
from specmate.design.models import Definition
from specmate.operations import Conflict, NotFound, PermissionDenied, ValidationFailed

from .conftest import op
from .scope_helpers import workspace_of
from .test_builds import build_payload, recipe, source  # noqa: F401
from .test_configuration_constraints import (
    CURRENT,
    PAINT_NEEDS_SPLASH,
    append,
    constrained,
    ledger,
    parts,  # noqa: F401
    rating,
)
from .test_configurations import capture, configuration, select


def resolve(user, draft):
    return op(user, "configuration.resolve", {"draft_id": draft["draft_id"]})


def outcomes(preview):
    return {r["key"]: r["outcome"] for r in preview["resolution"]["constraints"]["results"]}


def propose(user, draft, rule_key, need="adapter_board", name="Synthetic adapter board", **ctx):
    return op(
        user,
        "configuration.propose_development",
        {
            "draft_id": draft["draft_id"],
            "rule_key": rule_key,
            "need": need,
            "name": name,
            "summary": "Develop a synthetic adapter so the rule can be met.",
            "basis": "Synthetic review: the current combination fails this rule.",
        },
        **ctx,
    )


def link(user, draft, rule_key, target, **ctx):
    return op(
        user,
        "configuration.link_development",
        {
            "draft_id": draft["draft_id"],
            "rule_key": rule_key,
            "target": target,
            "basis": "Synthetic review link.",
        },
        **ctx,
    )


@pytest.fixture
def painted(users, project, parts):
    """Painted finish without splash sealing: paint-sealing invalid, sensor-current unknown."""
    revision = constrained(users["owner"], project, parts, [PAINT_NEEDS_SPLASH, CURRENT])
    draft = configuration(users["editor"], project, revision)
    select(users["editor"], draft, [{"option_key": "finish", "choice_key": "paint"}])
    return draft


def test_acc_cfg_003_a_proposal_never_makes_an_invalid_combination_valid(
    users, project, parts, painted, build_payload
):
    before = resolve(users["viewer"], painted)
    assert outcomes(before) == {"paint-sealing": "invalid", "sensor-current": "unknown"}
    assert before["development"]["outcome"] == "invalid"
    assert before["development"]["links"] == []

    # A contributor proposes an adapter board for the invalid rule, a cable for the unknown.
    adapter = propose(users["contributor"], painted, "paint-sealing")
    assert adapter["observed_outcome"] == "invalid"
    assert adapter["target"]["need"] == "adapter_board"
    assert adapter["target"]["physical_qualification"] is False
    cable = propose(users["contributor"], painted, "sensor-current", "cable", "Synthetic cable")
    assert cable["observed_outcome"] == "unknown"

    after = resolve(users["viewer"], painted)
    # ACC-CFG-003: the resolution, its outcome and its review hash are unchanged.
    assert after["resolution"] == before["resolution"]
    assert after["review_sha256"] == before["review_sha256"]
    assert after["resolution"]["constraints"]["outcome"] == "invalid"
    development = after["development"]
    assert development["constraint_outcome"] == "invalid"
    assert development["outcome"] == "invalid_with_proposal"
    assert {(e["rule_key"], e["current_outcome"]) for e in development["links"]} == {
        ("paint-sealing", "invalid"),
        ("sensor-current", "unknown"),
    }

    # Freezing the proposed work does not change the design either.
    need = Definition.objects.get(id=adapter["target"]["definition_id"])
    frozen = op(
        users["editor"],
        "draft.freeze",
        {"draft_id": adapter["need_draft"]["draft_id"]},
        expected_state=adapter["need_draft"]["state"],
    )
    assert frozen["number"] == 1 and need.kind == "development_need"
    assert outcomes(resolve(users["viewer"], painted))["paint-sealing"] == "invalid"

    # Captured with proposals linked: still invalid and refused as build input.
    invalid = capture(users["editor"], painted["draft_id"])
    assert invalid["resolution"]["constraints"]["outcome"] == "invalid"
    stored = ResolvedConfiguration.objects.get(id=invalid["resolved_configuration_id"])
    assert "development" not in stored.resolution
    read = op(
        users["viewer"],
        "configuration.read_resolved",
        {"resolved_configuration_id": invalid["resolved_configuration_id"]},
    )
    assert read["constraint_outcome"] == "invalid"
    assert read["development"]["outcome"] == "invalid_with_proposal"
    with pytest.raises(ValidationFailed) as refused:
        op(
            users["viewer"],
            "configuration.build_input",
            {"resolved_configuration_id": invalid["resolved_configuration_id"]},
        )
    assert refused.value.details == {"invalid": ["paint-sealing"]}
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "build.request",
            {**build_payload, "resolved_configuration_id": invalid["resolved_configuration_id"]},
            idempotency_key="invalid-with-proposal",
        )
    assert not BuildAttempt.objects.exists()

    # Only a changed design moves the outcome: sealing resolves the invalid rule ...
    select(
        users["editor"],
        painted,
        [
            {"option_key": "finish", "choice_key": "paint"},
            {"option_key": "sealing", "choice_key": "splash"},
        ],
    )
    preview = resolve(users["viewer"], painted)
    assert outcomes(preview) == {"paint-sealing": "valid", "sensor-current": "unknown"}
    assert preview["development"]["outcome"] == "unknown_with_proposal"
    # ... and a recorded rating resolves the unknown one. Links stay as history.
    append(users["editor"], ledger(users["editor"], parts[0]["revision_id"]), rating("3"))
    preview = resolve(users["viewer"], painted)
    assert preview["resolution"]["constraints"]["outcome"] == "valid"
    assert preview["development"]["outcome"] == "valid"
    assert {e["current_outcome"] for e in preview["development"]["links"]} == {"valid"}
    valid = capture(users["editor"], painted["draft_id"])
    built = op(
        users["viewer"],
        "configuration.build_input",
        {"resolved_configuration_id": valid["resolved_configuration_id"]},
    )
    assert built["constraints"]["outcome"] == "valid"
    # The earlier invalid capture is unchanged and still refused.
    with pytest.raises(ValidationFailed):
        op(
            users["viewer"],
            "configuration.build_input",
            {"resolved_configuration_id": invalid["resolved_configuration_id"]},
        )


def test_only_failing_declared_rules_take_proposals_under_current_authority(
    users, project, parts, painted, other_workspace
):
    needs = Definition.objects.filter(kind="development_need")
    select(
        users["editor"],
        painted,
        [
            {"option_key": "finish", "choice_key": "paint"},
            {"option_key": "sealing", "choice_key": "splash"},
        ],
    )
    # A valid rule and an undeclared rule are refused before anything is created.
    with pytest.raises(ValidationFailed) as refused:
        propose(users["contributor"], painted, "paint-sealing")
    assert refused.value.details == {"outcome": "valid"}
    with pytest.raises(ValidationFailed):
        propose(users["contributor"], painted, "no-such-rule")
    assert not needs.exists()

    with pytest.raises(PermissionDenied):
        propose(users["viewer"], painted, "sensor-current")
    with pytest.raises(NotFound):
        propose(users["outsider"], painted, "sensor-current")

    first = propose(users["contributor"], painted, "sensor-current")
    target = {"kind": "development_need", "definition_id": first["target"]["definition_id"]}
    with pytest.raises(Conflict):
        link(users["editor"], painted, "sensor-current", target)
    # Only development_need definitions of the same workspace are linkable needs.
    part = {"kind": "development_need", "definition_id": parts[0]["definition_id"]}
    with pytest.raises(ValidationFailed):
        link(users["editor"], painted, "sensor-current", part)
    foreign = op(
        users["outsider"],
        "definition.create",
        {
            "workspace_id": other_workspace,
            "kind": "development_need",
            "name": "Foreign need",
            "content": {"development_need": {"need": "cable", "summary": "Foreign work."}},
        },
    )
    with pytest.raises(NotFound):
        link(
            users["editor"],
            painted,
            "sensor-current",
            {"kind": "development_need", "definition_id": foreign["definition_id"]},
        )
    with pytest.raises(NotFound):
        link(
            users["editor"],
            painted,
            "sensor-current",
            {"kind": "mechanical_proposal", "proposal_draft_id": foreign["definition_id"]},
        )
    assert DevelopmentLink.objects.count() == 1


def test_needs_are_typed_workspace_items_that_projects_reference(users, project, painted):
    created = propose(users["contributor"], painted, "paint-sealing", "enclosure", "Synthetic lid")
    definition_id = created["target"]["definition_id"]
    workspace_id = workspace_of(project)
    # The need lives in the workspace library; any project may reference it.
    other = op(users["owner"], "project.create", {"name": "Synthetic second bench"})
    for project_id in (project, other["project_id"]):
        current = op(users["viewer"], "project.references", {"project_id": project_id})
        op(
            users["contributor"],
            "project.add_reference",
            {
                "project_id": project_id,
                "kind": "definition",
                "target_id": definition_id,
                "role": "development proposal",
            },
            expected_state=current["state"],
        )
    listed = op(
        users["viewer"],
        "configuration.list_development",
        {"workspace_id": workspace_id, "need_definition_id": definition_id},
    )
    assert [(e["rule_key"], e["configuration_name"]) for e in listed["links"]] == [
        ("paint-sealing", "Synthetic build configuration")
    ]

    # Typed content: physical qualification cannot be claimed and no foreign fields fit.
    need_draft = created["need_draft"]
    body = {"need": "enclosure", "summary": "Lid work.", "physical_qualification": True}
    for content in (
        {"development_need": body},
        {"development_need": {"need": "rocket", "summary": "x"}},
    ):
        with pytest.raises(ValidationFailed):
            op(
                users["contributor"],
                "draft.update",
                {"draft_id": need_draft["draft_id"], "changes": content},
                expected_state=need_draft["state"],
            )
    with pytest.raises(ValidationFailed):
        op(
            users["contributor"],
            "draft.update",
            {"draft_id": need_draft["draft_id"], "changes": {"extra": 1}},
            expected_state=need_draft["state"],
        )
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "definition.create",
            {
                "workspace_id": workspace_id,
                "kind": "component",
                "name": "Mislabelled",
                "content": {"development_need": {"need": "cable", "summary": "x"}},
            },
        )


def test_unlink_is_recorded_once_and_rows_stay_append_only(users, project, painted):
    created = propose(users["contributor"], painted, "paint-sealing")
    # The hint mirrors the operation: the creator and design editors, not viewers.
    for name, expected in (("contributor", True), ("editor", True), ("viewer", False)):
        links = resolve(users[name], painted)["development"]["links"]
        assert links[0]["can_unlink"] is expected
    with pytest.raises(PermissionDenied):
        op(
            users["viewer"],
            "configuration.unlink_development",
            {"link_id": created["link_id"], "reason": "Not needed"},
        )
    removed = op(
        users["contributor"],
        "configuration.unlink_development",
        {"link_id": created["link_id"], "reason": "Superseded by a sealing choice."},
    )
    assert removed["removed"] is True
    with pytest.raises(Conflict):
        op(
            users["editor"],
            "configuration.unlink_development",
            {"link_id": created["link_id"], "reason": "Again"},
        )
    preview = resolve(users["viewer"], painted)
    assert preview["development"] == {**preview["development"], "outcome": "invalid", "links": []}
    # The need itself remains in the library; history lists the removed link.
    assert Definition.objects.filter(id=created["target"]["definition_id"]).exists()
    history = op(
        users["viewer"],
        "configuration.list_development",
        {"workspace_id": workspace_of(project), "include_removed": True},
    )
    assert [e["removal_reason"] for e in history["links"]] == ["Superseded by a sealing choice."]
    # A new link to the same rule may be made after removal.
    target = {"kind": "development_need", "definition_id": created["target"]["definition_id"]}
    link(users["editor"], painted, "paint-sealing", target)

    row = DevelopmentLink.objects.get(id=created["link_id"])
    for statement in (
        lambda: DevelopmentLink.objects.filter(id=row.id).update(basis="Rewritten"),
        lambda: DevelopmentLink.objects.filter(id=row.id).update(removal_reason="Changed"),
        lambda: DevelopmentLink.objects.filter(id=row.id).delete(),
    ):
        with pytest.raises(DatabaseError), transaction.atomic():
            statement()


def test_propose_is_idempotent_and_replays_one_need(users, project, painted):
    first = propose(users["contributor"], painted, "paint-sealing", idempotency_key="need-1")
    again = propose(users["contributor"], painted, "paint-sealing", idempotency_key="need-1")
    assert again["link_id"] == first["link_id"]
    assert Definition.objects.filter(kind="development_need").count() == 1
    assert DevelopmentLink.objects.count() == 1
