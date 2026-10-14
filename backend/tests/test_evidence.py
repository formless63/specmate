"""EVD-001: requirements, claims, calculations, checks, reviews and measurements stay distinct."""

import pytest

from specmate.evidence.taxonomy import KIND_INFO
from specmate.facts.models import FactAssertion, FactSubject
from specmate.operations import NotFound, ValidationFailed

from .conftest import op
from .scope_helpers import workspace_of
from .test_builds import build, build_payload, recipe, source  # noqa: F401
from .test_cable_test_intent import (  # noqa: F401
    cable,
    plan,
)
from .test_cable_test_intent import (
    create as create_plan,
)
from .test_cable_test_intent import (
    freeze as freeze_plan,
)
from .test_facts import append, fact, subject
from .test_physical_facts import measurement, register, unit_subjects  # noqa: F401
from .test_transports import api


def listing(user, workspace, **changes):
    return op(user, "evidence.list", {"workspace_id": workspace_of(workspace), **changes})


def by_id(result):
    return {item["evidence_id"]: item for item in result["items"]}


def current(magnitude):
    return {"kind": "quantity", "dimension": "current", "unit": "A", "magnitude": magnitude}


def rating_fact():
    return fact(
        "current_rating",
        value=current("2"),
        purpose="rating",
        role="upper_bound",
        provenance={
            "method": "source_observation",
            "evidence": [{"kind": "citation", "citation": "Manually typed from a label."}],
        },
    )


@pytest.fixture
def populated(users, project, plan, build, unit_subjects):  # noqa: F811
    editor = users["editor"]
    design = subject(editor, {"kind": "project", "project_id": project})
    claim = append(editor, design, rating_fact())
    calculation = append(
        editor,
        claim,
        fact(
            "derived_limit",
            value=current("1"),
            role="upper_bound",
            provenance={
                "method": "calculation",
                "formula": "rating / 2",
                "algorithm_version": "synthetic-1",
                "evidence": [
                    {"kind": "assertion", "assertion_id": claim["assertion"]["assertion_id"]}
                ],
            },
        ),
    )
    review = append(
        editor,
        calculation,
        fact(
            "association",
            role="actual",
            purpose="general",
            value={"kind": "text", "text": "Reviewed association"},
            provenance={
                "method": "reviewed_association",
                "evidence": [{"kind": "citation", "citation": "Synthetic review"}],
            },
        ),
    )
    unit = register(users["owner"], unit_subjects[2][0])
    measured = append(users["owner"], unit, measurement())
    requirement = freeze_plan(users["owner"], create_plan(users["owner"], project, plan))
    return {
        "claim": claim["assertion"]["assertion_id"],
        "calculation": calculation["assertion"]["assertion_id"],
        "review": review["assertion"]["assertion_id"],
        "measurement": measured["assertion"]["assertion_id"],
        "requirement": requirement["revision_id"],
        "build": build["build_id"],
        "unit": unit_subjects[1][0]["unit_id"],
    }


def test_taxonomy_names_what_every_kind_never_establishes(users):
    result = op(users["viewer"], "evidence.taxonomy", {})
    assert {row["kind"] for row in result["kinds"]} == set(KIND_INFO)
    assert all(row["does_not_establish"] and row["establishes"] for row in result["kinds"])
    assert "passed" not in {row["kind"] for row in result["kinds"]}


def test_each_source_maps_to_its_own_kind_with_method_subject_and_provenance(
    users, project, populated, workspace
):
    items = by_id(listing(users["viewer"], workspace))
    claim = items[f"fact:{populated['claim']}"]
    assert claim["kind"] == "source_claim"
    assert claim["statement"].startswith("Declared rating:")
    assert claim["basis"] == {
        "origin": "manual_entry",
        "references": ["citation:Manually typed from a label."],
        "independently_verified": False,
    }
    assert any("not a measured result" in text for text in claim["does_not_establish"])
    assert claim["subject"]["scope"] == "project"

    calculation = items[f"fact:{populated['calculation']}"]
    assert calculation["kind"] == "calculation"
    assert calculation["method"]["formula"] == "rating / 2"
    assert calculation["basis"]["references"] == [f"assertion:{populated['claim']}"]

    assert items[f"fact:{populated['review']}"]["kind"] == "review"

    measured = items[f"fact:{populated['measurement']}"]
    assert measured["kind"] == "physical_measurement"
    assert measured["subject"]["scope"] == "actual"
    assert measured["method"]["instrument"] and measured["method"]["procedure"]
    assert measured["observed_at"]
    assert measured["basis"]["origin"] == "instrument_record"

    requirement = items[f"requirement:{populated['requirement']}"]
    assert requirement["kind"] == "requirement"
    assert "Physical test: not performed." in requirement["warnings"]
    assert requirement["status"] == "declared"

    check = items[f"build:{populated['build']}"]
    assert check["kind"] == "generated_check"
    assert check["basis"]["origin"] == "tool_receipt"
    assert check["warnings"] == ["No terminal receipt is recorded yet."]

    unit = items[f"unit:{populated['unit']}"]
    assert unit["kind"] == "physical_observation"
    assert "measurement" in " ".join(unit["does_not_establish"])
    assert all(item["physical_qualification"] is False for item in items.values())
    # Only the physical measurement is displayed as a physical measurement.
    assert [k for k, v in items.items() if v["kind"] == "physical_measurement"] == [
        f"fact:{populated['measurement']}"
    ]


