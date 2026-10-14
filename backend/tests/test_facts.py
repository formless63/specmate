import copy
import json
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal, Underflow, localcontext
from threading import Barrier
from uuid import UUID

import pytest
from django.db import DatabaseError, close_old_connections, connection, transaction

from specmate.access.models import Membership
from specmate.design.models import Snapshot
from specmate.facts.models import AssertionInput, AssertionSource, FactAssertion, FactSubject
from specmate.facts.queries import read_facts
from specmate.facts.units import convert
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)
from specmate.operations.models import IdempotencyRecord

from .conftest import op
from .test_sources import ORIGINAL, files, register
from .test_transports import api, post_op


def subject(user, target):
    return op(user, "facts.register_subject", {"target": target})


def fact(property_name="width", magnitude="10", unit="mm", **changes):
    content = {
        "property": property_name,
        "status": "known",
        "purpose": "manufacturing",
        "role": "nominal",
        "value": {"kind": "quantity", "dimension": "length", "unit": unit, "magnitude": magnitude},
        "basis": "Original synthetic assertion; no physical qualification.",
        "provenance": {
            "method": "source_observation",
            "evidence": [
                {"kind": "citation", "citation": "Synthetic drawing, revision A, dimension 1."}
            ],
        },
    }
    content.update(changes)
    return content


def append(user, ledger, content, **context):
    return op(
        user,
        "facts.append",
        {"subject_id": ledger["subject_id"], "fact": content},
        expected_state=ledger["state"],
        **context,
    )


def design_revision(user, project, kind="part"):
    draft = op(
        user, "definition.create", {"project_id": project, "kind": kind, "name": "Synthetic part"}
    )
    revision = op(
        user, "draft.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"]
    )
    return draft, revision


@pytest.fixture
def ledger(users, project):
    return subject(users["editor"], {"kind": "project", "project_id": project})


def test_absent_allowance_stays_unknown_and_conflicting_dimensions_preserve_all_sources(
    users, ledger
):
    absent = read_facts(users["viewer"], ledger["subject_id"], "cut_allowance")
    assert absent["assessments"]["cut_allowance"] == [
        {
            "status": "unknown",
            "value": None,
            "assertion_ids": [],
            "reason": "No assertion records this property.",
        }
    ]
    first = append(users["editor"], ledger, fact())
    original = copy.deepcopy(first["assertion"])
    second = append(users["editor"], first, fact(magnitude="12"))
    result = read_facts(users["viewer"], ledger["subject_id"])
    assessment = result["assessments"]["width"][0]
    assert assessment["status"] == "conflicting" and assessment["value"] is None
    assert assessment["assertion_ids"] == [
        first["assertion"]["assertion_id"],
        second["assertion"]["assertion_id"],
    ]
    assert result["assertions"][0] == original
    assert [row["fact"]["value"]["magnitude"] for row in result["assertions"]] == ["10", "12"]
    unknown = append(users["editor"], second, fact("cut_allowance", status="unknown", value=None))
    allowance = read_facts(users["viewer"], unknown["subject_id"], "cut_allowance")
    assert allowance["assertions"][0]["canonical_value"] is None
    assert allowance["assessments"]["cut_allowance"][0]["status"] == "unknown"


def test_units_preserve_original_values_and_canonical_equalities_are_independently_known(
    users, ledger
):
    first = append(users["editor"], ledger, fact(magnitude="0.5", unit="in"))
    second = append(users["editor"], first, fact(magnitude="12.7", unit="mm"))
    result = read_facts(users["viewer"], ledger["subject_id"])
    assert result["assertions"][0]["fact"]["value"]["unit"] == "in"
    assert result["assertions"][0]["canonical_value"]["magnitude"] == "12.7"
    assert result["assessments"]["width"][0]["status"] == "known"
    temperature = fact(
        "temperature",
        role="actual",
        value={"kind": "quantity", "dimension": "temperature", "unit": "degC", "magnitude": "25"},
    )
    third = append(users["editor"], second, temperature)
    assert third["assertion"]["canonical_value"] == {
        "kind": "quantity",
        "dimension": "temperature",
        "unit": "K",
        "magnitude": "298.15",
    }
    tolerance = fact(
        "temperature",
        role="tolerance",
        value={
            "kind": "tolerance",
            "dimension": "temperature",
            "unit": "degC",
            "minus": "2",
            "plus": "3",
        },
    )
    fourth = append(users["editor"], third, tolerance)
    assert fourth["assertion"]["canonical_value"]["minus"] == "2"
    assert fourth["assertion"]["canonical_value"]["plus"] == "3"
    assert len(read_facts(users["viewer"], ledger["subject_id"])["assessments"]["temperature"]) == 2


