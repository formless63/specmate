"""Product declarations reuse exact generic design authority without release semantics."""

import json

import pytest
from pydantic import ValidationError

from specmate.design.models import Definition, Snapshot
from specmate.operations import Conflict, NotFound, PermissionDenied, ValidationFailed
from specmate.products.contracts import LineupQuery, ProductFamily
from specmate.products.queries import lineup
from specmate.queries import get_revision

from .conftest import ensure_member, op, remove_member
from .test_design import freeze
from .test_transports import api, post_op


def create(user, workspace, kind="product_family", content=None, **ctx):
    return op(
        user,
        "definition.create",
        {
            "workspace_id": workspace,
            "kind": kind,
            "name": f"Synthetic {kind}",
            "content": content or {},
        },
        **ctx,
    )


def frozen(user, draft):
    return freeze(user, draft["draft_id"], draft["state"])


def family(revision):
    return {
        "schema_version": "1",
        "number": None,
        "options": [
            {
                "local_id": "color",
                "label": "Color",
                "values": [
                    {"local_id": "red", "label": "Red"},
                    {"local_id": "blue", "label": "Blue"},
                ],
            }
        ],
        "variants": [
            {
                "local_id": "short",
                "design_revision_id": revision["revision_id"],
                "declared_length_mm": "150.125",
                "options": {"color": "red"},
            },
            {
                "local_id": "long",
                "design_revision_id": revision["revision_id"],
                "number": "AUTHORED-2",
                "declared_length_mm": None,
                "options": {"color": "blue"},
            },
        ],
    }


def test_exact_family_generic_save_freeze_read_and_no_design_or_release_mutation(
    users, workspace, project
):
    owner = users["owner"]
    from .test_cables import fixture as cable_fixture

    design = create(owner, workspace, "cable", {"cable": cable_fixture(owner, project)[-1]})
    first = frozen(owner, design)
    original = bytes(Snapshot.objects.get(id=first["snapshot_id"]).canonical)
    f = create(
        owner,
        workspace,
        content={"product_family": family(first), "extra": [None, "retained"]},
        idempotency_key="family-create",
    )
    assert (
        create(
            owner,
            workspace,
            content={"product_family": family(first), "extra": [None, "retained"]},
            idempotency_key="family-create",
        )
        == f
    )
    published = frozen(owner, f)
    old = bytes(Snapshot.objects.get(id=published["snapshot_id"]).canonical)
    assert set(
        Snapshot.objects.get(id=published["snapshot_id"]).dependencies.values_list(
            "revision_id", flat=True
        )
    ) == {get_revision(owner, first["revision_id"]).id}
    newer = frozen(owner, {**design, **first["draft"]})
    result = op(users["viewer"], "products.lineup", {"workspace_id": workspace})
    assert len(result["results"]) == 2
    assert {row["design"]["revision_id"] for row in result["results"]} == {first["revision_id"]}
    assert result["results"][1]["variant"]["declared_length_mm"] is None
    assert result["results"][0]["variant"]["declared_length_mm"] == "150.125"
    assert result["results"][0]["family"]["revision_id"] == published["revision_id"]
    assert "release" not in json.dumps(result)
    assert bytes(Snapshot.objects.get(id=first["snapshot_id"]).canonical) == original
    assert bytes(Snapshot.objects.get(id=published["snapshot_id"]).canonical) == old
    assert newer["revision_id"] != first["revision_id"]
    from specmate.releases.models import Release

    assert Release.objects.count() == 0


@pytest.mark.parametrize(
    "change",
    [
        {"declared_length_mm": "0"},
        {"declared_length_mm": "-2"},
        {"declared_length_mm": "NaN"},
        {"options": {"color": "green"}},
    ],
)
def test_invalid_variant_shape_is_rejected(change):
    value = family({"revision_id": "00000000-0000-0000-0000-000000000001"})
    value["variants"][0].update(change)
    with pytest.raises(ValidationError):
        ProductFamily.model_validate(value)