def test_filters_pagination_and_subject_scope(users, project, populated, workspace):
    only = listing(users["viewer"], workspace, kinds=["review", "calculation"])
    assert {item["kind"] for item in only["items"]} == {"review", "calculation"}
    claims = listing(users["viewer"], workspace, kinds=["source_claim"])
    assert all(item["kind"] == "source_claim" for item in claims["items"])
    seen, offset = [], 0
    while True:
        page = listing(users["viewer"], workspace, offset=offset, limit=2)
        seen += [item["evidence_id"] for item in page["items"]]
        if not page["has_more"]:
            break
        offset += 2
    assert len(seen) == len(set(seen)) == len(listing(users["viewer"], workspace)["items"])
    subject_id = FactAssertion.objects.get(id=populated["claim"]).subject_id
    scoped = listing(users["viewer"], workspace, subject_id=str(subject_id))
    assert {item["kind"] for item in scoped["items"]} == {"source_claim", "calculation", "review"}
    with pytest.raises(ValidationFailed):
        op(
            users["viewer"],
            "evidence.list",
            {"workspace_id": workspace, "kinds": ["review", "review"]},
        )
    with pytest.raises(ValidationFailed):
        op(users["viewer"], "evidence.list", {"workspace_id": workspace, "kinds": ["passed"]})


def test_outsiders_and_other_workspaces_see_nothing(
    users, project, populated, workspace, other_workspace
):
    with pytest.raises(NotFound):
        listing(users["outsider"], workspace)
    assert listing(users["outsider"], other_workspace)["items"] == []
    with pytest.raises(NotFound):
        listing(users["outsider"], workspace, subject_id=str(FactSubject.objects.first().id))


def test_measurement_requires_an_actual_unit_and_leaves_nothing_when_rejected(users, project):
    design = subject(users["editor"], {"kind": "project", "project_id": project})
    content = fact(
        role="actual",
        provenance={
            "method": "measurement",
            "observed_at": "2026-01-01T12:00:00Z",
            "instrument": "Synthetic caliper",
            "procedure": "Synthetic procedure",
            "evidence": [{"kind": "citation", "citation": "Synthetic record"}],
        },
    )
    with pytest.raises(ValidationFailed):
        append(users["editor"], design, content, idempotency_key="design-measure")
    assert FactAssertion.objects.count() == 0
    assert FactSubject.objects.get(id=design["subject_id"]).version == 1


def test_legacy_design_scope_measurement_never_reads_as_physical(users, project, workspace):
    design = subject(users["editor"], {"kind": "project", "project_id": project})
    row = FactSubject.objects.get(id=design["subject_id"])
    content = fact(
        provenance={
            "method": "measurement",
            "observed_at": "2026-01-01T12:00:00Z",
            "instrument": "Synthetic caliper",
            "procedure": "Synthetic procedure",
            "evidence": [{"kind": "citation", "citation": "Synthetic record"}],
        }
    )
    FactAssertion.objects.create(
        subject=row,
        sequence=1,
        property="width",
        status="known",
        method="measurement",
        content=content,
        canonical_value={"kind": "quantity", "dimension": "length", "unit": "m", "magnitude": "1"},
        actor=users["editor"],
        request_id="legacy",
    )
    (item,) = listing(users["viewer"], workspace)["items"]
    assert item["kind"] == "source_claim"
    assert item["warnings"]
    assert listing(users["viewer"], workspace, kinds=["physical_measurement"])["items"] == []


def test_http_adapters_use_the_same_scoped_read_model(users, project, populated, workspace):
    client = api(users["viewer"])
    taxonomy = client.get("/api/v0/evidence/taxonomy")
    assert taxonomy.status_code == 200 and len(taxonomy.json()["kinds"]) == len(KIND_INFO)
    response = client.get(f"/api/v0/evidence/workspaces/{workspace}?kind=review&kind=calculation")
    assert response.status_code == 200
    assert {item["kind"] for item in response.json()["items"]} == {"review", "calculation"}
    assert api(users["outsider"]).get(f"/api/v0/evidence/workspaces/{workspace}").status_code == 404
    assert api().get(f"/api/v0/evidence/workspaces/{workspace}").status_code in {401, 403}
