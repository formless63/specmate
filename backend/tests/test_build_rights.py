"""Rights derivation is advisory and total: it never raises and never gates execution."""

import pytest

from specmate.builds.rights import derive_for_record, derive_output_rights


@pytest.mark.parametrize(
    ("rights", "expected"),
    [
        ([], ("unknown", "unknown")),
        (["MIT"], ("MIT", "uniform")),
        (["MIT", "MIT"], ("MIT", "uniform")),
        (["MIT", "Proprietary"], ("Proprietary", "most_restrictive")),
        (["MIT", "proprietary", "Apache-2.0"], ("proprietary", "most_restrictive")),
        (["MIT", "Apache-2.0"], ("unknown", "unknown")),
        (["Proprietary", "Confidential"], ("unknown", "unknown")),
        (["MIT", "Unknown"], ("unknown", "unknown")),
        (["MIT", ""], ("unknown", "unknown")),
    ],
)
def test_derive_output_rights(rights, expected):
    assert derive_output_rights(rights) == expected


def test_record_without_staged_inputs_is_unknown():
    assert derive_for_record(None) == ("unknown", "unknown")
    assert derive_for_record([{"rights": "MIT"}, {"rights": "confidential"}]) == (
        "confidential",
        "most_restrictive",
    )
