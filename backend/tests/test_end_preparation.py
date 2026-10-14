import copy
from types import SimpleNamespace
from uuid import UUID

import pytest
from django.contrib.auth import get_user_model
from django.test import Client

from specmate.design.models import Definition, Snapshot
from specmate.end_preparation import api
from specmate.end_preparation.contracts import ApplyProfile, EndPreparationProfile
from specmate.end_preparation.queries import inspect_profile
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    Unauthenticated,
    ValidationFailed,
)

from .conftest import ensure_member, op, remove_member
from .scope_helpers import workspace_of
from .test_cables import STOCK, capture, fixture
from .test_cables import create as create_cable
from .test_preparation import evidence


def dimension(value, minus="0", plus="0", datum="from_stock_cut_end"):
    return {
        "nominal_mm": value,
        "minus_mm": minus,
        "plus_mm": plus,
        "datum": datum,
        "basis": "Synthetic exact preparation dimension",
    }


def profile(stock_id, body_id=None):
    value = {
        "stock_revision_id": stock_id,
        "a": {
            "review": "reviewed",
            "review_basis": "Synthetic end A review",
            "instructions": [
                {
                    "local_id": "jacket-strip",
                    "kind": "layer_strip",
                    "element_path": "stock.jacket",
                    "treatment": "strip_back",
                    "length": dimension("12.500001", "0.2", "0.3"),
                    "basis": "Synthetic A jacket intent",
                },
                {
                    "local_id": "shield-lead",
                    "kind": "shield_lead",
                    "element_path": "stock.screen",
                    "treatment": "form_lead",
                    "length": dimension("8", "0.1", "0.1", "along_finished_lead"),
                    "basis": "Synthetic A shield intent",
                },
                {
                    "local_id": "drain-trim",
                    "kind": "drain_treatment",
                    "element_path": "stock.drain",
                    "treatment": "trim",
                    "length": dimension("0"),
                    "basis": "Explicit flush trim",
                },
                {
                    "local_id": "shield-bond",
                    "kind": "bond_expectation",
                    "element_path": "stock.screen",
                    "treatment": "bond",
                    "target": {"kind": "stock_feature", "element_path": "stock.drain"},
                    "basis": "Expected shield-to-drain only; no actual bond",
                },
            ],
        },
        "b": {
            "review": "reviewed",
            "review_basis": "Synthetic end B review",
            "instructions": [
                {
                    "local_id": "jacket-strip",
                    "kind": "layer_strip",
                    "element_path": "stock.jacket",
                    "treatment": "strip_back",
                    "length": dimension("4", None, None),
                    "basis": "Synthetic B jacket, tolerance unresolved",
                },
                {
                    "local_id": "drain-treatment",
                    "kind": "drain_treatment",
                    "element_path": "stock.drain",
                    "treatment": "unknown",
                },
                {
                    "local_id": "shield-isolation",
                    "kind": "bond_expectation",
                    "element_path": "stock.screen",
                    "treatment": "isolate",
                    "basis": "Expected isolation only",
                },
            ],
        },
    }
    if body_id:
        value["a"]["instructions"].append(
            {
                "local_id": "drain-contact",
                "kind": "bond_expectation",
                "element_path": "stock.drain",
                "treatment": "bond",
                "target": {
                    "kind": "endpoint_contact",
                    "body_revision_id": body_id,
                    "contact_id": "a",
                },
                "basis": "Exact synthetic contact expectation",
            }
        )
    return value


def create(user, project, value, **ctx):
    return op(
        user,
        "end_preparation.create",
        {
            "workspace_id": workspace_of(project),
            "name": "Synthetic end preparation",
            "profile": value,
        },
        **ctx,
    )


def freeze(user, draft, **ctx):
    return op(
        user,
        "end_preparation.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
        **ctx,
    )


def application(target, recipe, **changes):
    return {
        "cable_revision_id": target["revision_id"],
        "profile_revision_id": recipe["revision_id"],
        "a_endpoint_id": "left",
        "b_endpoint_id": "right",
        "mapping_basis": "Reviewed synthetic physical end mapping",
        "mapping_review": "reviewed",
        **changes,
    }


