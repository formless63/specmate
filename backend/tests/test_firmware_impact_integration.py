"""Production operation registration and mounted read transport preserve impact evidence."""

import copy

from specmate.facts.models import FactAssertion

from .conftest import op
from .test_firmware_impact import (  # noqa: F401
    attempt,
    board,
    declaration,
    freeze_firmware,
    intake,
    payload,
    recipe,
    source,
    sources,
)
from .test_transports import api


def test_registered_and_mounted_impact_reads_match_without_fact_writes(
    users,
    project,
    sources,  # noqa: F811
    board,  # noqa: F811
):
    original = declaration(sources, board)
    baseline = freeze_firmware(users, project, original)
    changed = copy.deepcopy(original)
    changed["configuration"] = [{"key": "COUNT", "status": "known", "value": "9"}]
    candidate = freeze_firmware(users, project, changed)
    reference = payload(project, baseline, candidate)
    before = list(FactAssertion.objects.values())
    expected = op(users["viewer"], "firmware_impact.compare", reference)
    response = api(users["viewer"]).post(
        "/api/v0/firmware-impact/compare", reference, content_type="application/json"
    )
    assert response.status_code == 200
    assert response.json() == expected
    assert expected["historical_results_modified"] is False
    assert expected["physical_qualification"] is False
    assert expected["compiler_receipts"] == "not_assessed"
    assert list(FactAssertion.objects.values()) == before
    denied = api(users["outsider"]).post(
        "/api/v0/firmware-impact/compare", reference, content_type="application/json"
    )
    assert denied.status_code == 404
