import copy
import hashlib
from uuid import UUID

import pytest
from django.test import Client

from specmate.access.models import WorkspaceMember
from specmate.design.models import Definition, Snapshot
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)
from specmate.preparation.queries import inspect_profile
from specmate.sources.models import SourceBlob, SourceBundle, SourceBundleFile, SourceBundleRevision

from .conftest import op
from .scope_helpers import workspace_of
from .test_cable_lengths import declaration, length_plan
from .test_cables import capture as capture_cable
from .test_cables import create as create_cable
from .test_cables import fixture as cable_fixture
from .test_harnesses import capture as capture_harness
from .test_harnesses import create as create_harness
from .test_harnesses import fixture as harness_fixture


def profile(stock_id, input_length="route"):
    formula = {
        "local_id": "stock-cut",
        "label": "Reviewed physical piece",
        "target": "stock_piece",
        "input_length": input_length,
        "input_basis": "declaration",
        "review": "reviewed",
        "review_basis": "Synthetic additive preparation model",
        "allowances": [
            {
                "local_id": name,
                "kind": kind,
                "scope": scope,
                "amount_mm": amount,
                "basis": f"Explicit synthetic {name}",
            }
            for name, kind, scope, amount in (
                ("end-a", "preparation", "end_a", "20"),
                ("end-b", "preparation", "end_b", "10"),
                ("slack", "slack", "whole_piece", "5"),
            )
        ],
    }
    return {
        "stock_revision_id": stock_id,
        "formulas": [
            formula,
            {
                **copy.deepcopy(formula),
                "local_id": "core-cut",
                "label": "Core cut",
                "target": "conductive_feature",
                "element_path": "stock.core",
            },
        ],
    }


def create(user, project, value, **ctx):
    return op(
        user,
        "preparation.create",
        {"workspace_id": workspace_of(project), "name": "Synthetic cut profile", "profile": value},
        **ctx,
    )


def freeze(user, draft, **ctx):
    return op(
        user,
        "preparation.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
        **ctx,
    )


def cable(user, project):
    *_, value = cable_fixture(user, project)
    value["lengths"] = length_plan()
    value["lengths"]["route"] = declaration("1000")
    return value, capture_cable(user, create_cable(user, project, value))


def compute(user, target, recipe, **extra):
    return op(
        user,
        "preparation.compute",
        {
            "revision_id": target["revision_id"],
            "applications": [{"profile_revision_id": recipe["revision_id"]}],
            **extra,
        },
    )


def evidence(user, project, parent=None):
    digest = hashlib.sha256(f"Synthetic preparation evidence {project}".encode()).hexdigest()
    blob = SourceBlob.objects.create(
        workspace_id=workspace_of(project),
        sha256=digest,
        size=12,
        media_type="text/plain",
        registered_by=user,
    )
    bundle = SourceBundle.objects.create(
        workspace_id=workspace_of(project),
        name="Synthetic allowance evidence",
        role="derivative" if parent else "original",
        derived_from=parent,
        created_by=user,
    )
    revision = SourceBundleRevision.objects.create(
        bundle=bundle,
        number=1,
        manifest=b"{}",
        manifest_sha256=hashlib.sha256(b"{}").hexdigest(),
        created_by=user,
    )
    SourceBundleFile.objects.create(
        revision=revision,
        path="allowances.txt",
        blob=blob,
        media_type="text/plain",
        rights="CC0-1.0",
    )
    return revision, {
        "kind": "source_file",
        "bundle_revision_id": str(revision.id),
        "path": "allowances.txt",
        "sha256": digest,
        "rights": "CC0-1.0",
    }


