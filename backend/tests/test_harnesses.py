import copy
import json
from decimal import Decimal
from uuid import UUID

import pytest
from django.test import Client

from specmate.access.models import WorkspaceMember
from specmate.design.models import Definition, Snapshot
from specmate.harnesses.contracts import SegmentTerminal
from specmate.harnesses.queries import inspect_relationships, inspect_revision
from specmate.operations import (
    Conflict,
    IdempotencyMismatch,
    NotFound,
    PermissionDenied,
    ValidationFailed,
)
from specmate.queries import get_draft, get_revision

from .conftest import ensure_member, op
from .test_cables import fixture as cable_fixture


def terminal(segment, end, path):
    return {"kind": "segment", "segment_id": segment, "end": end, "element_path": f"stock.{path}"}


def contact(endpoint, feature):
    return {"kind": "endpoint", "endpoint_id": endpoint, "contact_id": feature}


def fixture(user, project):
    _, _, stock, body, pins, _ = cable_fixture(user, project)
    harness = {
        "sections": [
            {
                "local_id": "shared",
                "stock_revision_id": stock["revision_id"],
                "planned_cut_length_mm": 100,
                "cut_basis": "Explicit planned cut",
            },
            {
                "local_id": "branch",
                "stock_revision_id": stock["revision_id"],
                "planned_cut_length_mm": 40,
                "cut_basis": "Explicit branch cut",
            },
        ],
        "segments": [
            {"local_id": "trunk", "section_id": "shared"},
            {"local_id": "leg-one", "section_id": "shared", "element_paths": ["stock.core"]},
            {"local_id": "leg-two", "section_id": "branch"},
        ],
        "endpoints": [
            {
                "local_id": name,
                "body_revision_id": body["revision_id"],
                "pinout_revision_id": pins["revision_id"],
            }
            for name in ("input", "output")
        ],
        "joints": [
            {
                "local_id": "input-land",
                "kind": "termination",
                "members": [terminal("trunk", "a", "core"), contact("input", "a")],
                "basis": "Input table",
            },
            {
                "local_id": "output-land",
                "kind": "termination",
                "members": [terminal("leg-one", "b", "core"), contact("output", "b")],
                "basis": "Output table",
            },
            {
                "local_id": "branch-splice",
                "kind": "splice",
                "members": [terminal("trunk", "b", "drain"), terminal("leg-two", "a", "core")],
                "basis": "Explicit splice declaration",
            },
            {
                "local_id": "screen-bond",
                "kind": "shield_bond",
                "members": [
                    terminal("trunk", "b", "screen"),
                    terminal("leg-two", "a", "screen"),
                    contact("input", "shell"),
                ],
                "basis": "Explicit screen bond",
            },
        ],
        "breakouts": [
            {
                "local_id": "split",
                "trunk": {"segment_id": "trunk", "end": "b"},
                "legs": [{"segment_id": name, "end": "a"} for name in ("leg-one", "leg-two")],
                "fates": [
                    {
                        "local_id": "uncut-core",
                        "kind": "through",
                        "trunk": terminal("trunk", "b", "core"),
                        "leg": terminal("leg-one", "a", "core"),
                        "basis": "Same uncut original core",
                    },
                    *[
                        {"local_id": name, "kind": "joint", "terminal": ref, "joint_id": joint}
                        for name, ref, joint in [
                            ("trunk-splice", terminal("trunk", "b", "drain"), "branch-splice"),
                            ("leg-splice", terminal("leg-two", "a", "core"), "branch-splice"),
                            ("trunk-bond", terminal("trunk", "b", "screen"), "screen-bond"),
                            ("leg-bond", terminal("leg-two", "a", "screen"), "screen-bond"),
                        ]
                    ],
                    {
                        "local_id": "unused-drain",
                        "kind": "unconnected",
                        "terminal": terminal("leg-two", "a", "drain"),
                        "basis": "Explicitly isolated at breakout",
                    },
                ],
            }
        ],
        "review": "reviewed",
        "review_basis": "Independent synthetic branch review",
    }
    return stock, body, pins, harness


