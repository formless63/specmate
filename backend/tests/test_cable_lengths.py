import copy

import pytest
from django.test import Client

from specmate.access.models import WorkspaceMember
from specmate.cables.queries import inspect_revision
from specmate.design.models import Definition, Snapshot
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)

from .conftest import op, set_role
from .scope_helpers import workspace_of
from .test_cables import capture, create, fixture


def declaration(amount):
    return {"amount_mm": amount, "basis": "human_declaration", "explanation": "Synthetic drawing"}


def prepared(amount, source, extra, kind="slack"):
    return {
        "declaration": declaration(amount),
        "model": {
            "source": source,
            "review": "reviewed",
            "review_basis": "Reviewed synthetic allowance",
            "allowances": [
                {"kind": kind, "amount_mm": extra, "explanation": "Independent allowance"}
            ],
        },
    }


def length_plan():
    return {
        "route": declaration("1000"),
        "finished": prepared("1050", "route", "50"),
        "stock_cut": prepared("1070", "finished", "20", "preparation"),
        "conductor_cuts": [
            {"element_path": "stock.core", **prepared("1060", "stock_cut", "10", "trim")}
        ],
    }


def rows(result):
    return {row["target"]: row for row in result["lengths"]["rows"]}


def test_route_change_reports_exact_preparation_document_impacts_without_writing_stock(
    users, project
):
    user = users["owner"]
    _, _, stock, _, _, cable = fixture(user, project)
    stock_bytes = bytes(Snapshot.objects.get(id=stock["snapshot_id"]).canonical)
    cable["lengths"] = length_plan()
    draft = create(user, project, cable, idempotency_key="length-create")
    assert create(user, project, cable, idempotency_key="length-create") == draft
    before = capture(user, draft)
    prior = inspect_revision(user, before["revision_id"])
    assert [
        rows(prior)[key]["suggested_mm"]
        for key in ["finished", "stock_cut", "conductor:stock.core"]
    ] == ["1050", "1070", "1060"]
    changed = copy.deepcopy(cable)
    changed["lengths"]["route"] = declaration("1100")
    updated = op(
        user,
        "cable.update",
        {"draft_id": draft["draft_id"], "cable": changed},
        expected_state=before["draft"]["state"],
        idempotency_key="length-update",
    )
    after = capture(user, updated)
    current = inspect_revision(user, after["revision_id"])
    assert [
        rows(current)[key]["suggested_mm"]
        for key in ["finished", "stock_cut", "conductor:stock.core"]
    ] == ["1150", "1170", "1160"]
    assert rows(current)["stock_cut"]["declaration"]["amount_mm"] == "1070"
    assert rows(current)["stock_cut"]["declaration_matches_suggestion"] is False
    assert rows(current)["conductor:stock.core"]["element_kind"] == "conductor"
    assert rows(current)["conductor:stock.core"]["stock_revision_id"] == stock["revision_id"]
    assert rows(current)["conductor:stock.screen"]["declaration"]["amount_mm"] is None
    impact = op(
        users["viewer"],
        "cable.length_impact",
        {"before_revision_id": before["revision_id"], "after_revision_id": after["revision_id"]},
    )
    assert (
        impact["route_changed"]
        and impact["preparation_review_required"]
        and impact["document_review_required"]
    )
    assert {r["target"] for r in impact["changes"]} == {
        "route",
        "finished",
        "stock_cut",
        "conductor:stock.core",
    }
    assert (
        not impact["stock_revision_changed"]
        and not impact["stock_facts_written"]
        and not impact["declarations_applied"]
    )
    assert inspect_revision(user, before["revision_id"]) == prior
    assert bytes(Snapshot.objects.get(id=stock["snapshot_id"]).canonical) == stock_bytes
    with pytest.raises(Conflict):
        op(
            user,
            "cable.update",
            {"draft_id": draft["draft_id"], "cable": cable},
            expected_state=before["draft"]["state"],
        )
    with pytest.raises(IdempotencyMismatch):
        create(user, project, changed, idempotency_key="length-create")
    with pytest.raises(PermissionDenied):
        op(
            users["viewer"],
            "cable.update",
            {"draft_id": draft["draft_id"], "cable": changed},
            expected_state=after["draft"]["state"],
        )
    with pytest.raises((PermissionDenied, NotFound)):
        op(
            users["outsider"],
            "cable.length_impact",
            {
                "before_revision_id": before["revision_id"],
                "after_revision_id": after["revision_id"],
            },
        )
    client = Client()
    client.force_login(users["viewer"])
    response = client.post(
        "/api/v0/operations",
        data={
            "operation": "cable.length_impact",
            "request_id": "length-http",
            "payload": {
                "before_revision_id": before["revision_id"],
                "after_revision_id": after["revision_id"],
            },
        },
        content_type="application/json",
    )
    assert response.status_code == 200, response.content
    assert response.json()["result"] == impact