def test_exact_profile_arithmetic_history_pins_and_http(users, project):
    user = users["owner"]
    value, target = cable(user, project)
    original = profile(value["stock_revision_id"])
    draft = create(user, project, original, idempotency_key="prep-create")
    assert create(user, project, original, idempotency_key="prep-create") == draft
    recipe = freeze(user, draft, idempotency_key="prep-freeze")
    snapshot = Snapshot.objects.get(id=recipe["snapshot_id"])
    original_bytes = bytes(snapshot.canonical)
    assert list(snapshot.dependencies.values_list("revision_id", flat=True)) == [
        UUID(value["stock_revision_id"])
    ]
    result = compute(users["viewer"], target, recipe, quantity=3)
    assert [row["cut_mm"] for row in result["rows"]] == ["1035", "1035"]
    assert [row["total_mm"] for row in result["rows"]] == ["3105", "3105"]
    assert result["physical_piece_count"] == 3
    assert result["rows"][0]["declared_cut_mm"] == "1070"
    assert result["rows"][0]["declaration_matches_result"] is False
    assert result["rows"][1]["element_kind"] == "conductor"
    assert result["rows"][1]["stock_revision_id"] == value["stock_revision_id"]
    assert result["rows"][1]["profile_sha256"] == snapshot.sha256
    assert result["stock_facts_written"] is False
    changed = copy.deepcopy(original)
    changed["formulas"][0]["allowances"][0]["amount_mm"] = "21"
    updated = op(
        user,
        "preparation.update",
        {"draft_id": draft["draft_id"], "profile": changed},
        expected_state=recipe["draft"]["state"],
    )
    assert updated["definition_id"] == draft["definition_id"]
    later = freeze(user, updated)
    assert compute(user, target, recipe, quantity=3) == result
    assert compute(user, target, later)["rows"][0]["cut_mm"] == "1036"
    assert bytes(Snapshot.objects.get(id=snapshot.id).canonical) == original_bytes
    with pytest.raises(Conflict):
        op(
            user,
            "preparation.update",
            {"draft_id": draft["draft_id"], "profile": original},
            expected_state=recipe["draft"]["state"],
        )
    with pytest.raises(IdempotencyMismatch):
        create(user, project, changed, idempotency_key="prep-create")
    client = Client()
    client.force_login(users["viewer"])
    response = client.post(
        "/api/v0/preparation/compute",
        {
            "revision_id": target["revision_id"],
            "applications": [{"profile_revision_id": recipe["revision_id"]}],
            "quantity": 3,
        },
        content_type="application/json",
    )
    assert response.status_code == 200, response.content
    assert response.json() == result
    assert client.get(f"/api/v0/preparation/revisions/{recipe['revision_id']}").status_code == 200


@pytest.mark.parametrize("missing", ["allowance", "route", "review", "model"])
def test_unknowns_never_become_zero_or_fallback_to_other_length(users, project, missing):
    user = users["owner"]
    value, target = cable(user, project)
    rules = profile(value["stock_revision_id"])
    if missing == "allowance":
        rules["formulas"][0]["allowances"][0]["amount_mm"] = None
    elif missing == "review":
        rules["formulas"][0]["review"] = "unreviewed"
    elif missing == "model":
        rules["formulas"][0]["input_basis"] = "model_suggestion"
    else:
        value["lengths"]["route"] = {}
        target = capture_cable(user, create_cable(user, project, value))
    recipe = freeze(user, create(user, project, rules))
    row = compute(user, target, recipe)["rows"][0]
    assert row["cut_mm"] is None and row["total_mm"] is None
    assert row["declared_cut_mm"] == "1070"


def test_harness_shared_section_profiles_do_not_count_visible_segments_as_stock(users, project):
    user = users["owner"]
    stock, _, _, harness = harness_fixture(user, project)
    harness["sections"][0]["planned_cut_length_mm"] = "1000"
    target = capture_harness(user, create_harness(user, project, harness))
    recipe = freeze(user, create(user, project, profile(stock["revision_id"], "stock_cut")))
    result = op(
        user,
        "preparation.compute",
        {
            "revision_id": target["revision_id"],
            "applications": [
                {"section_id": "shared", "profile_revision_id": recipe["revision_id"]}
            ],
            "quantity": 2,
        },
    )
    assert result["physical_piece_count"] == 2
    assert result["unprofiled_sections"] == ["branch"]
    assert [row["cut_mm"] for row in result["rows"]] == ["1035", "1035"]
    assert result["rows"][0]["segment_ids"] == ["trunk", "leg-one"]
    assert result["rows"][1]["element_path"] == "stock.core"
    assert result["rows"][0]["total_mm"] == "2070"
    with pytest.raises(ValidationFailed):
        compute(user, target, recipe)


