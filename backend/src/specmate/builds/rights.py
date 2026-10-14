"""Per-file rights of staged inputs and the conservative rights of build outputs.

Rights are advisory provenance, never a gate: any mix of per-file rights is accepted and
recorded. An output inherits the most restrictive rights among the inputs that produced it
when that is determinable, and ``unknown`` otherwise. Which inputs produced an output is
not known to the platform, so every staged input is treated as a contributor.
"""

UNKNOWN = "unknown"
# Markers that dominate any other declared rights. Free-text rights have no other total order.
RESTRICTIVE = ("proprietary", "all-rights-reserved", "confidential")


def staged_input_record(files) -> list[dict]:
    """Exact per-file record retained with a build: path, hash, size, type and rights."""
    return [
        {
            "path": f.path,
            "sha256": f.blob.sha256,
            "bytes": f.blob.size,
            "media_type": f.media_type,
            "rights": f.rights,
        }
        for f in sorted(files, key=lambda f: f.path)
    ]


def derive_output_rights(rights) -> tuple[str, str]:
    """Return ``(rights, basis)`` for outputs produced from inputs with these rights."""
    values = {(r or "").strip() for r in rights}
    if not values or "" in values or any(v.lower() == UNKNOWN for v in values):
        return UNKNOWN, "unknown"
    if len(values) == 1:
        return next(iter(values)), "uniform"
    restricted = {v for v in values if v.lower() in RESTRICTIVE}
    if len(restricted) == 1:
        return next(iter(restricted)), "most_restrictive"
    return UNKNOWN, "unknown"


def derive_for_record(staged_inputs) -> tuple[str, str]:
    if not staged_inputs:
        return UNKNOWN, "unknown"
    return derive_output_rights(e["rights"] for e in staged_inputs)


def derive_for_revision(revision) -> str:
    return derive_output_rights(revision.files.values_list("rights", flat=True))[0]