@pytest.mark.parametrize("unknown", ["route", "slack", "unreviewed"])
def test_unknown_models_never_fall_back_to_declared_lengths(users, project, unknown):
    *_, cable = fixture(users["owner"], project)
    cable["lengths"] = length_plan()
    if unknown == "route":
        cable["lengths"]["route"] = {}
    elif unknown == "slack":
        cable["lengths"]["finished"]["model"]["allowances"][0]["amount_mm"] = None
    else:
        cable["lengths"]["finished"]["model"]["review"] = "unreviewed"
    result = inspect_revision(
        users["owner"],
        capture(users["owner"], create(users["owner"], project, cable))["revision_id"],
    )
    assert all(
        rows(result)[key]["suggested_mm"] is None
        for key in ["finished", "stock_cut", "conductor:stock.core"]
    )
    assert rows(result)["stock_cut"]["declaration"]["amount_mm"] == "1070"


@pytest.mark.parametrize(
    "change",
    [
        lambda p: p["route"].update(amount_mm=1.5),
        lambda p: p["route"].update(amount_mm="0"),
        lambda p: p["route"].update(basis="unknown"),
        lambda p: p["finished"]["model"].update(source="stock_cut"),
        lambda p: p["finished"]["model"].update(review_basis=None),
        lambda p: p["finished"]["model"]["allowances"][0].update(amount_mm="-1"),
        lambda p: p["finished"]["model"]["allowances"][0].update(
            scope="endpoint", endpoint_id="missing"
        ),
        lambda p: p["finished"]["model"]["allowances"][0].update(kind="trim", amount_mm="1000"),
        lambda p: p["conductor_cuts"][0].update(element_path="stock.jacket"),
        lambda p: p["conductor_cuts"].append(p["conductor_cuts"][0]),
    ],
)
def test_invalid_length_plan_rolls_back(users, project, change):
    *_, cable = fixture(users["owner"], project)
    cable["lengths"] = length_plan()
    change(cable["lengths"])
    count = Definition.objects.count()
    with pytest.raises(ValidationFailed):
        create(users["owner"], project, cable)
    assert Definition.objects.count() == count


def test_current_cross_project_closure_denies_old_new_reads_and_changed_replay(users, project):
    user = users["owner"]
    source_project = op(user, "project.create", {"name": "Synthetic source lengths"})["project_id"]
    *_, cable = fixture(user, source_project)
    cable["lengths"] = length_plan()
    draft = create(user, project, cable, idempotency_key="source-length")
    before = capture(user, draft)
    after = capture(user, before["draft"])
    WorkspaceMember.objects.filter(workspace__projects=source_project, user=user).delete()
    for rid in [before["revision_id"], after["revision_id"]]:
        with pytest.raises((PermissionDenied, NotFound)):
            inspect_revision(user, rid)
    with pytest.raises((PermissionDenied, NotFound)):
        op(
            user,
            "cable.length_impact",
            {
                "before_revision_id": before["revision_id"],
                "after_revision_id": after["revision_id"],
            },
        )
    cable["lengths"]["route"] = declaration("1200")
    with pytest.raises((PermissionDenied, NotFound)):
        create(user, project, cable, idempotency_key="source-length")