def setup(user, project, value=None):
    _, _, stock, body, _, cable = fixture(user, project)
    # Identical labels deliberately carry no end identity or handedness.
    for endpoint in cable["endpoints"]:
        endpoint["label"] = "repeated-end-label"
    target = capture(user, create_cable(user, project, cable))
    rules = value or profile(stock["revision_id"], body["revision_id"])
    draft = create(user, project, rules)
    return stock, body, target, draft, freeze(user, draft)


def test_reviewed_distinct_ends_exact_tolerances_provenance_history_and_no_writeback(
    users, project
):
    user = users["owner"]
    stock, body, target, draft, recipe = setup(user, project)
    before_stock = bytes(Snapshot.objects.get(id=stock["snapshot_id"]).canonical)
    before_cable = bytes(Snapshot.objects.get(id=target["snapshot_id"]).canonical)
    snapshot = Snapshot.objects.get(id=recipe["snapshot_id"])
    before_profile = bytes(snapshot.canonical)
    assert set(snapshot.dependencies.values_list("revision_id", flat=True)) == {
        UUID(stock["revision_id"]),
        UUID(body["revision_id"]),
    }
    result = op(users["viewer"], "end_preparation.apply", application(target, recipe))
    a, b = result["ends"]
    assert a["endpoint"]["local_id"] == "left" and b["endpoint"]["local_id"] == "right"
    assert a["instructions"][0]["instruction"]["length"] == dimension("12.500001", "0.2", "0.3")
    assert a["instructions"][0]["status"] == "reviewed_intent"
    assert a["instructions"][2]["instruction"]["length"]["nominal_mm"] == "0"
    assert b["instructions"][0]["instruction"]["length"]["nominal_mm"] == "4"
    assert b["instructions"][0]["unresolved"] == ["minus_mm", "plus_mm"]
    assert b["instructions"][1]["instruction"]["treatment"] == "unknown"
    assert b["instructions"][1]["instruction"]["length"]["nominal_mm"] is None
    assert {"element_path": "stock.screen", "kind": "shield_lead", "status": "unknown"} in b[
        "missing_instructions"
    ]
    assert a["instructions"][-1]["instruction"]["target"]["body_revision_id"] == body["revision_id"]
    assert a["endpoint"]["body"]["drawing_orientation"]["viewing_side"] == "unknown"
    assert result["actual_bonds"] == "not_evaluated"
    assert not result["topology_written"] and not result["stock_facts_written"]
    changed = profile(stock["revision_id"], body["revision_id"])
    changed["a"]["instructions"][0]["length"]["nominal_mm"] = "20"
    updated = op(
        user,
        "end_preparation.update",
        {"draft_id": draft["draft_id"], "profile": changed},
        expected_state=recipe["draft"]["state"],
    )
    assert updated["definition_id"] == draft["definition_id"]
    later = freeze(user, updated)
    assert op(user, "end_preparation.apply", application(target, recipe)) == result
    assert (
        op(user, "end_preparation.apply", application(target, later))["ends"][0]["instructions"][0][
            "instruction"
        ]["length"]["nominal_mm"]
        == "20"
    )
    assert bytes(Snapshot.objects.get(id=stock["snapshot_id"]).canonical) == before_stock
    assert bytes(Snapshot.objects.get(id=target["snapshot_id"]).canonical) == before_cable
    assert bytes(Snapshot.objects.get(id=recipe["snapshot_id"]).canonical) == before_profile
    client = Client()
    client.force_login(users["viewer"])
    response = client.post(
        "/api/v0/end-preparation/apply",
        application(target, recipe),
        content_type="application/json",
    )
    assert response.status_code == 200, response.content
    assert response.json() == result
    assert (
        client.get(f"/api/v0/end-preparation/revisions/{recipe['revision_id']}").status_code == 200
    )


