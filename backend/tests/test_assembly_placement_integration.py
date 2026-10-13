"""Production placement reads preserve frozen pins and server authority."""

from specmate.design.models import Draft, Snapshot

from .conftest import op
from .test_assemblies import create, freeze, occ, part
from .test_transports import api


def test_registered_placement_read_matches_mounted_transport_without_mutation(users, project):
    owner = users["owner"]
    _, board = part(owner, project)
    nested = freeze(owner, create(owner, project, [occ("board", board)]))
    draft = create(owner, project, [occ("left", nested), occ("right", nested)])
    before = (list(Draft.objects.values()), list(Snapshot.objects.values()))
    payload = {"draft_id": draft["draft_id"]}
    expected = op(users["viewer"], "assembly.placement_inputs", payload)
    response = api(users["viewer"]).get(
        f"/api/v0/assemblies/drafts/{draft['draft_id']}/placement-inputs"
    )
    assert response.status_code == 200
    assert response.json() == expected
    assert [row["path"] for row in expected["occurrences"]] == [
        ["left"],
        ["left", "board"],
        ["right"],
        ["right", "board"],
    ]
    assert all(row["placement"]["status"] == "unknown" for row in expected["occurrences"])
    assert expected["fit"] == expected["clearance"] == "not_evaluated"
    assert expected["physical_qualification"] is False
    assert (list(Draft.objects.values()), list(Snapshot.objects.values())) == before
    denied = api(users["outsider"]).get(
        f"/api/v0/assemblies/drafts/{draft['draft_id']}/placement-inputs"
    )
    assert denied.status_code == 404