def test_generic_commands_validate_capture_and_authorize_the_same_profile(users, project):
    user = users["owner"]
    value, _ = cable(user, project)
    content = {"preparation_profile": profile(value["stock_revision_id"])}
    draft = op(
        user,
        "definition.create",
        {
            "workspace_id": workspace_of(project),
            "kind": "preparation_profile",
            "name": "Generic formula profile",
            "content": content,
        },
    )
    captured = op(
        user, "draft.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"]
    )
    assert Snapshot.objects.get(id=captured["snapshot_id"]).dependencies.count() == 1
    assert (
        inspect_profile(user, captured["revision_id"])["profile"]["formulas"][0]["allowances"][0][
            "amount_mm"
        ]
        == "20"
    )
    for kind in ["board", "workshop_profile"]:
        with pytest.raises(ValidationFailed):
            op(
                user,
                "definition.create",
                {
                    "workspace_id": workspace_of(project),
                    "kind": kind,
                    "name": "Wrong profile owner",
                    "content": content,
                },
            )
    with pytest.raises(ValidationFailed):
        op(
            user,
            "draft.freeze",
            {"draft_id": draft["draft_id"], "dependencies": [captured["revision_id"]]},
            expected_state=captured["draft"]["state"],
        )


@pytest.mark.parametrize(
    "change",
    [
        lambda p: p["formulas"][0]["allowances"][0].update(amount_mm=1.5),
        lambda p: p["formulas"][0]["allowances"][0].update(amount_mm="-1"),
        lambda p: p["formulas"][0].update(review_basis=None),
        lambda p: p["formulas"][1].update(element_path="stock.jacket"),
        lambda p: p["formulas"][0].update(expression="__import__('os')"),
        lambda p: p["formulas"].append(p["formulas"][0]),
    ],
)
def test_invalid_profile_rolls_back(users, project, change):
    value, _ = cable(users["owner"], project)
    rules = profile(value["stock_revision_id"])
    change(rules)
    count = Definition.objects.count()
    with pytest.raises(ValidationFailed):
        create(users["owner"], project, rules)
    assert Definition.objects.count() == count


def test_permissions_and_exact_stock_matching(users, project):
    user = users["owner"]
    value, target = cable(user, project)
    rules = profile(value["stock_revision_id"])
    for actor in [users["viewer"], users["outsider"]]:
        with pytest.raises((PermissionDenied, NotFound)):
            create(actor, project, rules)
    recipe = freeze(user, create(user, project, rules))
    with pytest.raises((PermissionDenied, NotFound)):
        compute(users["outsider"], target, recipe)
    other, _ = cable(user, project)
    mismatch = freeze(user, create(user, project, profile(other["stock_revision_id"])))
    with pytest.raises(ValidationFailed, match="exact stock"):
        compute(user, target, mismatch)


def test_source_ancestor_revocation_precedes_missing_file_and_replay_diagnostics(users, project):
    user = users["owner"]
    value, target = cable(user, project)
    hidden = op(user, "project.create", {"name": "Synthetic original evidence"})["project_id"]
    parent, _ = evidence(user, hidden)
    _, source = evidence(user, project, parent)
    rules = profile(value["stock_revision_id"])
    rules["formulas"][0]["allowances"][0]["source"] = source
    draft = create(user, project, rules, idempotency_key="source-profile")
    recipe = freeze(user, draft)
    assert compute(user, target, recipe)["rows"][0]["cut_mm"] == "1035"
    # Retained evidence is hidden while the changed incoming profile is independently accessible.
    replacement = profile(value["stock_revision_id"])
    replacement["formulas"][1]["element_path"] = "stock.jacket"
    WorkspaceMember.objects.filter(workspace__projects=hidden, user=user).delete()
    with pytest.raises((NotFound, PermissionDenied)):
        create(user, project, replacement, idempotency_key="source-profile")
    with pytest.raises((NotFound, PermissionDenied)):
        compute(user, target, recipe)
    with pytest.raises((NotFound, PermissionDenied)):
        inspect_profile(user, recipe["revision_id"])
    rules["formulas"][0]["allowances"][0]["source"]["path"] = "missing.txt"
    with pytest.raises((NotFound, PermissionDenied), match=r"^Not found\.$"):
        create(user, project, rules)