def create(user, project, harness, **ctx):
    return op(
        user,
        "harness.create",
        {"project_id": project, "name": "Synthetic harness", "harness": harness},
        **ctx,
    )


def capture(user, draft, **ctx):
    return op(
        user,
        "harness.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
        **ctx,
    )


def test_shared_sections_count_material_once_and_preserve_exact_ids(users, project):
    user = users["owner"]
    stock, body, pins, harness = fixture(user, project)
    draft = create(user, project, harness)
    frozen = capture(user, draft)
    result = inspect_revision(user, frozen["revision_id"], 3)
    assert result["quantities"]["segment_count"] == 9
    assert result["quantities"]["physical_piece_count"] == 6
    assert result["quantities"]["stock"][0]["piece_count"] == 6
    assert Decimal(result["quantities"]["stock"][0]["planned_cut_total_mm"]) == Decimal(420)
    assert len(result["declared_relationships"]) == 5  # Four joints plus one uncut mapping.
    assert len(result["breakout_fates"]) == 7
    assert [f["fate"] for f in result["breakout_fates"]].count("unconnected") == 1
    assert (
        result["continuity"]
        == result["compatibility"]
        == result["physical_qualification"]
        == "not_evaluated"
    )
    snapshot = Snapshot.objects.get(id=frozen["snapshot_id"])
    assert set(snapshot.dependencies.values_list("revision_id", flat=True)) == {
        UUID(v["revision_id"]) for v in (stock, body, pins)
    }
    before = bytes(snapshot.canonical)
    changed = copy.deepcopy(harness)
    changed["sections"][0]["planned_cut_length_mm"] = 200
    op(
        user,
        "harness.update",
        {"draft_id": draft["draft_id"], "harness": changed},
        expected_state=frozen["draft"]["state"],
    )
    assert inspect_revision(user, frozen["revision_id"], 3) == result
    assert bytes(Snapshot.objects.get(id=snapshot.id).canonical) == before


def test_only_declared_relationships_no_implicit_longitudinal_or_shared_section_links(
    users, project
):
    *_, harness = fixture(users["owner"], project)
    frozen = capture(users["owner"], create(users["owner"], project, harness))

    def relations(segment, end, path):
        return inspect_relationships(
            users["owner"],
            frozen["revision_id"],
            SegmentTerminal.model_validate(terminal(segment, end, path)),
        )

    assert [r["id"] for r in relations("trunk", "a", "core")["declared_relationships"]] == [
        "input-land"
    ]
    assert [r["kind"] for r in relations("trunk", "b", "core")["declared_relationships"]] == [
        "through"
    ]
    assert [r["id"] for r in relations("trunk", "b", "screen")["declared_relationships"]] == [
        "screen-bond"
    ]
    assert relations("trunk", "a", "screen")["status"] == "unknown"
    assert relations("leg-two", "b", "screen")["status"] == "unknown"
    assert relations("leg-two", "a", "drain")["declared_relationships"] == []


def test_unknown_lengths_and_omitted_fate_do_not_become_zero_or_unconnected(users, project):
    *_, harness = fixture(users["owner"], project)
    harness["sections"][1]["planned_cut_length_mm"] = None
    harness["breakouts"][0]["fates"].pop()
    frozen = capture(users["owner"], create(users["owner"], project, harness))
    result = inspect_revision(users["owner"], frozen["revision_id"], None)
    assert result["quantities"]["physical_piece_count"] is None
    assert result["quantities"]["stock"][0]["planned_cut_total_mm"] is None
    known_count = inspect_revision(users["owner"], frozen["revision_id"], 2)
    assert known_count["quantities"]["physical_piece_count"] == 4
    assert known_count["quantities"]["stock"][0]["planned_cut_total_mm"] is None
    assert [f["fate"] for f in result["breakout_fates"]].count("unknown") == 1


