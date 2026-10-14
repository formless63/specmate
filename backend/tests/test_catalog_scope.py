"""Catalog keyed writes preserve current authority and isolate workspaces."""

import pytest

from specmate.access.models import WorkspaceMember
from specmate.catalog.models import ManufacturerVariant, PhysicalLot, Representation
from specmate.operations import IdempotencyMismatch, NotFound, PermissionDenied
from specmate.operations.models import IdempotencyRecord

from .conftest import member, op
from .scope_helpers import workspace_of
from .test_catalog import rep_payload, variant_payload
from .test_design import freeze
from .test_sources import ORIGINAL, files, register
from .test_transports import api, post_op


@pytest.fixture
def catalog_inputs(users, project, definition):
    return make_inputs(users["owner"], project, definition)


def make_inputs(user, project, definition=None):
    if definition is None:
        definition = op(
            user,
            "definition.create",
            {
                "workspace_id": workspace_of(project),
                "kind": "part",
                "name": "Scoped catalog part",
            },
        )
    revision = freeze(user, definition["draft_id"], definition["state"])
    register(user, project, ORIGINAL)
    source = op(
        user,
        "source.create_original_bundle",
        {
            "workspace_id": workspace_of(project),
            "name": "Scoped source",
            "files": files(ORIGINAL),
        },
    )
    return {
        "catalog.register_variant": variant_payload(revision),
        "catalog.register_lot": {"revision_id": revision["revision_id"], "label": "Lot"},
        "catalog.register_representation": rep_payload(revision, source),
    }


OPERATIONS = ["catalog.register_variant", "catalog.register_lot", "catalog.register_representation"]


@pytest.mark.parametrize("operation", OPERATIONS)
def test_catalog_key_is_one_namespace_per_workspace(
    users, project, workspace, other_workspace, catalog_inputs, operation
):
    user = users["owner"]
    # Another project of the same workspace shares the namespace: a reused key with a
    # different registration is a mismatch, never a second record.
    same = op(user, "project.create", {"name": "Second catalog project"})["project_id"]
    same_inputs = make_inputs(user, same)
    first = op(user, operation, catalog_inputs[operation], idempotency_key="shared-key")
    with pytest.raises(IdempotencyMismatch):
        op(user, operation, same_inputs[operation], idempotency_key="shared-key")
    # A second workspace the actor belongs to has its own namespace.
    member(user, "editor", workspace=other_workspace)
    foreign = op(
        user, "project.create", {"name": "Foreign catalog project", "workspace_id": other_workspace}
    )["project_id"]
    second_inputs = make_inputs(user, foreign)
    second = op(user, operation, second_inputs[operation], idempotency_key="shared-key")
    assert first["definition_id"] != second["definition_id"]
    assert op(user, operation, catalog_inputs[operation], idempotency_key="shared-key") == first
    assert op(user, operation, second_inputs[operation], idempotency_key="shared-key") == second
    assert set(
        IdempotencyRecord.objects.filter(operation=operation).values_list("scope", flat=True)
    ) == {f"workspace:{workspace}", f"workspace:{other_workspace}"}


@pytest.mark.parametrize("operation", OPERATIONS)
def test_contributor_registers_catalog_associations_but_viewer_cannot(
    users, catalog_inputs, operation
):
    with pytest.raises(PermissionDenied):
        op(users["viewer"], operation, catalog_inputs[operation])
    assert op(users["contributor"], operation, catalog_inputs[operation])["definition_id"]
    with pytest.raises(NotFound):
        op(users["outsider"], operation, catalog_inputs[operation])


@pytest.mark.parametrize("operation", OPERATIONS)
@pytest.mark.parametrize("via", ["api", "job"])
@pytest.mark.parametrize("revocation", ["membership", "edit_authority"])
def test_catalog_replay_rechecks_current_scope_and_edit_grant(
    users, project, catalog_inputs, operation, via, revocation
):
    user = users["editor"]
    payload = catalog_inputs[operation]
    options = {"idempotency_key": "retained-catalog"}
    stored = op(user, operation, payload, **options)
    if revocation == "membership":
        WorkspaceMember.objects.filter(workspace__projects=project, user=user).delete()
        expected_error, status = NotFound, 404
    else:
        WorkspaceMember.objects.filter(workspace__projects=project, user=user).update(role="viewer")
        expected_error, status = PermissionDenied, 403
    if via == "api":
        response = post_op(api(user), operation, payload, **options)
        assert response.status_code == status
        assert "result" not in response.json()
    else:
        with pytest.raises(expected_error):
            op(user, operation, payload, **options)
    record = IdempotencyRecord.objects.get(operation=operation)
    assert record.result == stored
    assert (
        ManufacturerVariant.objects.count()
        + PhysicalLot.objects.count()
        + Representation.objects.count()
        == 1
    )


@pytest.mark.parametrize("operation", OPERATIONS)
def test_revoked_catalog_scope_does_not_disclose_fingerprint_match(
    users, project, catalog_inputs, operation
):
    user = users["editor"]
    payload = catalog_inputs[operation]
    op(user, operation, payload, idempotency_key="retained-catalog")
    WorkspaceMember.objects.filter(workspace__projects=project, user=user).delete()
    changed = {
        **payload,
        **({"part_number": "Changed"} if operation.endswith("variant") else {"label": "Changed"}),
    }
    with pytest.raises(NotFound):
        op(user, operation, changed, idempotency_key="retained-catalog")


def test_lot_replay_preserves_pinned_manufacturer_variant(users, catalog_inputs):
    user = users["owner"]
    variant = op(user, "catalog.register_variant", catalog_inputs["catalog.register_variant"])
    payload = {**catalog_inputs["catalog.register_lot"], "variant_id": variant["variant_id"]}
    first = op(user, "catalog.register_lot", payload, idempotency_key="variant-lot")
    assert op(user, "catalog.register_lot", payload, idempotency_key="variant-lot") == first
    assert first["variant_id"] == variant["variant_id"]
    assert PhysicalLot.objects.count() == 1