def test_conditions_purpose_roles_and_overlapping_ranges_do_not_silently_select_a_value(
    users, ledger
):
    condition = {
        "property": "temperature",
        "status": "known",
        "value": {
            "kind": "quantity",
            "dimension": "temperature",
            "unit": "degC",
            "magnitude": "25",
        },
    }
    first = append(users["editor"], ledger, fact(conditions=[condition]))
    equal_condition = copy.deepcopy(condition)
    equal_condition["value"].update(unit="K", magnitude="298.15")
    second = append(users["editor"], first, fact(magnitude="12", conditions=[equal_condition]))
    third = append(users["editor"], second, fact(magnitude="15", purpose="illustration"))
    fourth = append(users["editor"], third, fact(role="upper_bound", magnitude="20"))
    fifth = append(
        users["editor"],
        fourth,
        fact(
            "interval",
            role="actual",
            value={
                "kind": "range",
                "dimension": "length",
                "unit": "mm",
                "lower": "10",
                "upper": "12",
            },
        ),
    )
    sixth = append(
        users["editor"],
        fifth,
        fact(
            "interval",
            role="actual",
            value={
                "kind": "range",
                "dimension": "length",
                "unit": "mm",
                "lower": "11",
                "upper": "13",
            },
        ),
    )
    result = read_facts(users["viewer"], sixth["subject_id"])
    assert len(result["assessments"]["width"]) == 3
    assert result["assessments"]["width"][0]["status"] == "conflicting"
    assert result["assessments"]["width"][1]["purpose"] == "illustration"
    assert result["assessments"]["width"][2]["role"] == "upper_bound"
    assert result["assessments"]["interval"][0]["status"] == "known"
    assert result["assessments"]["interval"][0]["value"] is None


@pytest.mark.parametrize(
    "changes",
    [
        {"status": "unknown"},
        {"status": "known", "value": None},
        {"value": {"kind": "quantity", "dimension": "length", "unit": "g", "magnitude": "10"}},
        {
            "value": {
                "kind": "quantity",
                "dimension": "length",
                "unit": "furlong",
                "magnitude": "10",
            }
        },
        {"value": {"kind": "quantity", "dimension": "length", "unit": "mm", "magnitude": "NaN"}},
        {
            "value": {
                "kind": "range",
                "dimension": "length",
                "unit": "mm",
                "lower": "3",
                "upper": "1",
            }
        },
        {
            "value": {
                "kind": "tolerance",
                "dimension": "length",
                "unit": "mm",
                "minus": "-1",
                "plus": "1",
            }
        },
        {
            "provenance": {
                "method": "measurement",
                "evidence": [{"kind": "citation", "citation": "Example"}],
            }
        },
        {
            "provenance": {
                "method": "calculation",
                "evidence": [{"kind": "citation", "citation": "Example"}],
            }
        },
        {
            "provenance": {
                "method": "preference",
                "evidence": [{"kind": "citation", "citation": "Example"}],
            }
        },
        {"basis": ""},
    ],
)
def test_invalid_facts_fail_without_changing_ledger_or_evidence(users, ledger, changes):
    with pytest.raises(ValidationFailed):
        append(users["editor"], ledger, fact(**changes), idempotency_key="invalid")
    assert FactAssertion.objects.count() == 0
    assert FactSubject.objects.get(id=ledger["subject_id"]).version == 1
    assert not IdempotencyRecord.objects.filter(operation="facts.append").exists()