@pytest.mark.parametrize(
    "mutate",
    [
        lambda h: h["sections"][0].update(cut_basis=None),
        lambda h: h["segments"][0].update(section_id="absent"),
        lambda h: h["segments"][0].update(element_paths=["stock.jacket"]),
        lambda h: h["segments"][0].update(element_paths=["stock"]),
        lambda h: h["joints"][0]["members"][1].update(contact_id="key"),
        lambda h: h["joints"][3]["members"][2].update(contact_id="b"),
        lambda h: h["joints"][3]["members"][0].update(element_path="stock.core"),
        lambda h: h["joints"][1]["members"][1].update(endpoint_id="input", contact_id="a"),
        lambda h: h["breakouts"][0]["fates"][0]["leg"].update(segment_id="leg-two"),
        lambda h: h["breakouts"][0]["fates"][1].update(joint_id="screen-bond"),
        lambda h: h["breakouts"][0]["fates"][0]["trunk"].update(end="a"),
        lambda h: h["breakouts"][0]["fates"][5].update(basis=""),
        lambda h: h["breakouts"][0]["fates"].append(
            {**h["breakouts"][0]["fates"][0], "local_id": "duplicate-uncut"}
        ),
        lambda h: h["breakouts"][0]["fates"].pop(1),
        lambda h: h["breakouts"].append({**h["breakouts"][0], "local_id": "overlapping-breakout"}),
    ],
)
def test_invalid_and_conflicting_relationships_roll_back(users, project, mutate):
    *_, harness = fixture(users["owner"], project)
    mutate(harness)
    before = Definition.objects.count()
    with pytest.raises(ValidationFailed):
        create(users["owner"], project, harness)
    assert Definition.objects.count() == before


def test_one_uncut_feature_cannot_fork_into_two_legs(users, project):
    *_, harness = fixture(users["owner"], project)
    harness["segments"].append(
        {"local_id": "third-leg", "section_id": "shared", "element_paths": ["stock.core"]}
    )
    harness["breakouts"][0]["legs"].append({"segment_id": "third-leg", "end": "a"})
    duplicate = copy.deepcopy(harness["breakouts"][0]["fates"][0])
    duplicate["local_id"] = "invented-fork"
    duplicate["leg"]["segment_id"] = "third-leg"
    harness["breakouts"][0]["fates"].append(duplicate)
    with pytest.raises(ValidationFailed, match="conflicting fates"):
        create(users["owner"], project, harness)


def test_shared_piece_and_labels_alone_do_not_declare_connections(users, project):
    *_, harness = fixture(users["owner"], project)
    harness["joints"] = []
    harness["breakouts"][0]["fates"] = []
    for segment in harness["segments"]:
        segment["label"] = "same label"
    frozen = capture(users["owner"], create(users["owner"], project, harness))
    result = inspect_revision(users["owner"], frozen["revision_id"])
    assert result["declared_relationships"] == []
    assert {f["fate"] for f in result["breakout_fates"]} == {"unknown"}