@pytest.mark.parametrize(
    "operation_name", ["cable.create", "cable.update", "cable.freeze", "cable.snapshot"]
)
def test_hidden_retained_result_is_checked_before_changed_payload_diagnostics(
    users, project, operation_name
):
    user = users["owner"]
    private_project = op(user, "project.create", {"name": "Synthetic hidden stock"})["project_id"]
    *_, hidden_cable = fixture(user, private_project)
    *_, accessible_cable = fixture(user, project)
    original = create(user, project, hidden_cable, idempotency_key="guard-create")
    if operation_name == "cable.create":
        payload = {
            "workspace_id": workspace_of(project),
            "name": "Replacement",
            "cable": accessible_cable,
        }
        state = None
        key = "guard-create"
    else:
        operation_payload = {"draft_id": original["draft_id"]}
        if operation_name == "cable.update":
            operation_payload["cable"] = hidden_cable
        outcome = op(
            user,
            operation_name,
            operation_payload,
            expected_state=original["state"],
            idempotency_key="retained-guard",
        )
        current = original if operation_name == "cable.snapshot" else outcome.get("draft", outcome)
        # Remove the hidden source from the CURRENT draft; retained result still pins it.
        op(
            user,
            "cable.update",
            {"draft_id": original["draft_id"], "cable": accessible_cable},
            expected_state=current["state"],
        )
        other = create(user, project, accessible_cable)
        payload = {"draft_id": other["draft_id"]}
        if operation_name == "cable.update":
            payload["cable"] = accessible_cable
        state = other["state"]
        key = "retained-guard"
    WorkspaceMember.objects.filter(workspace__projects=private_project, user=user).delete()
    with pytest.raises((PermissionDenied, NotFound)):
        op(user, operation_name, payload, expected_state=state, idempotency_key=key)


def test_fractional_allowances_zero_and_endpoint_scope_remain_exact(users, project):
    user = users["owner"]
    *_, cable = fixture(user, project)
    cable["lengths"] = length_plan()
    plan = cable["lengths"]
    plan["route"] = declaration("0.100001")
    plan["finished"] = prepared("0.300001", "route", "0.2")
    plan["finished"]["model"]["allowances"][0].update(scope="endpoint", endpoint_id="left")
    plan["stock_cut"] = prepared("0.300001", "finished", "0")
    plan["conductor_cuts"] = []
    frozen = capture(user, create(user, project, cable))
    result = inspect_revision(user, frozen["revision_id"])
    assert rows(result)["stock_cut"]["suggested_mm"] == "0.300001"
    client = Client()
    client.force_login(user)
    response = client.get(
        "/api/v0/cables/length-impact",
        {"before_revision_id": frozen["revision_id"], "after_revision_id": frozen["revision_id"]},
    )
    assert response.status_code == 200
    assert response.json()["changes"] == []


@pytest.mark.parametrize("invalid", ["cut", "allowance_endpoint", "termination_endpoint"])
@pytest.mark.parametrize("operation_name", ["cable.create", "cable.update"])
def test_current_role_precedes_supplied_semantic_diagnostics(
    users, project, invalid, operation_name
):
    user = users["editor"]
    *_, hidden = fixture(user, project)
    *_, replacement = fixture(user, project)
    original = create(user, project, hidden, idempotency_key="semantic-guard")
    if operation_name == "cable.update":
        stored = op(
            user,
            operation_name,
            {"draft_id": original["draft_id"], "cable": hidden},
            expected_state=original["state"],
            idempotency_key="semantic-guard",
        )
        op(
            user,
            operation_name,
            {"draft_id": original["draft_id"], "cable": replacement},
            expected_state=stored["state"],
        )
    replacement["lengths"] = length_plan()
    if invalid == "cut":
        replacement["lengths"]["conductor_cuts"][0]["element_path"] = "stock.jacket"
    elif invalid == "allowance_endpoint":
        replacement["lengths"]["finished"]["model"]["allowances"][0].update(
            scope="endpoint", endpoint_id="missing"
        )
    else:
        replacement["assignments"][0]["endpoint_id"] = "missing"
    fresh = create(user, project, fixture(user, project)[-1])
    payload = (
        {"workspace_id": workspace_of(project), "name": "Replacement", "cable": replacement}
        if operation_name == "cable.create"
        else {"draft_id": fresh["draft_id"], "cable": replacement}
    )
    # A role downgrade is the remaining in-workspace revocation: current authority for the
    # retained key precedes every supplied semantic diagnostic.
    set_role(user, "viewer")
    with pytest.raises(PermissionDenied):
        op(
            user,
            operation_name,
            payload,
            expected_state=fresh["state"],
            idempotency_key="semantic-guard",
        )
    with pytest.raises(PermissionDenied):
        op(user, operation_name, payload, expected_state=fresh["state"])
    with pytest.raises(ValidationFailed):
        op(users["owner"], operation_name, payload, expected_state=fresh["state"])