def test_source_observation_review_calculation_measurement_and_preference_remain_distinct(
    users, ledger
):
    first = append(users["editor"], ledger, fact())
    calculation = fact(
        "half_width",
        magnitude="5",
        provenance={
            "method": "calculation",
            "formula": "width / 2",
            "algorithm_version": "synthetic-1",
            "evidence": [{"kind": "assertion", "assertion_id": first["assertion"]["assertion_id"]}],
        },
    )
    second = append(users["editor"], first, calculation)
    measurement = fact(
        magnitude="11",
        role="actual",
        provenance={
            "method": "measurement",
            "observed_at": "2026-01-01T12:00:00Z",
            "instrument": "Synthetic caliper",
            "procedure": "Synthetic procedure; no physical measurement performed by this test.",
            "evidence": [
                {"kind": "citation", "citation": "Original synthetic measurement record."}
            ],
        },
    )
    # A measurement observes an actual unit; a design-scope ledger cannot hold one.
    with pytest.raises(ValidationFailed):
        append(users["editor"], second, measurement)
    third = second
    reviewed = fact(
        "association",
        role="actual",
        purpose="general",
        value={"kind": "text", "text": "Reviewed candidate association"},
        provenance={
            "method": "reviewed_association",
            "evidence": [{"kind": "citation", "citation": "Synthetic review"}],
        },
    )
    fourth = append(users["editor"], third, reviewed)
    preference = fact(
        "color",
        role="actual",
        purpose="preference",
        value={"kind": "text", "text": "Blue"},
        provenance={
            "method": "preference",
            "evidence": [{"kind": "citation", "citation": "Declared preference"}],
        },
    )
    fifth = append(users["editor"], fourth, preference)
    result = read_facts(users["viewer"], fifth["subject_id"])
    assert [row["fact"]["provenance"]["method"] for row in result["assertions"]] == [
        "source_observation",
        "calculation",
        "reviewed_association",
        "preference",
    ]
    assert [row["evidence_kind"] for row in result["assertions"]] == [
        "source_claim",
        "calculation",
        "review",
        "preference",
    ]
    assert all(row["evidence_status"] == "declared" for row in result["assertions"])
    assert AssertionInput.objects.get().input_assertion_id == UUID(
        first["assertion"]["assertion_id"]
    )


def test_subjects_use_real_identity_and_later_evidence_never_rewrites_frozen_revisions(
    users, project
):
    design, revision = design_revision(users["owner"], project)
    original = bytes(Snapshot.objects.get(id=revision["snapshot_id"]).canonical)
    definition_ledger = subject(
        users["editor"], {"kind": "definition", "definition_id": design["definition_id"]}
    )
    revision_ledger = subject(
        users["editor"], {"kind": "revision", "revision_id": revision["revision_id"]}
    )
    recorded = append(users["editor"], revision_ledger, fact())
    assert recorded["assertion"]["relation_to_design_state"] == "attached_evidence"
    assert definition_ledger["subject_id"] != revision_ledger["subject_id"]
    assert bytes(Snapshot.objects.get(id=revision["snapshot_id"]).canonical) == original
    for target in (
        {"kind": "revision", "revision_id": str(UUID(int=0))},
        {"kind": "definition", "definition_id": str(UUID(int=0))},
    ):
        with pytest.raises(NotFound):
            subject(users["editor"], target)


def test_repeated_occurrences_get_distinct_fact_ledgers_and_require_nested_access(users, project):
    _, revision = design_revision(users["owner"], project)
    assembly = op(
        users["owner"],
        "assembly.create",
        {
            "project_id": project,
            "name": "Repeated parts",
            "assembly": {
                "occurrences": [
                    {
                        "local_id": local_id,
                        "revision_id": revision["revision_id"],
                        "display_ref": "J1",
                    }
                    for local_id in ("left", "right")
                ]
            },
        },
    )
    frozen = op(
        users["owner"],
        "assembly.freeze",
        {"draft_id": assembly["draft_id"]},
        expected_state=assembly["state"],
    )
    targets = [
        {
            "kind": "occurrence",
            "snapshot_id": frozen["snapshot_id"],
            "path": [side],
            "feature_id": "connector-a.pin2",
        }
        for side in ("left", "right")
    ]
    ledgers = [subject(users["editor"], target) for target in targets]
    assert ledgers[0]["subject_id"] != ledgers[1]["subject_id"]
    append(users["editor"], ledgers[1], fact())
    assert (
        read_facts(users["viewer"], ledgers[0]["subject_id"], "width")["assessments"]["width"][0][
            "status"
        ]
        == "unknown"
    )
    with pytest.raises(NotFound):
        subject(users["editor"], {**targets[0], "path": ["missing"]})