def test_explicit_model_basis_trim_and_unknown_quantity_are_separate(users, project):
    user = users["owner"]
    value, target = cable(user, project)
    rules = profile(value["stock_revision_id"], "finished")
    first = rules["formulas"][0]
    first["input_basis"] = "model_suggestion"
    first["allowances"] = [
        {
            "local_id": "trim-a",
            "kind": "trim",
            "scope": "end_a",
            "amount_mm": "0.100001",
            "basis": "Independent exact trim",
        }
    ]
    recipe = freeze(user, create(user, project, rules))
    result = compute(user, target, recipe, quantity=None)
    assert result["rows"][0]["input_mm"] == "1050"
    assert result["rows"][0]["cut_mm"] == "1049.899999"
    assert result["rows"][0]["total_mm"] is None
    assert result["physical_piece_count"] is None
    assert result["rows"][0]["input_provenance"]["model"]["review"] == "reviewed"


@pytest.mark.parametrize("amount", ["1001", "999999999999999"])
def test_invalid_arithmetic_fails_without_partial_results(users, project, amount):
    user = users["owner"]
    value, target = cable(user, project)
    rules = profile(value["stock_revision_id"])
    rules["formulas"][0]["allowances"] = [
        {
            "local_id": "bounded",
            "kind": "trim" if amount == "1001" else "slack",
            "scope": "whole_piece",
            "amount_mm": amount,
            "basis": "Deliberately invalid modeled result",
        }
    ]
    recipe = freeze(user, create(user, project, rules))
    with pytest.raises(ValidationFailed, match="positive exact quantity bounds"):
        compute(user, target, recipe)


def test_every_application_source_is_authorized_before_cut_diagnostics(users, project):
    user = users["owner"]
    stock, _, _, harness = harness_fixture(user, project)
    target = capture_harness(user, create_harness(user, project, harness))
    bad = profile(stock["revision_id"], "stock_cut")
    bad["formulas"][0]["allowances"][0].update(kind="trim", amount_mm="1000")
    bad_revision = freeze(user, create(user, project, bad))
    hidden_project = op(user, "project.create", {"name": "Second profile evidence"})["project_id"]
    _, source = evidence(user, hidden_project)
    hidden = profile(stock["revision_id"], "stock_cut")
    hidden["formulas"][0]["allowances"][0]["source"] = source
    hidden_revision = freeze(user, create(user, project, hidden))
    WorkspaceMember.objects.filter(workspace__projects=hidden_project, user=user).delete()
    with pytest.raises((NotFound, PermissionDenied), match=r"^Not found\.$"):
        op(
            user,
            "preparation.compute",
            {
                "revision_id": target["revision_id"],
                "applications": [
                    {"section_id": "shared", "profile_revision_id": bad_revision["revision_id"]},
                    {"section_id": "branch", "profile_revision_id": hidden_revision["revision_id"]},
                ],
            },
        )


@pytest.mark.parametrize("boundary", ["revision", "draft", "compute", "authority", "query"])
def test_disabled_actor_denied_at_direct_read_boundaries(users, project, boundary):
    from types import SimpleNamespace

    from django.contrib.auth import get_user_model

    from specmate.operations import Unauthenticated
    from specmate.preparation import api
    from specmate.preparation.contracts import ComputeCuts, PreparationProfile

    user = users["owner"]
    value, target = cable(user, project)
    rules = profile(value["stock_revision_id"])
    draft = create(user, project, rules)
    recipe = freeze(user, draft)
    request = SimpleNamespace(user=user)
    calls = {
        "revision": lambda: api.revision(request, recipe["revision_id"]),
        "draft": lambda: api.draft(request, draft["draft_id"]),
        "compute": lambda: api.calculate(
            request,
            ComputeCuts.model_validate(
                {
                    "revision_id": target["revision_id"],
                    "applications": [{"profile_revision_id": recipe["revision_id"]}],
                }
            ),
        ),
        "authority": lambda: api.authority(request, PreparationProfile.model_validate(rules)),
        "query": lambda: inspect_profile(user, recipe["revision_id"]),
    }
    assert calls[boundary]() is not None
    get_user_model().objects.filter(pk=user.pk).update(is_active=False)
    assert user.is_active  # Deliberately stale authenticated request object.
    with pytest.raises(Unauthenticated):
        calls[boundary]()
