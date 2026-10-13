"""Declared prerequisites only: no geometry parsing, solver or qualification."""

from specmate.mechanical_sources.contracts import MechanicalSource


def assess(declaration: MechanicalSource):
    prerequisites = []

    def add(code, status, message, target=None, model=None, assumption=None):
        prerequisites.append(
            {
                "code": code,
                "status": status,
                "message": message,
                "scope": {"target_local_id": target, "model_local_id": model},
                "assumption_local_id": assumption,
            }
        )

    inputs = declaration.uncertainty
    for code, rows, identity in (
        ("material", inputs.materials, "specification"),
        ("process", inputs.processes, "method"),
    ):
        if not rows:
            add(code, "unknown", f"Item {code} assumptions and behavior are unassessed.")
        for row in rows:
            add(
                code,
                row.status,
                f"{code.capitalize()} {row.status.replace('_', ' ')}: "
                + (getattr(row, identity) or row.basis or "no assumption supplied"),
                row.target_local_id,
                assumption=row.local_id,
            )
            if row.status == "declared" and row.behavior is None:
                add(
                    code + "_behavior",
                    "unknown",
                    f"{code.capitalize()} behavior is unknown; no shrinkage, deformation "
                    "or process capability is inferred.",
                    row.target_local_id,
                    assumption=row.local_id,
                )
    if not inputs.tolerances:
        add("tolerance", "unknown", "No dimension/feature tolerance scope is assessed.")
    for row in inputs.tolerances:
        add(
            "tolerance",
            row.status,
            f"{row.dimension}: "
            + (
                f"declared deviation [{row.lower_deviation}, {row.upper_deviation}] mm"
                if row.status == "declared"
                else row.status.replace("_", " ")
            ),
            row.target_local_id,
            row.model_local_id,
            row.local_id,
        )
    if not declaration.targets:
        add(
            "connector_scope", "unknown", "No exact target or relevant connector scope is assessed."
        )
    for target in declaration.targets:
        rows = [r for r in inputs.connector_envelopes if r.target_local_id == target.local_id]
        if not rows:
            add(
                "connector_scope",
                "unknown",
                "Connector relevance and body/mated/installation/cable-route coverage are "
                "unassessed for this target; no connector identity is inferred.",
                target.local_id,
            )
        for row in rows:
            add(
                "connector_envelope",
                row.status,
                f"{row.usage} envelope: {row.status.replace('_', ' ')}. "
                "This scope does not cover other usage or operating configurations.",
                target.local_id,
                assumption=row.local_id,
            )
    files = {s.local_id: {f.path: f for f in s.files} for s in declaration.sources}
    geometry = []
    for model in declaration.models:
        file = files[model.source_local_id][model.path]
        reasons = []
        for field in ("units", "frame", "accuracy"):
            if getattr(model, field) is None:
                reasons.append(f"Model {field} is unknown.")
                add("model_" + field, "unknown", reasons[-1], model.target_local_id, model.local_id)
        if model.purpose == "illustration":
            reasons.append("Illustration geometry supplies no clearance or manufacturing geometry.")
            add(
                "geometry_purpose", "unsuitable", reasons[-1], model.target_local_id, model.local_id
            )
        elif model.purpose == "clearance":
            reasons.append("Clearance-purpose geometry supplies no manufacturing geometry.")
            add(
                "manufacturing_purpose",
                "unsuitable",
                reasons[-1],
                model.target_local_id,
                model.local_id,
            )
        if model.purpose == "manufacturing" and file.format not in {"step", "brep", "freecad"}:
            reasons.append(
                f"Declared {file.format} is not validated B-rep/manufacturing geometry; "
                "mesh or recipe validity cannot substitute for it."
            )
            add(
                "manufacturing_format",
                "unsuitable",
                reasons[-1],
                model.target_local_id,
                model.local_id,
            )
        relevant = [r for r in inputs.tolerances if r.model_local_id == model.local_id]
        if not relevant:
            reasons.append("No dimension/feature tolerance scope is assessed for this exact model.")
            add("model_tolerance", "unknown", reasons[-1], model.target_local_id, model.local_id)
        reasons.append("Native geometry and target/frame/feature correspondence are not validated.")
        add(
            "geometry_validation",
            "not_evaluated",
            reasons[-1],
            model.target_local_id,
            model.local_id,
        )
        geometry.append(
            {
                "local_id": model.local_id,
                "target_local_id": model.target_local_id,
                "purpose": model.purpose,
                "format": file.format,
                "representation_id": str(model.representation_id),
                "revision_id": str(model.revision_id),
                "snapshot_sha256": model.snapshot_sha256,
                "source_revision_id": str(
                    next(
                        s for s in declaration.sources if s.local_id == model.source_local_id
                    ).source_revision_id
                ),
                "path": model.path,
                "source_sha256": file.sha256,
                "rights": file.rights,
                "reasons": reasons,
            }
        )
    if not declaration.models:
        add("geometry", "unknown", "No purpose-specific geometry is pinned.")
    add(
        "qualification",
        "not_evaluated",
        "These are declared prerequisites with incomplete coverage, not a solver result. "
        "Native validation, tolerance interactions, connector operation and physical checks "
        "remain necessary even when every listed assumption is declared.",
    )
    return {
        "kind": "declared_prerequisites",
        "coverage": "explicit_scopes_only",
        "readiness": "missing_declared_inputs"
        if any(p["status"] in {"unknown", "unsuitable"} for p in prerequisites)
        else "declared_inputs_only",
        "assumptions": inputs.model_dump(mode="json"),
        "geometry": geometry,
        "prerequisites": prerequisites,
        "missing_prerequisites": [
            p for p in prerequisites if p["status"] in {"unknown", "unsuitable"}
        ],
        "fit": "not_evaluated",
        "clearance": "not_evaluated",
        "manufacturability": "not_evaluated",
        "physical_qualification": False,
    }
