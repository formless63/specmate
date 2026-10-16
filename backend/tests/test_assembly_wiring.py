"""Exact repeated reusable leads retain material and exposed flying-end identities."""

import copy
import csv
import io

import pytest

from specmate.operations import Conflict, NotFound, ValidationFailed

from .conftest import op
from .test_assemblies import create, freeze
from .test_section_cables import create as create_cable
from .test_section_cables import freeze as freeze_cable
from .test_wiring_bonds_pigtails import prepared


def fixture(user, project):
    value, _ = prepared(user, project, pigtail=False)
    value["joints"] = [
        {
            "local_id": "populated-source",
            "kind": "termination",
            "members": [
                {"kind": "segment", "segment_id": "lead", "end": "a", "element_path": "stock.core"},
                {
                    "kind": "endpoint",
                    "endpoint_id": "source",
                    "layer_id": "plug",
                    "terminal_id": "a",
                },
            ],
            "basis": "Independent source-end landing",
        }
    ]
    child = freeze_cable(user, create_cable(user, project, value))
    pinout = value["endpoints"][0]["stack"]["layers"][0]["pinout_revision_id"]
    occurrences = [
        {"local_id": id, "revision_id": child["revision_id"], "display_ref": id}
        for id in ["left", "right"]
    ]
    occurrences.append({"local_id": "supply", "revision_id": pinout, "display_ref": "Supply block"})
    relationships = []
    for id in ["left", "right"]:
        relationships.append(
            {
                "kind": "electrical",
                "local_id": id + "-feed",
                "a": {"kind": "occurrence", "path": [id]},
                "b": {"kind": "occurrence", "path": ["supply"]},
                "a_terminal": {
                    "kind": "segment",
                    "segment_id": "lead",
                    "end": "b",
                    "element_path": "stock.core",
                },
                "b_terminal": {"kind": "contact", "contact_id": "a"},
                "basis": "Two independent flying leads land at one declared supply contact",
            }
        )
    return child, occurrences, relationships


def test_typed_assembly_joins_connect_exact_repeated_leads_without_duplicating_material(
    users, project
):
    child, occurrences, relationships = fixture(users["owner"], project)
    parent = freeze(users["owner"], create(users["owner"], project, occurrences, relationships))
    graph = op(users["viewer"], "copper.graph", {"revision_id": parent["revision_id"]})
    left = next(
        n
        for n in graph["nodes"]
        if n["occurrence_path"] == ["left"] and n["terminal"] == relationships[0]["a_terminal"]
    )
    right = next(
        n
        for n in graph["nodes"]
        if n["occurrence_path"] == ["right"] and n["terminal"] == relationships[1]["a_terminal"]
    )
    assert left["id"] != right["id"]
    assert any({left["id"], right["id"]} <= set(c["members"]) for c in graph["components"])
    assert (
        len(
            [
                e
                for e in graph["edges"]
                if e["provenance"].get("declaration", {}).get("kind") == "electrical"
            ]
        )
        == 2
    )
    # Independent oracle: two exact 100mm pieces, no stock piece for the supply block.
    from .test_preparation_documents import configuration, files, retain

    _, retained = retain(users["owner"], configuration(parent), key="nested-lead-documents")
    outputs = files(users["viewer"], retained)
    rows = list(csv.DictReader(io.StringIO(outputs["cut-preparation.csv"].decode())))
    assert (
        sum(int(r["design_total_mm"]) for r in rows if r["row_kind"] == "declared_physical_piece")
        == 200
    )
    assert b"assembly_join" in outputs["schematic.svg"]
    assert b"Two independent flying leads" in outputs["terminations.json"]
    assert child["revision_id"] == occurrences[0]["revision_id"] == occurrences[1]["revision_id"]
    with pytest.raises(NotFound):
        op(users["outsider"], "copper.graph", {"revision_id": parent["revision_id"]})


def test_join_checks_exact_child_terminal_and_stale_parent_token(users, project):
    _, occurrences, relationships = fixture(users["owner"], project)
    bad = copy.deepcopy(relationships)
    bad[0]["a_terminal"]["element_path"] = "stock.absent"
    with pytest.raises(ValidationFailed, match="Terminal"):
        create(users["owner"], project, occurrences, bad)
    owned = copy.deepcopy(relationships)
    owned[0]["a_terminal"]["end"] = "a"
    with pytest.raises(ValidationFailed, match="exposed"):
        create(users["owner"], project, occurrences, owned)
    draft = create(users["owner"], project, occurrences, relationships)
    with pytest.raises(Conflict):
        op(
            users["owner"],
            "assembly.freeze",
            {"draft_id": draft["draft_id"]},
            expected_state="draft-v999",
        )