def test_authority_stale_writes_replay_mismatch_and_project_namespaces(users, project, ledger):
    for name, error in (("viewer", PermissionDenied), ("outsider", NotFound)):
        with pytest.raises(error):
            append(users[name], ledger, fact())
        assert (
            post_op(
                api(users[name]),
                "facts.append",
                {"subject_id": ledger["subject_id"], "fact": fact()},
                expected_state=ledger["state"],
            ).status_code
            == error.http_status
        )
    first = append(users["editor"], ledger, fact(), idempotency_key="assertion")
    assert append(users["editor"], ledger, fact(), idempotency_key="assertion") == first
    with pytest.raises(IdempotencyMismatch):
        append(users["editor"], ledger, fact(magnitude="12"), idempotency_key="assertion")
    with pytest.raises(Conflict) as exc:
        append(users["editor"], ledger, fact())
    assert exc.value.details == {"current_state": "facts-v2"}
    Membership.objects.filter(project_id=project, user=users["editor"]).delete()
    with pytest.raises(NotFound):
        append(users["editor"], ledger, fact(), idempotency_key="assertion")
    other = op(users["owner"], "project.create", {"name": "Other synthetic project"})["project_id"]
    for project_id in (project, other):
        op(
            users["owner"],
            "facts.register_subject",
            {"target": {"kind": "project", "project_id": project_id}},
            idempotency_key="same-key",
        )
    assert (
        IdempotencyRecord.objects.filter(operation="facts.register_subject", key="same-key").count()
        == 2
    )


def test_registered_source_and_transitive_assertion_revoke_before_counts_replay_or_conflict(
    users, project, ledger
):
    remote = op(users["outsider"], "project.create", {"name": "Restricted synthetic project"})[
        "project_id"
    ]
    register(users["outsider"], remote, ORIGINAL)
    source = op(
        users["outsider"],
        "source.create_original_bundle",
        {"project_id": remote, "name": "Synthetic evidence", "files": files(ORIGINAL)},
    )
    Membership.objects.create(project_id=remote, user=users["editor"], role="viewer")
    content = fact(
        provenance={
            "method": "source_observation",
            "evidence": [
                {
                    "kind": "source_file",
                    "bundle_revision_id": source["revision_id"],
                    "path": "src/source.txt",
                }
            ],
        }
    )
    first = append(users["editor"], ledger, content, idempotency_key="sourced")
    assert AssertionSource.objects.count() == 1
    second_ledger = subject(users["editor"], {"kind": "project", "project_id": project})
    calculation = fact(
        "derived_width",
        provenance={
            "method": "calculation",
            "formula": "identity(width)",
            "algorithm_version": "synthetic-1",
            "evidence": [{"kind": "assertion", "assertion_id": first["assertion"]["assertion_id"]}],
        },
    )
    append(users["editor"], second_ledger, calculation)
    Membership.objects.filter(project_id=remote, user=users["editor"]).delete()
    for action in (
        lambda: read_facts(users["editor"], ledger["subject_id"]),
        lambda: append(users["editor"], ledger, content, idempotency_key="sourced"),
        lambda: append(users["editor"], ledger, fact()),
    ):
        with pytest.raises(NotFound) as exc:
            action()
        assert exc.value.details == {}
    response = api(users["editor"]).get(f"/api/v0/facts/subjects/{ledger['subject_id']}")
    assert response.status_code == 404 and response.json()["error"]["details"] == {}


