import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from specmate.contracts import SCHEMAS, OperationEnvelope, SourceBundleManifest
from specmate.operations.management.commands.export_contract_schemas import render

CONTRACTS = Path(__file__).resolve().parents[2] / "contracts"


def test_retained_examples_validate():
    OperationEnvelope.model_validate_json((CONTRACTS / "examples/operation.json").read_text())
    SourceBundleManifest.model_validate_json(
        (CONTRACTS / "examples/source-bundle.json").read_text()
    )


@pytest.mark.parametrize("name", sorted(SCHEMAS))
def test_committed_schemas_match_models(name):
    committed = (CONTRACTS / "schema" / f"{name}.json").read_text()
    assert committed == render(SCHEMAS[name]), "run manage.py export_contract_schemas"


def test_envelope_rejects_caller_supplied_actor():
    with pytest.raises(ValidationError):
        OperationEnvelope(operation="draft.update", request_id="r1", actor="someone")


@pytest.mark.parametrize(
    "path",
    ["../escape.txt", "/abs.txt", "a/../b.txt", "a//b.txt", "./a.txt", "a\\b.txt", "C:x", "a\x00"],
)
def test_manifest_rejects_unsafe_paths(path):
    example = json.loads((CONTRACTS / "examples/source-bundle.json").read_text())
    example["files"][0]["path"] = path
    with pytest.raises(ValidationError):
        SourceBundleManifest.model_validate(example)


def test_manifest_rejects_paths_differing_only_in_case():
    example = json.loads((CONTRACTS / "examples/source-bundle.json").read_text())
    entry = example["files"][0]
    example["files"] = [entry, {**entry, "path": entry["path"].upper()}]
    with pytest.raises(ValidationError):
        SourceBundleManifest.model_validate(example)