def test_missing_facts_never_come_from_workshop_display_defaults(users, project):
    user = users["owner"]
    stock, _, target, _, recipe = setup(user, project)
    workshop = op(
        user,
        "workshop_profile.create",
        {
            "project_id": project,
            "name": "Synthetic display defaults",
            "profile": {
                "stock_revision_id": stock["revision_id"],
                "element_rules": {
                    "stock.screen": {
                        "b": {
                            "cutback_mm": {
                                "value": 99.0,
                                "basis": "preference",
                                "note": "Display only",
                            }
                        }
                    }
                },
            },
        },
    )
    op(
        user,
        "workshop_profile.freeze",
        {"draft_id": workshop["draft_id"]},
        expected_state=workshop["state"],
    )
    result = op(user, "end_preparation.apply", application(target, recipe))
    assert not result["workshop_defaults_applied"]
    assert "99" not in str(result["ends"][1]["instructions"])
    assert any(row["kind"] == "shield_lead" for row in result["ends"][1]["missing_instructions"])


def test_unreviewed_mapping_and_end_do_not_become_reviewed_instructions(users, project):
    user = users["owner"]
    stock, _, target, _, recipe = setup(user, project)
    result = op(
        user, "end_preparation.apply", application(target, recipe, mapping_review="unreviewed")
    )
    assert all(
        row["status"] == "unreviewed_intent"
        for end in result["ends"]
        for row in end["instructions"]
    )
    rules = profile(stock["revision_id"])
    rules["a"]["review"] = "unreviewed"
    recipe = freeze(user, create(user, project, rules))
    assert (
        op(user, "end_preparation.apply", application(target, recipe))["ends"][0]["instructions"][
            0
        ]["status"]
        == "unreviewed_intent"
    )


@pytest.mark.parametrize(
    "mapping", [{"a_endpoint_id": "repeated-end-label"}, {"a_endpoint_id": "right"}]
)
def test_endpoint_labels_and_aliasing_are_not_end_identity(users, project, mapping):
    _, _, target, _, recipe = setup(users["owner"], project)
    with pytest.raises(ValidationFailed, match="distinct exact"):
        op(users["owner"], "end_preparation.apply", application(target, recipe, **mapping))
    reversed_result = op(
        users["owner"],
        "end_preparation.apply",
        application(target, recipe, a_endpoint_id="right", b_endpoint_id="left"),
    )
    assert reversed_result["ends"][0]["endpoint"]["local_id"] == "right"
    assert (
        reversed_result["ends"][0]["instructions"][0]["instruction"]["length"]["nominal_mm"]
        == "12.500001"
    )


@pytest.mark.parametrize(
    "invalid",
    [
        "float",
        "negative",
        "tolerance",
        "datum",
        "feature",
        "contact",
        "kind",
        "duplicate",
        "review",
    ],
)
def test_invalid_instruction_profiles_rollback(users, project, invalid):
    user = users["owner"]
    _, _, stock, body, _, _ = fixture(user, project)
    rules = profile(stock["revision_id"], body["revision_id"])
    row = rules["a"]["instructions"][0]
    if invalid == "float":
        row["length"]["nominal_mm"] = 12.5
    elif invalid == "negative":
        row["length"]["plus_mm"] = "-1"
    elif invalid == "tolerance":
        row["length"]["minus_mm"] = "20"
    elif invalid == "datum":
        row["length"]["datum"] = "unknown"
    elif invalid == "feature":
        row["element_path"] = "jacket"
    elif invalid == "contact":
        rules["a"]["instructions"][-1]["target"]["contact_id"] = "key"
    elif invalid == "kind":
        row["element_path"] = "stock.core"
    elif invalid == "duplicate":
        rules["a"]["instructions"].append(copy.deepcopy(row))
    else:
        rules["a"]["review_basis"] = None
    before = Definition.objects.count()
    with pytest.raises(ValidationFailed):
        create(user, project, rules)
    assert Definition.objects.count() == before