def test_cas_replay_permissions_and_api_share_operations(users, project):
    *_, harness = fixture(users["owner"], project)
    draft = create(users["owner"], project, harness, idempotency_key="harness-create")
    assert create(users["owner"], project, harness, idempotency_key="harness-create") == draft
    with pytest.raises(IdempotencyMismatch):
        create(
            users["owner"],
            project,
            {**harness, "review": "unreviewed"},
            idempotency_key="harness-create",
        )
    frozen = capture(users["owner"], draft, idempotency_key="harness-freeze")
    assert capture(users["owner"], draft, idempotency_key="harness-freeze") == frozen
    with pytest.raises(Conflict):
        op(
            users["owner"],
            "harness.update",
            {"draft_id": draft["draft_id"], "harness": harness},
            expected_state=draft["state"],
        )
    for actor, error in (("viewer", PermissionDenied), ("outsider", NotFound)):
        with pytest.raises(error):
            create(users[actor], project, harness)
    client = Client()
    client.force_login(users["owner"])
    response = client.post(
        "/api/v0/operations",
        data=json.dumps(
            {
                "operation": "harness.declared_relationships",
                "request_id": "harness-read",
                "payload": {
                    "revision_id": frozen["revision_id"],
                    "terminal": terminal("trunk", "b", "screen"),
                },
            }
        ),
        content_type="application/json",
    )
    assert response.status_code == 200
    assert response.json()["result"]["declared_relationships"][0]["id"] == "screen-bond"
    assert (
        client.get(f"/api/v0/harnesses/revisions/{frozen['revision_id']}?quantity=2").json()[
            "quantities"
        ]["physical_piece_count"]
        == 4
    )
    assert client.get(f"/api/v0/harnesses/drafts/{draft['draft_id']}").status_code == 200
    client.force_login(users["outsider"])
    assert client.get(f"/api/v0/harnesses/revisions/{frozen['revision_id']}").status_code == 404


def source_backed_stock(users, project):
    import hashlib

    from specmate.sources.models import (
        SourceBlob,
        SourceBundle,
        SourceBundleFile,
        SourceBundleRevision,
    )

    from .test_workshop_profiles import profile, stock_revision

    owner = users["owner"]
    stock_id, stock = stock_revision(users, project)
    raw = b"Synthetic harness source basis."
    digest = hashlib.sha256(raw).hexdigest()
    blob = SourceBlob.objects.create(
        project_id=project,
        sha256=digest,
        size=len(raw),
        media_type="text/plain",
        registered_by=owner,
    )
    bundle = SourceBundle.objects.create(
        project_id=project, name="Synthetic harness evidence", role="original", created_by=owner
    )
    source = SourceBundleRevision.objects.create(
        bundle=bundle,
        number=1,
        manifest=b"{}",
        manifest_sha256=hashlib.sha256(b"{}").hexdigest(),
        created_by=owner,
    )
    SourceBundleFile.objects.create(
        revision=source,
        path="basis.txt",
        blob=blob,
        media_type="text/plain",
        rights="synthetic-test",
    )
    documented = profile(
        stock_id,
        foil_visibility={
            "value": "hide",
            "basis": "documented",
            "source": {
                "kind": "source_file",
                "bundle_revision_id": str(source.id),
                "path": "basis.txt",
                "locator": "line 1",
                "sha256": digest,
                "rights": "synthetic-test",
            },
        },
    )
    practice = op(
        owner,
        "workshop_profile.create",
        {"project_id": project, "name": "Synthetic practice", "profile": documented},
    )
    practice_revision = op(
        owner,
        "workshop_profile.freeze",
        {"draft_id": practice["draft_id"]},
        expected_state=practice["state"],
    )
    stock_draft = op(
        owner,
        "wire_stock.create",
        {"project_id": project, "name": "Referenced stock", "stock": stock},
    )
    frozen = op(
        owner,
        "draft.freeze",
        {"draft_id": stock_draft["draft_id"], "dependencies": [practice_revision["revision_id"]]},
        expected_state=stock_draft["state"],
    )
    return frozen, bundle


