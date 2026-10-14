"""Independent retained-origin and evidence-isolation checks for contextual reuse."""

import copy

import pytest

from specmate.catalog_packs.models import AdoptionEntry
from specmate.operations import NotFound
from specmate.queries import get_draft

from .conftest import ensure_member, member, op, remove_member
from .test_assemblies import freeze, part
from .test_catalog_packs import adopt, install, manifest, registered
from .test_firmware import attempt, board, intake, recipe, source, sources  # noqa: F401
from .test_firmware_impact import observation
from .test_firmware_impact_crossproject import reused  # noqa: F401


@pytest.mark.parametrize("origin_use", ["context", "occurrence_fact", "definition_fact"])
def test_root_catalog_origin_revocation_precedes_path_diagnostics(users, reused, origin_use):  # noqa: F811
    other = reused["owner"]
    ensure_member(users["editor"], "editor", project=other)
    _, extra = part(users["owner"], other)
    entries = manifest(reused["frozen"])["entries"] + [
        {
            "key": "other",
            "label": "Other pack content",
            "category": "content",
            "revision_id": extra["revision_id"],
            "revision_sha256": extra["sha256"],
            "rights": "synthetic-original",
        }
    ]
    version = registered(users, reused["owner"], reused["frozen"], entries=entries)
    install(users, version)
    adopt(users, version)
    adopted = AdoptionEntry.objects.get()
    frozen = freeze(users["owner"], get_draft(users["owner"], adopted.draft_id))
    data = copy.deepcopy(reused["payload"])
    if origin_use == "context":
        for side in ("baseline", "candidate"):
            data[side]["assembly_snapshot_id"] = frozen["snapshot_id"]
    else:
        target = (
            {"kind": "occurrence", "snapshot_id": frozen["snapshot_id"], "path": ["left"]}
            if origin_use == "occurrence_fact"
            else {"kind": "definition", "definition_id": str(adopted.draft.definition_id)}
        )
        recorded = observation(users, target)
        data["assertion_ids"] = [recorded["assertion_id"]]
    before = op(users["viewer"], "firmware_impact.compare", data)
    wrong = copy.deepcopy(data)
    wrong["candidate"]["path"] = ["unresolved"]
    with pytest.raises(NotFound, match="Exact frozen board occurrence unavailable"):
        op(users["viewer"], "firmware_impact.compare", wrong)
    # Membership loss hides the retained pack origin before path diagnostics.
    remove_member(users["viewer"], project=other)
    with pytest.raises(NotFound, match=r"^Not found\.$"):
        op(users["viewer"], "firmware_impact.compare", wrong)
    with pytest.raises(NotFound):
        op(users["viewer"], "firmware_impact.compare", data)
    member(users["viewer"], "viewer", project=other)
    assert op(users["viewer"], "firmware_impact.compare", data) == before