def test_shared_generic_paths_pins_cas_idempotency_and_role_denial(users, project):
    user = users["owner"]
    _, _, stock, _, _, _ = fixture(user, project)
    rules = profile(stock["revision_id"])
    payload = {
        "project_id": project,
        "kind": "end_preparation_profile",
        "name": "Synthetic generic profile",
        "content": {"end_preparation_profile": rules},
    }
    generic = op(user, "definition.create", payload)
    recipe = op(
        user, "draft.freeze", {"draft_id": generic["draft_id"]}, expected_state=generic["state"]
    )
    assert (
        Snapshot.objects.get(id=recipe["snapshot_id"])
        .dependencies.filter(revision_id=stock["revision_id"])
        .exists()
    )
    with pytest.raises(ValidationFailed):
        op(user, "definition.create", {**payload, "content": {}})
    with pytest.raises(ValidationFailed):
        op(user, "definition.create", {**payload, "kind": "assembly"})
    with pytest.raises(ValidationFailed):
        op(
            user,
            "draft.update",
            {
                "draft_id": generic["draft_id"],
                "changes": {
                    "end_preparation_profile": {
                        **rules,
                        "a": {
                            "instructions": [
                                {
                                    "kind": "layer_strip",
                                    "local_id": "bad",
                                    "element_path": "unknown",
                                }
                            ]
                        },
                    }
                },
            },
            expected_state=recipe["draft"]["state"],
        )
    draft = create(user, project, rules, idempotency_key="exact-end-create")
    assert create(user, project, rules, idempotency_key="exact-end-create") == draft
    with pytest.raises(IdempotencyMismatch):
        create(user, project, {**rules, "b": {}}, idempotency_key="exact-end-create")
    frozen = freeze(user, draft, idempotency_key="exact-end-freeze")
    assert freeze(user, draft, idempotency_key="exact-end-freeze") == frozen
    with pytest.raises(Conflict):
        op(
            user,
            "end_preparation.update",
            {"draft_id": draft["draft_id"], "profile": rules},
            expected_state=draft["state"],
        )
    with pytest.raises(PermissionDenied):
        create(users["viewer"], project, rules)
    with pytest.raises(NotFound):
        inspect_profile(users["outsider"], frozen["revision_id"])


def test_retained_old_source_authority_precedes_invalid_supplied_feature_and_key_mismatch(
    users, project
):
    user = users["editor"]
    _, _, stock, _, _, cable = fixture(users["owner"], project)
    target = capture(users["owner"], create_cable(users["owner"], project, cable))
    origin = op(users["owner"], "project.create", {"name": "Synthetic origin context"})[
        "project_id"
    ]
    parent, _ = evidence(users["owner"], origin)
    _, source = evidence(users["owner"], project, parent)
    rules = profile(stock["revision_id"])
    rules["a"]["instructions"][0]["source"] = source
    draft = create(user, project, rules, idempotency_key="retained-source")
    frozen = freeze(user, draft)
    changed = profile(stock["revision_id"])
    op(
        user,
        "end_preparation.update",
        {"draft_id": draft["draft_id"], "profile": changed},
        expected_state=frozen["draft"]["state"],
    )
    # Membership loss is the remaining revocation; it precedes every supplied diagnostic.
    remove_member(user)
    changed["a"]["instructions"][0]["element_path"] = "invalid.feature"
    with pytest.raises(NotFound, match=r"^Not found\.$"):
        create(user, project, changed, idempotency_key="retained-source")
    with pytest.raises(NotFound, match=r"^Not found\.$"):
        op(user, "end_preparation.apply", application(target, frozen, a_endpoint_id="invalid-end"))
    with pytest.raises(NotFound, match=r"^Not found\.$"):
        inspect_profile(user, frozen["revision_id"])


def test_all_incoming_sources_and_ancestors_authorized_before_file_diagnostics(users, project):
    owner, user = users["owner"], users["editor"]
    _, _, stock, _, _, _ = fixture(owner, project)
    origin = op(owner, "project.create", {"name": "Synthetic original context"})["project_id"]
    parent, _ = evidence(owner, origin)
    other_project = op(owner, "project.create", {"name": "Synthetic accessible evidence"})[
        "project_id"
    ]
    _, accessible = evidence(owner, other_project)
    _, derived = evidence(owner, project, parent)
    rules = profile(stock["revision_id"])
    rules["a"]["instructions"][0]["source"] = {**accessible, "path": "missing.txt"}
    rules["b"]["instructions"][0]["source"] = derived
    remove_member(user)
    with pytest.raises(NotFound, match=r"^Not found\.$"):
        create(user, project, rules)
    # A member reaches the file diagnostic only after the whole source closure resolves.
    with pytest.raises(NotFound, match="evidence file unavailable"):
        create(owner, project, rules)


