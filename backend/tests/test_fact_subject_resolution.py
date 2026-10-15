import pytest

from specmate.facts.models import FactSubject
from specmate.operations import NotFound, Unauthenticated

from .conftest import ensure_member, op, remove_member
from .test_facts import append, design_revision, fact, subject
from .test_transports import api, post_op


def resolve(user, target):
    return op(user, "facts.resolve_subject", {"target": target})["subject"]


def test_resolve_absent_subject_has_no_write_and_preserves_exact_target_distinction(users, project):
    draft, revision = design_revision(users["owner"], project)
    definition = {"kind": "definition", "definition_id": draft["definition_id"]}
    exact = {"kind": "revision", "revision_id": revision["revision_id"]}
    assert resolve(users["viewer"], exact) is None
    assert FactSubject.objects.count() == 0
    original = subject(users["owner"], definition)
    assert resolve(users["viewer"], exact) is None
    assert resolve(users["viewer"], definition) == original
    current = subject(users["owner"], exact)
    assert resolve(users["viewer"], exact) == current
    assert current["subject_id"] != original["subject_id"]
    response = post_op(api(users["viewer"]), "facts.resolve_subject", {"target": exact})
    assert response.status_code == 200
    assert response.json()["result"]["subject"] == current
    assert FactSubject.objects.count() == 2


def test_resolution_requires_current_workspace_principal_even_for_absent_subject(users, project):
    draft, revision = design_revision(users["owner"], project)
    target = {"kind": "revision", "revision_id": revision["revision_id"]}
    subject(users["owner"], target)
    with pytest.raises(NotFound):
        resolve(users["outsider"], target)
    remove_member(users["viewer"])
    with pytest.raises(NotFound):
        resolve(users["viewer"], target)
    ensure_member(users["viewer"])
    assert resolve(users["viewer"], target)
    type(users["viewer"]).objects.filter(pk=users["viewer"].pk).update(is_active=False)
    assert users["viewer"].is_active
    with pytest.raises(Unauthenticated):
        resolve(users["viewer"], {"kind": "definition", "definition_id": draft["definition_id"]})


def test_resolve_authorizes_root_origin_before_absence_and_selected_source_before_return(
    users, project, monkeypatch
):
    from specmate.catalog_packs import authoring
    from specmate.design import operations

    draft, revision = design_revision(users["owner"], project)
    target = {"kind": "revision", "revision_id": revision["revision_id"]}
    original = subject(users["owner"], target)
    actual_origin = authoring.authorize_origin

    def deny_origin(user, definition):
        if user.pk == users["viewer"].pk:
            raise NotFound("Synthetic root origin unavailable.")
        return actual_origin(user, definition)

    monkeypatch.setattr(authoring, "authorize_origin", deny_origin)
    with pytest.raises(NotFound):
        resolve(users["viewer"], {"kind": "definition", "definition_id": draft["definition_id"]})
    monkeypatch.setattr(authoring, "authorize_origin", actual_origin)
    actual_snapshots = operations.authorize_snapshots

    def deny_source(user, snapshots, **kwargs):
        if user.pk == users["viewer"].pk:
            raise NotFound("Synthetic selected source closure unavailable.")
        return actual_snapshots(user, snapshots, **kwargs)

    monkeypatch.setattr(operations, "authorize_snapshots", deny_source)
    with pytest.raises(NotFound):
        resolve(users["viewer"], target)
    monkeypatch.setattr(operations, "authorize_snapshots", actual_snapshots)
    assert resolve(users["viewer"], target) == original


def test_resolve_withdraws_subject_if_its_assertion_evidence_is_unavailable(
    users, project, monkeypatch
):
    from specmate.facts import queries

    draft, _revision = design_revision(users["owner"], project)
    target = {"kind": "definition", "definition_id": draft["definition_id"]}
    ledger = subject(users["owner"], target)
    appended = append(users["owner"], ledger, fact())
    actual = queries.authorize_assertions

    def guard(user, assertions):
        rows = list(assertions)
        if user.pk == users["viewer"].pk and rows:
            raise NotFound("Synthetic assertion evidence unavailable.")
        return actual(user, rows)

    monkeypatch.setattr(queries, "authorize_assertions", guard)
    response = post_op(api(users["viewer"]), "facts.resolve_subject", {"target": target})
    assert response.status_code == 404
    assert "subject_id" not in response.content.decode()
    monkeypatch.setattr(queries, "authorize_assertions", actual)
    assert resolve(users["viewer"], target)["state"] == appended["state"]


def test_remote_registered_evidence_loss_hides_selected_subject_and_restores(users, project):
    from specmate.access.models import WorkspaceMember

    from .scope_helpers import workspace_of
    from .test_sources import ORIGINAL, files, register

    remote = op(users["outsider"], "project.create", {"name": "Synthetic evidence workspace"})[
        "project_id"
    ]
    register(users["outsider"], remote, ORIGINAL)
    source = op(
        users["outsider"],
        "source.create_original_bundle",
        {
            "workspace_id": workspace_of(remote),
            "name": "Synthetic evidence",
            "files": files(ORIGINAL),
        },
    )
    ensure_member(users["editor"], "viewer", project=remote)
    ensure_member(users["viewer"], "viewer", project=remote)
    draft, _revision = design_revision(users["owner"], project)
    target = {"kind": "definition", "definition_id": draft["definition_id"]}
    ledger = subject(users["editor"], target)
    append(
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
    assert resolve(users["viewer"], target)["subject_id"] == ledger["subject_id"]
    WorkspaceMember.objects.filter(user=users["viewer"], workspace_id=workspace_of(remote)).delete()
    with pytest.raises(NotFound):
        resolve(users["viewer"], target)
    ensure_member(users["viewer"], "viewer", project=remote)
    assert resolve(users["viewer"], target)["subject_id"] == ledger["subject_id"]
