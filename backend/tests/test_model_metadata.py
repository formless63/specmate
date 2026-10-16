# ruff: noqa: F811
"""Model purpose/frame/builder are exact declarations, never bbox guesses."""

import pytest
from django.db import DatabaseError, transaction

from specmate.catalog.models import Representation
from specmate.catalog.queries import get_revision_catalog
from specmate.operations import ValidationFailed

from .conftest import op
from .test_catalog import rep_payload, revision, source  # noqa: F401
from .test_mechanical_sources import mec_sources, mec_target  # noqa: F401

METADATA = {
    "units": "mm",
    "frame": "right_handed_y_up",
    "purpose": "illustration",
    "builder_version": "synthetic-quantized/1",
    "basis": "Exact synthetic builder output contract",
}


def test_model_metadata_roundtrips_and_survives_selected_and_coherent_review(
    users,
    revision,
    source,
):
    result = op(
        users["editor"],
        "catalog.register_representation",
        {
            **rep_payload(revision, source),
            "kind": "model",
            "model_metadata": METADATA,
        },
    )
    assert result["model_metadata"] == METADATA
    assert get_revision_catalog(users["viewer"], revision["revision_id"])["representations"] == [
        result
    ]
    selected = op(
        users["viewer"], "selected_package.review", {"root_revision_id": revision["revision_id"]}
    )
    assert selected["manifest"]["catalog_rights"][0]["model_metadata"] == METADATA
    coherent = op(
        users["viewer"], "export_package.review", {"root_revision_id": revision["revision_id"]}
    )
    item = next(
        row
        for row in coherent["manifest"]["rights"]["items"]
        if row["subject"].startswith("representation:")
    )
    assert item["model_metadata"] == METADATA


def test_model_metadata_optional_unknown_and_no_default_meter_assumption(users, revision, source):
    result = op(
        users["editor"],
        "catalog.register_representation",
        {
            **rep_payload(revision, source),
            "kind": "model",
            "model_metadata": {**METADATA, "units": None, "frame": None, "builder_version": None},
        },
    )
    assert result["model_metadata"]["units"] is None
    assert result["model_metadata"]["frame"] is None


@pytest.mark.parametrize(
    "changes",
    [
        {"kind": "drawing"},
        {"model_metadata": {**METADATA, "units": "cm"}},
        {"model_metadata": {**METADATA, "frame": "assume-usual"}},
        {"model_metadata": {**METADATA, "basis": ""}},
    ],
)
def test_invalid_metadata_rejected_without_associations(users, revision, source, changes):
    with pytest.raises(ValidationFailed):
        op(
            users["editor"],
            "catalog.register_representation",
            {
                **rep_payload(revision, source),
                "kind": "model",
                "model_metadata": METADATA,
                **changes,
            },
        )
    assert not Representation.objects.exists()


def test_database_prevents_metadata_on_nonmodel(users, revision, source):
    from specmate.sources.models import SourceBundleFile

    with pytest.raises(DatabaseError), transaction.atomic():
        Representation.objects.create(
            revision_id=revision["revision_id"],
            kind="drawing",
            label="Bad",
            rights_status="unknown",
            source_file=SourceBundleFile.objects.get(revision_id=source["revision_id"]),
            model_metadata=METADATA,
            registered_by=users["editor"],
        )


def test_composed_model_cannot_contradict_retained_unit_frame(
    users, workspace, mec_sources, mec_target
):
    from .test_mechanical_sources import create, declaration

    rep = op(
        users["editor"],
        "catalog.register_representation",
        {
            "revision_id": mec_target["revision_id"],
            "kind": "model",
            "label": "Exact model",
            "source_bundle_revision_id": mec_sources["revision_id"],
            "source_path": "body.step",
            "rights_status": "unknown",
            "model_metadata": METADATA,
        },
    )
    content = declaration(mec_sources, mec_target)
    content["models"] = [
        {
            "local_id": "body",
            "representation_id": rep["representation_id"],
            "revision_id": mec_target["revision_id"],
            "snapshot_sha256": mec_target["sha256"],
            "source_local_id": "native",
            "path": "body.step",
            "target_local_id": "fastener",
            "purpose": "illustration",
            "units": "m",
            "frame": "right_handed_y_up",
            "basis": "Deliberately contradictory scale",
        }
    ]
    with pytest.raises(ValidationFailed, match="contradict"):
        create(users["editor"], workspace, content)