@pytest.mark.parametrize(
    "table", ["facts_factassertion", "facts_assertionsource", "facts_assertioninput"]
)
def test_database_enforces_immutable_assertions_and_provenance_links(users, project, ledger, table):
    register(users["editor"], project, ORIGINAL)
    source = op(
        users["editor"],
        "source.create_original_bundle",
        {"project_id": project, "name": "Synthetic evidence", "files": files(ORIGINAL)},
    )
    first = append(
        users["editor"],
        ledger,
        fact(
            provenance={
                "method": "source_observation",
                "evidence": [
                    {
                        "kind": "source_file",
                        "bundle_revision_id": source["revision_id"],
                        "path": "src/source.txt",
                    }
                ],
            }
        ),
    )
    append(
        users["editor"],
        first,
        fact(
            "calculated",
            provenance={
                "method": "calculation",
                "formula": "identity(width)",
                "algorithm_version": "synthetic-1",
                "evidence": [
                    {"kind": "assertion", "assertion_id": first["assertion"]["assertion_id"]}
                ],
            },
        ),
    )
    for statement in (f"UPDATE {table} SET id = id", f"DELETE FROM {table}"):
        with pytest.raises(DatabaseError), transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(statement)
    with pytest.raises(DatabaseError), transaction.atomic():
        FactSubject.objects.filter(id=ledger["subject_id"]).update(kind="definition")


@pytest.mark.django_db(transaction=True)
def test_competing_fact_appends_have_one_winner(users, ledger):
    barrier = Barrier(2)

    def record(value):
        close_old_connections()
        barrier.wait(timeout=10)
        try:
            append(users["editor"], ledger, fact(magnitude=value))
            return "recorded"
        except Conflict:
            return "conflict"
        finally:
            # Healthy connections survive close_old_connections(); worker threads
            # must release their sessions before PostgreSQL test database teardown.
            connection.close()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(record, ("10", "12")))
    assert sorted(results) == ["conflict", "recorded"]
    assert FactAssertion.objects.count() == 1
    assert FactSubject.objects.get(id=ledger["subject_id"]).state_token == "facts-v2"


def test_api_and_job_read_share_assessments_and_paginate_without_forgetting_conflicts(
    users, ledger
):
    first = append(users["editor"], ledger, fact())
    append(users["editor"], first, fact(magnitude="12"))
    read = op(users["viewer"], "facts.read", {"subject_id": ledger["subject_id"], "limit": 1})
    assert len(read["assertions"]) == 1 and read["has_more"] is True
    assert read["assessments"]["width"][0]["status"] == "conflicting"
    response = api(users["viewer"]).get(f"/api/v0/facts/subjects/{ledger['subject_id']}?limit=1")
    assert response.status_code == 200 and response.json() == read
    with pytest.raises(ValidationFailed):
        op(
            users["viewer"],
            "facts.read",
            {"subject_id": ledger["subject_id"]},
            idempotency_key="read",
        )


@pytest.mark.parametrize("statuses", [("known", "not_applicable"), ("not_applicable", "known")])
def test_applicability_disagreement_is_conflicting_in_both_insertion_orders(
    users, ledger, statuses
):
    records = []
    current = ledger
    for status in statuses:
        current = append(
            users["editor"],
            current,
            fact(
                status=status,
                value=fact()["value"] if status == "known" else None,
            ),
        )
        records.append(current["assertion"]["assertion_id"])
    result = read_facts(users["viewer"], ledger["subject_id"], "width")
    assessment = result["assessments"]["width"][0]
    assert assessment["status"] == "conflicting"
    assert assessment["value"] is None
    assert assessment["assertion_ids"] == records
    assert [row["fact"]["status"] for row in result["assertions"]] == list(statuses)


@pytest.mark.parametrize("magnitude", ["1e-9999999", "-1e-9999999", "0e-9999999", "1e9999999"])
def test_extreme_decimal_exponents_are_rejected_before_precision_normalization(
    users, ledger, magnitude
):
    with pytest.raises(ValidationFailed):
        append(users["editor"], ledger, fact(magnitude=magnitude))
    assert not FactAssertion.objects.exists()


def test_small_known_magnitudes_convert_exactly_independent_of_ambient_decimal_context(
    users, ledger
):
    value = {"kind": "quantity", "dimension": "capacitance", "unit": "pF", "magnitude": "1e-12"}
    recorded = append(users["editor"], ledger, fact("capacitance", value=value))
    assert recorded["assertion"]["canonical_value"]["magnitude"] == "0.000000000000000000000001"
    with localcontext() as context:
        context.prec = 2
        assert convert(Decimal("12.345678901234"), "in") == ("mm", "313.5802440913436")
        assert convert(Decimal("1e-12"), "pF") == ("F", "0.000000000000000000000001")
    with pytest.raises(Underflow):
        convert(Decimal("1e-9999999"), "mm")