@pytest.mark.parametrize("boundary", ["revision", "draft", "apply", "authority", "query"])
def test_current_actor_rechecked_even_with_source_free_profile(users, project, boundary):
    user = users["owner"]
    stock, _, target, draft, frozen = setup(user, project)
    request = SimpleNamespace(user=user)
    payload = EndPreparationProfile.model_validate(profile(stock["revision_id"]))
    calls = {
        "revision": lambda: api.revision(request, frozen["revision_id"]),
        "draft": lambda: api.draft(request, draft["draft_id"]),
        "apply": lambda: api.calculate(
            request, ApplyProfile.model_validate(application(target, frozen))
        ),
        "authority": lambda: api.authority(request, payload),
        "query": lambda: inspect_profile(user, frozen["revision_id"]),
    }
    assert calls[boundary]() is not None
    get_user_model().objects.filter(pk=user.pk).update(is_active=False)
    assert user.is_active
    with pytest.raises(Unauthenticated):
        calls[boundary]()


def test_exact_stock_and_endpoint_body_pins_cannot_be_substituted(users, project):
    user = users["owner"]
    stock, _, target, _, _ = setup(user, project)
    _, _, other_stock, other_body, _, _ = fixture(user, project)
    wrong_stock = freeze(user, create(user, project, profile(other_stock["revision_id"])))
    with pytest.raises(ValidationFailed, match="exact stock"):
        op(user, "end_preparation.apply", application(target, wrong_stock))
    wrong_body = freeze(
        user, create(user, project, profile(stock["revision_id"], other_body["revision_id"]))
    )
    with pytest.raises(ValidationFailed, match="body pin"):
        op(user, "end_preparation.apply", application(target, wrong_body))


def test_exact_hierarchical_feature_paths_do_not_alias_repeated_labels(users, project):
    user = users["owner"]
    _, _, _, _, _, cable = fixture(user, project)
    stock = copy.deepcopy(STOCK)
    stock["structure"]["children"].extend(
        {
            "id": side,
            "kind": "group",
            "label": "Repeated group",
            "role": "bundle",
            "children": [{"id": "screen", "label": "Repeated screen", "kind": "shield"}],
        }
        for side in ("first", "second")
    )
    stock_draft = op(
        user,
        "wire_stock.create",
        {"project_id": project, "name": "Synthetic nested stock", "stock": stock},
    )
    stock_revision = capture(user, stock_draft, "wire_stock.freeze")
    cable["stock_revision_id"] = stock_revision["revision_id"]
    target = capture(user, create_cable(user, project, cable))
    rules = profile(stock_revision["revision_id"])
    rules["a"]["instructions"][1]["element_path"] = "stock.first.screen"
    rules["b"]["instructions"].append(
        {
            **copy.deepcopy(rules["a"]["instructions"][1]),
            "element_path": "stock.second.screen",
            "length": dimension("3", datum="along_finished_lead"),
        }
    )
    frozen = freeze(user, create(user, project, rules))
    result = op(user, "end_preparation.apply", application(target, frozen))
    assert (
        result["ends"][0]["instructions"][1]["instruction"]["element_path"] == "stock.first.screen"
    )
    assert result["ends"][1]["instructions"][-1]["instruction"]["length"]["nominal_mm"] == "3"
    assert {
        "element_path": "stock.first.screen",
        "kind": "shield_lead",
        "status": "unknown",
    } in result["ends"][1]["missing_instructions"]


def test_inaccessible_cable_ancestor_precedes_invalid_mapping(users, project):
    owner, user = users["owner"], users["editor"]
    _, _, stock, _, _, cable = fixture(owner, project)
    target = capture(owner, create_cable(owner, project, cable))
    frozen = freeze(owner, create(owner, project, profile(stock["revision_id"])))
    remove_member(user)
    with pytest.raises(NotFound, match=r"^Not found\.$"):
        op(user, "end_preparation.apply", application(target, frozen, a_endpoint_id="bad"))


