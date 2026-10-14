"""EVD-003: changed design state links to stale or inapplicable evidence; observations stay."""

import copy

import pytest

from specmate.evidence.models import RecordedResult
from specmate.facts.models import FactAssertion
from specmate.operations import NotFound

from .conftest import op
from .scope_helpers import workspace_of
from .test_design import freeze as freeze_draft
from .test_facts import append, fact, subject
from .test_firmware import (  # noqa: F401
    attempt,
    board,
    intake,
    recipe,
    source,
    sources,
)
from .test_firmware_impact import observation, payload
from .test_firmware_occurrences import frozen_firmware
from .test_physical_units import unit_payload
from .test_transports import api


def read(user, project, revision, **changes):
    return op(
        user,
        "evidence.applicability",
        {"workspace_id": workspace_of(project), "revision_id": revision["revision_id"], **changes},
    )


def rows(result):
    return {row["item"]["evidence_id"]: row for row in result["items"]}


@pytest.fixture
def history(users, project, workspace):
    owner = users["owner"]
    draft = op(
        owner,
        "definition.create",
        {
            "workspace_id": workspace,
            "kind": "wire_stock",
            "name": "Synthetic cable",
            "content": {"termination": {"style": "crimp-A"}, "length_mm": 100},
        },
    )
    first = freeze_draft(owner, draft["draft_id"], draft["state"])
    unit = op(
        owner,
        "physical_units.register",
        unit_payload(first["revision_id"], "APPL-UNIT-A"),
        idempotency_key="appl-unit-a",
    )
    claim = append(
        owner,
        subject(owner, {"kind": "revision", "revision_id": first["revision_id"]}),
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
    measured = append(
        owner,
        subject(owner, {"kind": "physical_unit", "unit_id": unit["unit_id"]}),
        fact(
            "continuity_checked",
            role="actual",
            value={"kind": "boolean", "value": True},
            provenance={
                "method": "measurement",
                "observed_at": "2026-01-01T12:00:00Z",
                "instrument": "Synthetic meter",
                "procedure": "Synthetic procedure; no real measurement.",
                "evidence": [{"kind": "citation", "citation": "Synthetic log"}],
            },
        ),
    )
    return {"draft": draft, "first": first, "unit": unit, "claim": claim, "measured": measured}


def change_termination(users, history):
    owner = users["owner"]
    state = history["first"]["draft"]["state"]
    updated = op(
        owner,
        "draft.update",
        {
            "draft_id": history["draft"]["draft_id"],
            "changes": {"termination": {"style": "solder-B"}},
        },
        expected_state=state,
    )
    return freeze_draft(owner, history["draft"]["draft_id"], updated["state"])


def test_changed_termination_preserves_results_and_flags_limited_applicability(
    users, project, history
):
    claim_id = f"fact:{history['claim']['assertion']['assertion_id']}"
    unit_id = f"fact:{history['measured']['assertion']['assertion_id']}"
    stored = {row.id: copy.deepcopy(row.content) for row in FactAssertion.objects.all()}

    exact = rows(read(users["viewer"], project, history["first"]))
    assert exact[claim_id]["applicability"]["status"] == "exact_revision"
    assert exact[unit_id]["applicability"]["status"] == "exact_unit_only"
    assert "other unit" in exact[unit_id]["applicability"]["reason"]

    second = change_termination(users, history)
    result = read(users["viewer"], project, second)
    assert result["revision"]["number"] == 2 and result["revision"]["is_latest"]
    assert result["historical_results_modified"] is False
    found = rows(result)
    for evidence_id in (claim_id, unit_id):
        applicability = found[evidence_id]["applicability"]
        assert applicability["status"] == "stale_earlier_revision"
        assert applicability["observation_preserved"] is True
        assert applicability["qualifies_selected_revision"] is False
        assert applicability["evidence_revision_number"] == 1
        assert applicability["evidence_revision_id"] == history["first"]["revision_id"]
        assert applicability["change"]["content_changed"] is True
        assert applicability["change"]["changed_sections"] == ["termination.style"]
        assert (applicability["change"]["from_number"], applicability["change"]["to_number"]) == (
            1,
            2,
        )
    assert "revision 1" in found[claim_id]["applicability"]["reason"]
    # The observations themselves are byte-for-byte what was recorded.
    assert {row.id: row.content for row in FactAssertion.objects.all()} == stored
    assert FactAssertion.objects.count() == 2

    # Looking back from the original revision still reads the same evidence as exact, and
    # evidence about a later revision is inapplicable to it.
    later = append(
        users["owner"],
        subject(users["owner"], {"kind": "revision", "revision_id": second["revision_id"]}),
        fact(
            "continuity_checked",
            role="actual",
            value={"kind": "boolean", "value": True},
            provenance={
                "method": "source_observation",
                "evidence": [{"kind": "citation", "citation": "Synthetic review of revision 2"}],
            },
        ),
    )
    back = rows(read(users["viewer"], project, history["first"]))
    later_id = f"fact:{later['assertion']['assertion_id']}"
    assert back[claim_id]["applicability"]["status"] == "exact_revision"
    assert back[later_id]["applicability"]["status"] == "inapplicable_later_revision"
    assert back[later_id]["applicability"]["change"] is None
    forward = rows(read(users["viewer"], project, second))
    assert forward[later_id]["applicability"]["status"] == "exact_revision"


def test_applicability_is_scoped_to_the_workspace_and_readers(users, project, history):
    second = change_termination(users, history)
    with pytest.raises(NotFound):
        read(users["outsider"], project, second)
    client = api(users["viewer"])
    body = client.get(
        f"/api/v0/evidence/workspaces/{workspace_of(project)}/applicability/{second['revision_id']}"
    ).json()
    assert body["revision"]["number"] == 2 and len(body["items"]) == 2
    with pytest.raises(NotFound):
        op(
            users["viewer"],
            "evidence.applicability",
            {
                "workspace_id": workspace_of(project),
                "revision_id": "00000000-0000-4000-8000-000000000000",
            },
        )


def test_unchanged_refreeze_reports_identical_content_without_claiming_qualification(
    users, project, history
):
    owner = users["owner"]
    state = history["first"]["draft"]["state"]
    refreeze = freeze_draft(owner, history["draft"]["draft_id"], state)
    result = read(users["viewer"], project, refreeze)
    row = next(iter(rows(result).values()))
    assert row["applicability"]["status"] == "stale_earlier_revision"
    assert row["applicability"]["change"]["changed_sections"] == []
    assert row["applicability"]["qualifies_selected_revision"] is False


def test_recorded_firmware_impact_goes_stale_when_assertions_arrive_in_its_scope(
    users,
    project,
    sources,  # noqa: F811
    board,  # noqa: F811
):
    first = frozen_firmware(users, project, sources, board)
    second = frozen_firmware(users, project, sources, board, value="900")
    comparison = payload(project, first, second)
    record = op(users["contributor"], "evidence.record_firmware_impact", {"comparison": comparison})
    assert record["stale"] is False and record["newer_assertions"] is False
    stored = copy.deepcopy(RecordedResult.objects.get(id=record["record_id"]).result)

    # An assertion on a subject outside the compared baseline scope does not stale it.
    observation(users, {"kind": "revision", "revision_id": second["revision_id"]})
    read_back = op(users["viewer"], "evidence.read_recorded", {"record_id": record["record_id"]})
    assert read_back["stale"] is False and read_back["newer_assertions"] is False

    # One arriving on the exact baseline revision does, without rewriting the record.
    arrived = observation(users, {"kind": "revision", "revision_id": first["revision_id"]})
    read_back = op(users["viewer"], "evidence.read_recorded", {"record_id": record["record_id"]})
    assert read_back["stale"] is True and read_back["newer_assertions"] is True
    assert all(not pin["newer_revision_exists"] for pin in read_back["pins"])
    assert read_back["result"] == stored
    assert read_back["result_sha256"] == record["result_sha256"]
    assert RecordedResult.objects.get(id=record["record_id"]).result == stored

    listed = op(users["viewer"], "evidence.list", {"workspace_id": workspace_of(project)})
    item = next(i for i in listed["items"] if i["evidence_id"] == f"recorded:{record['record_id']}")
    assert item["stale"] is True
    assert any("new fact assertions arrived" in w for w in item["warnings"])
    assert not any(arrived["assertion_id"] in w for w in item["warnings"])


def subject_test(user, subject, key):
    return op(
        user,
        "evidence.record_test",
        {
            "subject": subject,
            "test_kind": "continuity",
            "procedure": "Synthetic bench procedure; no actual test performed here.",
            "instruments": [{"name": "Synthetic meter", "calibration": "unknown"}],
            "observed_at": "2026-01-01T12:00:00Z",
            "criterion": "Mapped terminals conduct",
            "finding": "criterion_met",
        },
        idempotency_key=key,
    )


def test_subject_tests_read_against_their_stored_design_revision(users, project, history):
    owner = users["owner"]
    first = history["first"]
    work = op(
        owner,
        "inventory.create_work_batch",
        {
            "revision_id": first["revision_id"],
            "kind": "batch",
            "label": "Applicability batch",
            "planned_units": 2,
        },
        idempotency_key="appl-batch",
    )
    on_unit = subject_test(
        owner, {"kind": "physical_unit", "unit_id": history["unit"]["unit_id"]}, "appl-test-u"
    )
    on_batch = subject_test(
        owner, {"kind": "work_batch", "work_batch_id": work["work_batch_id"]}, "appl-test-b"
    )
    unit_id, batch_id = f"test:{on_unit['test_id']}", f"test:{on_batch['test_id']}"

    exact = rows(read(users["viewer"], project, first))
    assert exact[unit_id]["applicability"]["status"] == "exact_unit_only"
    assert exact[batch_id]["applicability"]["status"] == "exact_batch_only"
    assert "as a whole" in exact[batch_id]["applicability"]["reason"]
    assert exact[unit_id]["item"]["stale"] is False
    assert not any(w.startswith("Stale") for w in exact[unit_id]["item"]["warnings"])
    listed = op(users["viewer"], "evidence.list", {"workspace_id": workspace_of(project)})
    assert {
        i["evidence_id"]: i["stale"] for i in listed["items"] if i["source"] == "subject_tests"
    } == {
        unit_id: False,
        batch_id: False,
    }

    second = change_termination(users, history)
    later = rows(read(users["viewer"], project, second))
    for evidence_id, word in ((unit_id, "unit"), (batch_id, "work batch")):
        row = later[evidence_id]
        assert row["applicability"]["status"] == "stale_earlier_revision"
        assert row["applicability"]["evidence_revision_number"] == first["number"]
        assert f"{word} built to revision {first['number']}" in row["applicability"]["reason"]
        assert "termination.style" in row["applicability"]["change"]["changed_sections"]
        assert row["applicability"]["qualifies_selected_revision"] is False
        assert row["item"]["stale"] is True
        assert any(f"revision {second['number']} is newer" in w for w in row["item"]["warnings"])
    # Read against the earlier revision, the test is exact but still warns about the newer one.
    earlier = rows(read(users["viewer"], project, first))
    assert earlier[unit_id]["applicability"]["status"] == "exact_unit_only"
    assert earlier[unit_id]["item"]["stale"] is True

    listed = op(users["viewer"], "evidence.list", {"workspace_id": workspace_of(project)})
    tests = {i["evidence_id"]: i for i in listed["items"] if i["source"] == "subject_tests"}
    assert tests[unit_id]["stale"] is True and tests[batch_id]["stale"] is True
    read_back = op(users["viewer"], "evidence.read_test", {"test_id": on_unit["test_id"]})
    assert read_back["stale"] is True
    assert read_back["design_revision_number"] == first["number"]
    assert read_back["latest_revision_number"] == second["number"]
    # The stored record itself is unchanged.
    assert {k: read_back[k] for k in on_unit} == on_unit
    assert read_back["design_revision_id"] == first["revision_id"]


def test_subject_tests_need_current_authority_to_appear(users, project, history):
    owner = users["owner"]
    done = subject_test(
        owner, {"kind": "physical_unit", "unit_id": history["unit"]["unit_id"]}, "appl-test-x"
    )
    assert f"test:{done['test_id']}" in rows(read(users["viewer"], project, history["first"]))
    with pytest.raises(NotFound):
        read(users["outsider"], project, history["first"])