def test_deep_source_denial_precedes_relationship_diagnostics_current_stale_replay_and_read(
    users, project
):
    owner, user = users["owner"], users["editor"]
    WorkspaceMember.objects.filter(user=user, workspace__projects=project).update(
        grants=["design.freeze"]
    )
    stock, bundle = source_backed_stock(users, project)
    harness = {
        "sections": [{"local_id": "piece", "stock_revision_id": stock["revision_id"]}],
        "segments": [{"local_id": "run", "section_id": "piece"}],
    }
    draft = create(user, project, harness, idempotency_key="source-harness")
    frozen = capture(user, draft, idempotency_key="source-freeze")
    hidden = op(owner, "project.create", {"name": "Restricted evidence"})["project_id"]
    bundle.project_id = hidden
    bundle.save(update_fields=["project"])
    malformed = copy.deepcopy(harness)
    malformed["segments"][0]["section_id"] = "missing"
    malformed["sections"][0]["planned_cut_length_mm"] = -1
    actions = [
        lambda: create(user, project, malformed),
        lambda: create(user, project, harness, idempotency_key="source-harness"),
        lambda: capture(user, draft, idempotency_key="source-freeze"),
        lambda: inspect_revision(user, frozen["revision_id"]),
        lambda: get_revision(user, frozen["revision_id"]),
        lambda: get_draft(user, draft["draft_id"]),
        lambda: inspect_relationships(
            user,
            frozen["revision_id"],
            SegmentTerminal.model_validate(terminal("missing", "a", "absent")),
        ),
    ]
    for state in (frozen["draft"]["state"], "stale"):
        actions.append(
            lambda state=state: op(
                user,
                "harness.update",
                {"draft_id": draft["draft_id"], "harness": malformed},
                expected_state=state,
            )
        )
    for action in actions:
        with pytest.raises(NotFound):
            action()
    client = Client()
    client.force_login(user)
    for path in (
        f"harnesses/revisions/{frozen['revision_id']}",
        f"harnesses/drafts/{draft['draft_id']}",
        f"revisions/{frozen['revision_id']}/snapshot",
    ):
        response = client.get(f"/api/v0/{path}")
        assert response.status_code == 404
        assert stock["revision_id"].encode() not in response.content


def test_stored_replay_still_checks_old_pins_after_current_draft_changes(users, project):
    owner, user = users["owner"], users["editor"]
    private = op(owner, "project.create", {"name": "Restricted later"})["project_id"]
    grant = ensure_member(user, "viewer", project=private)
    *_, old = fixture(owner, private)
    *_, current = fixture(owner, project)
    draft = create(user, project, old, idempotency_key="old-harness")
    changed = op(
        user,
        "harness.update",
        {"draft_id": draft["draft_id"], "harness": old},
        expected_state=draft["state"],
        idempotency_key="old-update",
    )
    op(
        user,
        "harness.update",
        {"draft_id": draft["draft_id"], "harness": current},
        expected_state=changed["state"],
    )
    grant.delete()
    assert (
        get_draft(user, draft["draft_id"])["content"]["harness"]["sections"][0]["stock_revision_id"]
        == current["sections"][0]["stock_revision_id"]
    )
    with pytest.raises(NotFound):
        create(user, project, old, idempotency_key="old-harness")
    with pytest.raises(NotFound):
        op(
            user,
            "harness.update",
            {"draft_id": draft["draft_id"], "harness": old},
            expected_state=draft["state"],
            idempotency_key="old-update",
        )
    with pytest.raises(NotFound):
        op(
            user,
            "harness.update",
            {"draft_id": draft["draft_id"], "harness": old},
            expected_state="stale",
        )


def test_generic_commands_derive_exact_closure_and_reject_wrong_kind_or_pins(users, project):
    *_, harness = fixture(users["owner"], project)
    draft = op(
        users["owner"],
        "definition.create",
        {
            "project_id": project,
            "name": "Generic harness",
            "kind": "harness",
            "content": {"harness": harness},
        },
    )
    frozen = op(
        users["owner"],
        "draft.freeze",
        {"draft_id": draft["draft_id"]},
        expected_state=draft["state"],
    )
    assert Snapshot.objects.get(id=frozen["snapshot_id"]).dependencies.count() == 3
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "draft.freeze",
            {
                "draft_id": draft["draft_id"],
                "dependencies": [harness["sections"][0]["stock_revision_id"]],
            },
            expected_state=frozen["draft"]["state"],
        )
    with pytest.raises(ValidationFailed):
        op(
            users["owner"],
            "definition.create",
            {
                "project_id": project,
                "name": "Wrong kind",
                "kind": "cable",
                "content": {"harness": harness},
            },
        )