def test_source_paths_preserve_whitespace_and_bind_distinct_registered_bytes_and_rights(
    users, project, ledger
):
    entries = []
    for index, path in enumerate(("drawing.txt", " drawing.txt", "drawing.txt ")):
        data = f"original synthetic drawing {index}".encode()
        blob = register(users["editor"], project, data)
        entries.append(
            {
                "path": path,
                "sha256": blob["sha256"],
                "media_type": "text/plain",
                "rights": f"synthetic-rights-{index}",
            }
        )
    source = op(
        users["editor"],
        "source.create_original_bundle",
        {"project_id": project, "name": "Distinct synthetic source paths", "files": entries},
    )
    current = ledger
    for index, path in enumerate(("drawing.txt", " drawing.txt", "drawing.txt ")):
        current = append(
            users["editor"],
            current,
            fact(
                f"width_{index}",
                provenance={
                    "method": "source_observation",
                    "evidence": [
                        {
                            "kind": "source_file",
                            "bundle_revision_id": source["revision_id"],
                            "path": path,
                        }
                    ],
                },
            ),
        )
        assert current["assertion"]["fact"]["provenance"]["evidence"][0]["path"] == path
        assert current["assertion"]["source_files"] == [
            {
                "bundle_revision_id": source["revision_id"],
                "path": path,
                "sha256": entries[index]["sha256"],
                "rights": f"synthetic-rights-{index}",
            }
        ]


def test_feature_ids_are_exact_and_occurrence_path_whitespace_is_not_reinterpreted(users, project):
    design, _ = design_revision(users["owner"], project)
    targets = [
        {"kind": "definition", "definition_id": design["definition_id"], "feature_id": feature}
        for feature in ("pin-a", " pin-a", "pin-a ")
    ]
    subjects = [subject(users["editor"], target) for target in targets]
    assert len({row["subject_id"] for row in subjects}) == 3
    assert [row["target"]["feature_id"] for row in subjects] == ["pin-a", " pin-a", "pin-a "]
    with pytest.raises(ValidationFailed):
        subject(
            users["editor"],
            {"kind": "occurrence", "snapshot_id": str(UUID(int=0)), "path": [" left"]},
        )


@pytest.mark.parametrize("raw_magnitude", ["1e-9999999", "0.0", "0.125", "true"])
def test_http_numeric_floats_and_booleans_cannot_become_known_fact_magnitudes(
    users, ledger, raw_magnitude
):
    payload = {
        "operation": "facts.append",
        "request_id": "precise-fact-wire",
        "expected_state": ledger["state"],
        "payload": {"subject_id": ledger["subject_id"], "fact": fact(magnitude="wire-number")},
    }
    raw_body = json.dumps(payload).replace('"wire-number"', raw_magnitude)
    response = api(users["editor"]).post(
        "/api/v0/operations", data=raw_body, content_type="application/json"
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_failed"
    assert not FactAssertion.objects.exists()
    assert FactSubject.objects.get(id=ledger["subject_id"]).state_token == "facts-v1"


@pytest.mark.parametrize("magnitude, canonical", [(0, "0"), ("0.125", "0.125")])
def test_http_exact_integer_zero_and_decimal_string_fraction_are_known_values(
    users, ledger, magnitude, canonical
):
    response = post_op(
        api(users["editor"]),
        "facts.append",
        {"subject_id": ledger["subject_id"], "fact": fact(magnitude=magnitude)},
        expected_state=ledger["state"],
    )
    assert response.status_code == 200
    recorded = response.json()["result"]["assertion"]
    assert recorded["fact"]["status"] == "known"
    assert recorded["canonical_value"]["magnitude"] == canonical


def test_internal_typed_decimal_stays_exact(users, ledger):
    recorded = append(users["editor"], ledger, fact(magnitude=Decimal("0.125")))
    assert recorded["assertion"]["canonical_value"]["magnitude"] == "0.125"