def test_stock_pin_change_does_not_report_route_declaration_change(users, project):
    user = users["owner"]
    _, _, stock, _, _, cable = fixture(user, project)
    cable["lengths"] = length_plan()
    original = capture(user, create(user, project, cable))
    later_stock = capture(user, stock["draft"], "wire_stock.freeze")
    cable["stock_revision_id"] = later_stock["revision_id"]
    updated = op(
        user,
        "cable.update",
        {"draft_id": original["draft"]["draft_id"], "cable": cable},
        expected_state=original["draft"]["state"],
    )
    later = capture(user, updated)
    result = op(
        user,
        "cable.length_impact",
        {"before_revision_id": original["revision_id"], "after_revision_id": later["revision_id"]},
    )
    assert result["stock_revision_changed"] is True
    assert result["route_changed"] is False
    assert result["preparation_review_required"] is True
    assert result["document_review_required"] is True


def impact_after(user, project, cable, change):
    original = capture(user, create(user, project, cable))
    changed = copy.deepcopy(cable)
    change(changed)
    updated = op(
        user,
        "cable.update",
        {"draft_id": original["draft"]["draft_id"], "cable": changed},
        expected_state=original["draft"]["state"],
    )
    later = capture(user, updated)
    return op(
        user,
        "cable.length_impact",
        {"before_revision_id": original["revision_id"], "after_revision_id": later["revision_id"]},
    )


def test_termination_change_requires_document_and_preparation_review(users, project):
    user = users["owner"]
    *_, cable = fixture(user, project)
    cable["lengths"] = length_plan()

    def move_right_end(changed):
        changed["assignments"][1]["contact_id"] = "a"
        changed["assignments"][1]["basis"] = "Synthetic change: right end moved to contact a"

    result = impact_after(user, project, cable, move_right_end)
    # Lengths are unchanged, but the terminated contact is not.
    assert result["changes"] == [] and result["route_changed"] is False
    assert result["document_review_required"] is True
    assert result["preparation_review_required"] is True
    [section] = result["sections"]
    assert section["section"] == "terminations" and section["status"] == "changed"
    assert section["details"] == [
        {
            "element_path": "stock.core",
            "endpoint_id": "right",
            "before_target": "connector / b",
            "after_target": "connector / a",
            "before_contact_id": "b",
            "after_contact_id": "a",
            "before_basis": "Synthetic terminal table",
            "after_basis": "Synthetic change: right end moved to contact a",
        }
    ]


def test_removed_termination_and_label_changes_are_listed_by_section(users, project):
    user = users["owner"]
    *_, cable = fixture(user, project)

    def change(changed):
        changed["assignments"] = changed["assignments"][:1]
        changed["endpoints"][0]["label"] = "P1"
        changed["review"] = "unreviewed"
        changed["review_basis"] = None

    result = impact_after(user, project, cable, change)
    by_section = {s["section"]: s for s in result["sections"]}
    assert set(by_section) == {"terminations", "labels", "review"}
    assert by_section["terminations"]["details"][0]["after_contact_id"] is None
    assert by_section["labels"]["reviews"] == ["documents"]
    assert by_section["labels"]["details"] == [
        {"endpoint_id": "left", "before": None, "after": "P1"}
    ]
    assert result["document_review_required"] is True


def test_label_only_change_requires_documents_but_not_preparation(users, project):
    user = users["owner"]
    *_, cable = fixture(user, project)

    def relabel(changed):
        changed["endpoints"][1]["label"] = "J2"

    result = impact_after(user, project, cable, relabel)
    assert [s["section"] for s in result["sections"]] == ["labels"]
    assert result["document_review_required"] is True
    assert result["preparation_review_required"] is False


def test_same_revision_reports_no_review_and_no_sections(users, project):
    user = users["owner"]
    *_, cable = fixture(user, project)
    cable["lengths"] = length_plan()
    first = capture(user, create(user, project, cable))
    result = op(
        user,
        "cable.length_impact",
        {"before_revision_id": first["revision_id"], "after_revision_id": first["revision_id"]},
    )
    assert result["sections"] == []
    assert result["document_review_required"] is False
    assert result["preparation_review_required"] is False