def test_duplicate_axis_variant_and_wrong_container_are_rejected(users, workspace):
    value = family({"revision_id": "00000000-0000-0000-0000-000000000001"})
    value["variants"].append(value["variants"][0])
    with pytest.raises(ValidationError):
        ProductFamily.model_validate(value)
    value = family({"revision_id": "00000000-0000-0000-0000-000000000001"})
    value["options"].append(value["options"][0])
    with pytest.raises(ValidationError):
        ProductFamily.model_validate(value)
    with pytest.raises(ValidationFailed):
        create(users["owner"], workspace)
    with pytest.raises(ValidationFailed):
        create(users["owner"], workspace, "part", {"product_family": value})


def test_kind_foreign_pin_and_unauthorized_roll_back(users, workspace, other_workspace):
    owner = users["owner"]
    target = frozen(owner, create(owner, workspace, "part"))
    before = Definition.objects.count()
    with pytest.raises(ValidationFailed):
        create(owner, workspace, content={"product_family": family(target)})
    assert Definition.objects.count() == before
    foreign = frozen(users["outsider"], create(users["outsider"], other_workspace, "assembly"))
    ensure_member(owner, workspace=other_workspace)
    with pytest.raises(NotFound):
        create(owner, workspace, content={"product_family": family(foreign)})
    assert Definition.objects.count() == before + 1
    with pytest.raises(PermissionDenied):
        create(users["viewer"], workspace, content={"product_family": family(target)})
    with pytest.raises(NotFound):
        lineup(users["outsider"], LineupQuery(workspace_id=workspace))


def test_working_families_excluded_and_signed_asof_pagination_remains_exact(
    users, workspace, project
):
    owner = users["owner"]
    from .test_harnesses import fixture as harness_fixture

    design = frozen(
        owner, create(owner, workspace, "harness", {"harness": harness_fixture(owner, project)[-1]})
    )
    f = create(owner, workspace, content={"product_family": family(design)})
    assert lineup(owner, LineupQuery(workspace_id=workspace))["results"] == []
    first = frozen(owner, f)
    query = LineupQuery(workspace_id=workspace, limit=1)
    page = lineup(owner, query)
    assert len(page["results"]) == 1 and page["next_after"]
    next_revision = frozen(owner, {**f, **first["draft"]})
    more = lineup(owner, query.model_copy(update={"after": page["next_after"]}))
    assert more["as_of"] == page["as_of"]
    assert more["results"][0]["variant"]["local_id"] == "long"
    assert more["results"][0]["family"]["revision_id"] == first["revision_id"]
    assert more["next_after"] is None
    assert (
        lineup(owner, query)["results"][0]["family"]["revision_id"] == next_revision["revision_id"]
    )
    for actor, q in [(users["viewer"], query), (owner, query.model_copy(update={"limit": 2}))]:
        with pytest.raises(ValidationFailed):
            lineup(actor, q.model_copy(update={"after": page["next_after"]}))
    with pytest.raises(ValidationFailed):
        lineup(owner, query.model_copy(update={"after": page["next_after"] + "invalid"}))


