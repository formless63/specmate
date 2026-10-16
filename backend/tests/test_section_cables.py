"""Physical section graphs keep cable product identity through shared consumers."""

import copy
import csv
import io
import json

import pytest

from specmate.design.models import Revision
from specmate.export_packages.outputs import formboard_print
from specmate.harnesses.contracts import upgrade_content
from specmate.operations import Conflict, NotFound, PermissionDenied, ValidationFailed

from .conftest import op
from .scope_helpers import workspace_of
from .test_harnesses import fixture


def section_cable(user, project):
    legacy = fixture(user, project)[-1]
    # Fixture includes an uncut shared section and a separately purchased branch.
    return {**upgrade_content(legacy), "schema_version": "0.3"}


def create(user, project, content):
    return op(
        user,
        "cable.create",
        {
            "workspace_id": workspace_of(project),
            "name": "Synthetic multi-section cable",
            "cable": content,
        },
    )


def freeze(user, draft):
    return op(user, "cable.freeze", {"draft_id": draft["draft_id"]}, expected_state=draft["state"])


def test_section_cable_keeps_identity_pins_material_and_copper(users, project):
    value = section_cable(users["owner"], project)
    draft = create(users["owner"], project, value)
    r = freeze(users["owner"], draft)
    rid = r["revision_id"]
    revision = Revision.objects.get(id=rid)
    before = bytes(revision.snapshot.canonical)
    assert revision.definition.kind == "cable"
    assert json.loads(before)["content"]["cable"]["schema_version"] == "0.3"
    inspected = op(users["viewer"], "cable.read", {"revision_id": rid})
    assert "harness" not in inspected
    assert inspected["topology"] == "section_graph"
    assert inspected["quantities"]["physical_piece_count"] == 2
    assert inspected["quantities"]["segment_count"] == 3
    assert inspected["quantities"]["stock"][0]["planned_cut_total_mm"] == "140"
    graph = op(users["viewer"], "copper.graph", {"revision_id": rid})
    assert any(edge["kind"] == "through" for edge in graph["edges"])
    printed = formboard_print(users["viewer"], rid)
    assert printed["unavailable"] is None
    assert bytes(Revision.objects.get(id=rid).snapshot.canonical) == before
    with pytest.raises(NotFound):
        op(users["outsider"], "cable.read", {"revision_id": rid})
    with pytest.raises(PermissionDenied):
        create(users["viewer"], project, value)
    with pytest.raises(Conflict):
        op(
            users["owner"],
            "cable.update",
            {"draft_id": draft["draft_id"], "cable": value},
            expected_state="draft-v999",
        )


def test_flying_lead_and_exact_multi_section_impact(users, project):
    value = section_cable(users["owner"], project)
    # No inferred second connector: this has one populated end and a declared floating end.
    value["endpoints"] = value["endpoints"][:1]
    value["joints"] = [j for j in value["joints"] if j["local_id"] != "output-land"]
    draft = create(users["owner"], project, value)
    first = freeze(users["owner"], draft)
    value2 = copy.deepcopy(value)
    value2["sections"][1]["planned_cut_length_mm"] = "55"
    next_draft = op(
        users["owner"],
        "cable.update",
        {"draft_id": draft["draft_id"], "cable": value2},
        expected_state=first["draft"]["state"],
    )
    second = freeze(users["owner"], next_draft)
    impact = op(
        users["viewer"],
        "cable.length_impact",
        {"before_revision_id": first["revision_id"], "after_revision_id": second["revision_id"]},
    )
    assert impact["changes"] == ["sections"]
    assert impact["stock_revision_changed"] is False
    assert impact["preparation_review_required"] and impact["document_review_required"]
    with pytest.raises(ValidationFailed, match="occurrence choices"):
        op(users["viewer"], "cable_intent.check", {"cable_revision_id": second["revision_id"]})


def test_section_cable_documents_and_material_plan_count_physical_pieces_once(users, project):
    from .test_bom import assembly
    from .test_material_accounting import create as create_plan
    from .test_material_accounting import extent
    from .test_material_accounting import freeze as freeze_plan
    from .test_preparation_documents import configuration, files, retain

    user = users["owner"]
    value = section_cable(user, project)
    frozen = freeze(user, create(user, project, value))
    _, retained = retain(user, configuration(frozen, quantity=2), key="section-cable-docs")
    outputs = files(users["viewer"], retained)
    assert len(outputs) == 6
    # Independent physical oracle: 100 mm shared piece + 40 mm branch, twice.
    cuts = list(csv.DictReader(io.StringIO(outputs["cut-preparation.csv"].decode())))
    assert (
        sum(int(r["design_total_mm"]) for r in cuts if r["row_kind"] == "declared_physical_piece")
        == 280
    )
    plan = {
        "subject_revision_id": frozen["revision_id"],
        "quantity": 2,
        "decision": "make",
        "decision_basis": "Synthetic build decision",
        "pieces": [
            {
                "section_id": section["local_id"],
                "installed": extent("25"),
                "extra_waste": extent("0"),
                "cut_basis": "declaration",
            }
            for section in value["sections"]
        ],
    }
    saved = freeze_plan(user, create_plan(user, project, plan))
    result = op(users["viewer"], "material_plan.read", {"revision_id": saved["revision_id"]})
    assert result["plan"]["subject_revision_id"] == frozen["revision_id"]
    assert len(result["pieces"]) == 2
    root = assembly(user, project, [("lead", frozen)])
    scene = op(users["viewer"], "shared_scene.read", {"snapshot_id": root["snapshot_id"]})
    assert (
        len(
            [
                f
                for node in scene["nodes"]
                for f in node["features"]
                if f["role"] == "physical_section"
            ]
        )
        == 2
    )


def test_section_cable_exports_exact_graph_and_formboard_without_single_stock_projection(
    users, project
):
    from .test_export_packages import download, review

    user = users["owner"]
    frozen = freeze(user, create(user, project, section_cable(user, project)))
    payload = {"root_revision_id": frozen["revision_id"], "quantity": 1}
    reviewed = review(user, payload)
    _, files = download(user, payload, reviewed)
    path = f"cable/{frozen['revision_id']}"
    assert f"{path}/cable.json" in files
    exported = json.loads(files[f"{path}/cable.json"])
    assert exported["cable"]["schema_version"] == "0.3"
    assert "harness" not in exported
    assert f"{path}/formboard-print.html" in files
    assert f"{path}/conductors.csv" not in files  # cannot flatten shared physical identities