@pytest.mark.django_db(transaction=True)
def test_concurrent_harness_edits_have_one_winner(users, project):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from django.db import close_old_connections, connections

    *_, harness = fixture(users["owner"], project)
    draft = create(users["owner"], project, harness)
    barrier = Barrier(2)

    def edit(basis):
        close_old_connections()
        try:
            barrier.wait(timeout=5)
            op(
                users["owner"],
                "harness.update",
                {"draft_id": draft["draft_id"], "harness": {**harness, "review_basis": basis}},
                expected_state=draft["state"],
            )
            return "saved"
        except Conflict:
            return "conflict"
        finally:
            connections.close_all()

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(edit, ["First review", "Second review"])) == ["conflict", "saved"]


def test_explicit_multiway_splice_is_one_relationship_with_three_exact_members(users, project):
    *_, harness = fixture(users["owner"], project)
    harness["joints"] = [j for j in harness["joints"] if j["local_id"] != "output-land"]
    splice = next(j for j in harness["joints"] if j["local_id"] == "branch-splice")
    splice["members"].append(terminal("leg-one", "b", "core"))
    frozen = capture(users["owner"], create(users["owner"], project, harness))
    inspected = inspect_relationships(
        users["owner"],
        frozen["revision_id"],
        SegmentTerminal.model_validate(terminal("trunk", "b", "drain")),
    )
    assert len(inspected["declared_relationships"]) == 1
    assert inspected["declared_relationships"][0]["members"] == splice["members"]
    assert inspected["continuity"] == "not_evaluated"


@pytest.mark.parametrize("amount", [0.1, 1e-20, True, "0.000000001", 0, -1])
def test_unsupported_or_nonpositive_planned_lengths_are_rejected(users, project, amount):
    *_, harness = fixture(users["owner"], project)
    harness["sections"][0]["planned_cut_length_mm"] = amount
    with pytest.raises(ValidationFailed):
        create(users["owner"], project, harness)


def test_exact_original_decimal_cuts_survive_capture_and_sum_without_float_rounding(users, project):
    from decimal import localcontext

    *_, harness = fixture(users["owner"], project)
    harness["sections"][0]["planned_cut_length_mm"] = "0.1000"
    harness["sections"][1]["planned_cut_length_mm"] = "0.2"
    frozen = capture(users["owner"], create(users["owner"], project, harness))
    with localcontext() as context:
        context.prec = 6
        result = inspect_revision(users["owner"], frozen["revision_id"])
    assert result["harness"]["sections"][0]["planned_cut_length_mm"] == "0.1000"
    assert result["harness"]["sections"][0]["cut_basis"] == "Explicit planned cut"
    assert result["quantities"]["stock"][0]["planned_cut_total_mm"] == "0.3"


@pytest.mark.parametrize(
    "left,right,count,expected",
    [
        ("999999999999999", "0.000001", 1, "999999999999999.000001"),
        ("0.1", "0.2", 3, "0.9"),
        ("999999999999999.999999", None, 1000000, None),
    ],
)
def test_bounded_exact_sum_product_and_unknown_totals(left, right, count, expected):
    from decimal import localcontext
    from types import SimpleNamespace

    from specmate.harnesses.queries import planned_cut_total

    sections = [
        SimpleNamespace(planned_cut_length_mm=Decimal(v) if v is not None else None)
        for v in (left, right)
    ]
    with localcontext() as context:
        context.prec = 6
        assert planned_cut_total(sections, count) == expected


@pytest.mark.parametrize(
    "values,count",
    [
        (["999999999999999.999999", "0.000001"], 1),
        (["100000000000000"], 10),
    ],
)
def test_sum_and_product_overflow_are_rejected(values, count):
    from types import SimpleNamespace

    from specmate.harnesses.queries import planned_cut_total

    with pytest.raises(ValidationFailed, match="exact quantity bounds"):
        planned_cut_total(
            [SimpleNamespace(planned_cut_length_mm=Decimal(v)) for v in values], count
        )