def test_latest_denied_family_never_falls_back_and_authority_precedes_cas_or_replay(
    users, workspace, monkeypatch
):
    owner = users["owner"]
    design = frozen(owner, create(owner, workspace, "assembly"))
    f = create(
        owner,
        workspace,
        content={"product_family": family(design)},
        idempotency_key="retained-family",
    )
    first = frozen(owner, f)
    second = frozen(owner, {**f, **first["draft"]})
    original = bytes(Snapshot.objects.get(id=first["snapshot_id"]).canonical)
    from specmate.design import operations

    previous = operations.authorize_snapshots

    def deny_latest(user, snapshots, **kwargs):
        snapshots = list(snapshots)
        if any(str(s.id) == second["snapshot_id"] for s in snapshots):
            raise NotFound("Not found.")
        return previous(user, snapshots, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(operations, "authorize_snapshots", deny_latest)
        assert lineup(owner, LineupQuery(workspace_id=workspace))["results"] == []
        assert get_revision(owner, first["revision_id"])
    remove_member(owner)
    with pytest.raises(NotFound):
        create(
            owner,
            workspace,
            content={"product_family": family(design)},
            idempotency_key="retained-family",
        )
    ensure_member(owner, role="admin")
    with pytest.raises(Conflict):
        op(
            owner,
            "draft.update",
            {"draft_id": f["draft_id"], "changes": {}},
            expected_state=f["state"],
        )
    assert bytes(Snapshot.objects.get(id=first["snapshot_id"]).canonical) == original


def test_http_lineup_uses_shared_query_and_project_binding(users, workspace):
    owner = users["owner"]
    design = frozen(owner, create(owner, workspace, "assembly"))
    f = create(owner, workspace, content={"product_family": family(design)})
    frozen(owner, f)
    project = op(
        owner, "project.create", {"workspace_id": workspace, "name": "Synthetic lineup context"}
    )
    page = lineup(owner, LineupQuery(workspace_id=workspace, limit=1))
    with pytest.raises(ValidationFailed):
        lineup(
            owner,
            LineupQuery(
                workspace_id=workspace,
                project_id=project["project_id"],
                limit=1,
                after=page["next_after"],
            ),
        )
    response = post_op(api(users["viewer"]), "products.lineup", {"workspace_id": workspace})
    assert response.status_code == 200
    assert len(response.json()["result"]["results"]) == 2


def test_current_dependent_authority_precedes_retained_replay_and_stale_cas(
    users, workspace, monkeypatch
):
    """Inject the shared closure boundary, not a fictitious per-design membership ACL."""
    owner = users["owner"]
    design = frozen(owner, create(owner, workspace, "assembly"))
    content = {"product_family": family(design)}
    f = create(owner, workspace, content=content, idempotency_key="family-closure")
    updated = op(
        owner,
        "draft.update",
        {"draft_id": f["draft_id"], "changes": {"extra": "retained"}},
        expected_state=f["state"],
        idempotency_key="family-save",
    )
    first = frozen(owner, {**f, **updated})
    before = bytes(Snapshot.objects.get(id=first["snapshot_id"]).canonical)
    from specmate.design import operations

    previous = operations.authorize_snapshots
    blocked = True

    def guard(user, snapshots, **kwargs):
        snapshots = list(snapshots)
        if blocked and any(str(s.id) == design["snapshot_id"] for s in snapshots):
            raise NotFound("Current synthetic source closure unavailable.")
        return previous(user, snapshots, **kwargs)

    monkeypatch.setattr(operations, "authorize_snapshots", guard)
    with pytest.raises(NotFound):
        create(owner, workspace, "part", {"unrelated": True}, idempotency_key="family-closure")
    with pytest.raises(NotFound):
        op(
            owner,
            "draft.update",
            {"draft_id": f["draft_id"], "changes": {}},
            expected_state="stale",
        )
    with pytest.raises(NotFound):
        get_revision(users["viewer"], first["revision_id"])
    assert lineup(users["viewer"], LineupQuery(workspace_id=workspace))["results"] == []
    blocked = False
    assert (
        create(owner, workspace, content=content, idempotency_key="family-closure")["definition_id"]
        == f["definition_id"]
    )
    assert get_revision(users["viewer"], first["revision_id"])
    assert bytes(Snapshot.objects.get(id=first["snapshot_id"]).canonical) == before


def test_versions_authorizes_each_choice_without_denied_draft_hiding_old_frozen(
    users, workspace, monkeypatch
):
    from specmate.design import operations

    owner = users["owner"]
    first_design = frozen(owner, create(owner, workspace, "assembly"))
    newer_design = frozen(owner, create(owner, workspace, "assembly"))
    f = create(owner, workspace, content={"product_family": family(first_design)})
    first = frozen(owner, f)
    op(
        owner,
        "draft.update",
        {"draft_id": f["draft_id"], "changes": {"product_family": family(newer_design)}},
        expected_state=first["draft"]["state"],
    )
    before = op(users["viewer"], "products.versions", {"definition_id": f["definition_id"]})
    assert [row["number"] for row in before["revisions"]] == [1]
    assert before["drafts"][0]["label"].startswith("Working draft v3")
    original = operations.authorize_snapshots

    def guard(user, snapshots, **kwargs):
        snapshots = list(snapshots)
        if any(str(snapshot.pk) == newer_design["snapshot_id"] for snapshot in snapshots):
            raise NotFound("Synthetic current source boundary.")
        return original(user, snapshots, **kwargs)

    monkeypatch.setattr(operations, "authorize_snapshots", guard)
    limited = op(users["viewer"], "products.versions", {"definition_id": f["definition_id"]})
    assert limited["drafts"] == []
    assert limited["revisions"] == before["revisions"]
    assert get_revision(users["viewer"], first["revision_id"])