def test_known_endpoint_orientations_are_preserved_without_mirroring_or_label_inference(
    users, project
):
    from .test_interfaces import (
        BODY,
        pinout,
    )
    from .test_interfaces import (
        create as create_interface,
    )
    from .test_interfaces import (
        freeze as freeze_interface,
    )

    user = users["owner"]
    _, _, stock, _, _, cable = fixture(user, project)
    body = freeze_interface(
        user,
        create_interface(
            user,
            project,
            {
                **BODY,
                "drawing_orientation": {
                    "viewing_side": "termination",
                    "rotation_degrees": 180,
                    "datum": "Synthetic key datum",
                },
            },
        ),
    )
    pins = freeze_interface(user, create_interface(user, project, pinout(body)))
    cable["endpoints"][0].update(
        body_revision_id=body["revision_id"], pinout_revision_id=pins["revision_id"]
    )
    target = capture(user, create_cable(user, project, cable))
    recipe = freeze(user, create(user, project, profile(stock["revision_id"], body["revision_id"])))
    result = op(user, "end_preparation.apply", application(target, recipe))
    assert result["ends"][0]["endpoint"]["body"]["drawing_orientation"] == {
        "viewing_side": "termination",
        "rotation_degrees": 180,
        "datum": "Synthetic key datum",
    }
    assert result["ends"][1]["endpoint"]["body"]["drawing_orientation"]["viewing_side"] == "unknown"
    with pytest.raises(ValidationFailed, match="body pin"):
        op(
            user,
            "end_preparation.apply",
            application(target, recipe, a_endpoint_id="right", b_endpoint_id="left"),
        )


def test_body_target_authority_precedes_feature_diagnostics(users, project, other_workspace):
    from .test_interfaces import create as create_interface
    from .test_interfaces import freeze as freeze_interface

    user = users["owner"]
    _, _, stock, _, _, _ = fixture(user, project)
    # A body from a foreign workspace reads as missing even to a member of both.
    ensure_member(user, "viewer", workspace=other_workspace)
    remote = op(users["outsider"], "project.create", {"name": "Synthetic foreign body"})[
        "project_id"
    ]
    foreign = freeze_interface(users["outsider"], create_interface(users["outsider"], remote))
    rules = profile(stock["revision_id"], foreign["revision_id"])
    rules["a"]["instructions"][0]["element_path"] = "unavailable.feature"
    with pytest.raises(NotFound, match=r"^Not found\.$"):
        create(user, project, rules)
    body = freeze_interface(user, create_interface(user, project))
    recipe = freeze(user, create(user, project, profile(stock["revision_id"], body["revision_id"])))
    remove_member(users["viewer"])
    with pytest.raises(NotFound, match=r"^Not found\.$"):
        inspect_profile(users["viewer"], recipe["revision_id"])


@pytest.mark.parametrize(
    "change",
    [{"sha256": "f" * 64}, {"rights": "Different declared rights"}, {"path": "absent.txt"}],
)
def test_registered_evidence_metadata_is_not_trusted_without_matching_file(users, project, change):
    user = users["owner"]
    _, _, stock, _, _, _ = fixture(user, project)
    _, source = evidence(user, project)
    rules = profile(stock["revision_id"])
    rules["a"]["instructions"][0]["source"] = {**source, **change}
    before = Definition.objects.count()
    with pytest.raises((ValidationFailed, NotFound)):
        create(user, project, rules)
    assert Definition.objects.count() == before


def test_unknown_bond_target_remains_unresolved_and_readonly(users, project):
    user = users["owner"]
    stock, _, target, _, _ = setup(user, project)
    rules = profile(stock["revision_id"])
    rules["a"]["instructions"][3]["target"] = None
    recipe = freeze(user, create(user, project, rules))
    row = op(user, "end_preparation.apply", application(target, recipe))["ends"][0]["instructions"][
        3
    ]
    assert row["unresolved"] == ["bond_target"]
    assert row["status"] == "incomplete_intent"
    assert row["bond_created"] is False


@pytest.mark.parametrize("index,treatment", [(0, "remove"), (2, "insulate")])
def test_end_removal_or_insulation_without_extent_is_incomplete(users, project, index, treatment):
    user = users["owner"]
    stock, _, target, _, _ = setup(user, project)
    rules = profile(stock["revision_id"])
    instruction = rules["a"]["instructions"][index]
    instruction.update(treatment=treatment, length={})
    recipe = freeze(user, create(user, project, rules))
    row = op(user, "end_preparation.apply", application(target, recipe))["ends"][0]["instructions"][
        index
    ]
    assert row["status"] == "incomplete_intent"
    assert row["unresolved"] == ["nominal_mm", "minus_mm", "plus_mm"]
