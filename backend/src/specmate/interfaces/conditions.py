"""Bounded inclusive scope comparison, with no extrapolation or interpolation."""

PARTIAL_REASON = "Rating scope covers only part of the operating envelope"


def rating_scope(rating, operating):
    scope = rating.scope
    outside = []
    missing = []
    partial = []
    if scope.mode is not None:
        if operating.mode is None:
            missing.append("Named operating mode is unknown.")
        elif operating.mode != scope.mode:
            outside.append("Named operating mode differs from the declared scope.")
    if scope.temperature is not None:
        if operating.temperature is None:
            missing.append("Operating temperature envelope is unknown.")
        elif (
            operating.temperature.maximum_c < scope.temperature.minimum_c
            or scope.temperature.maximum_c < operating.temperature.minimum_c
        ):
            outside.append("Operating temperature envelope lies outside the declared scope.")
        elif not (
            scope.temperature.minimum_c <= operating.temperature.minimum_c
            and operating.temperature.maximum_c <= scope.temperature.maximum_c
        ):
            partial.append(PARTIAL_REASON + ".")
    if outside:
        return "out_of_scope", " ".join(outside + partial + missing)
    if partial or missing:
        return "unknown", " ".join(partial + missing)
    return "in_scope", "All declared scope conditions include the explicit operating envelope."


def resolve_limits(electrical, operating, dimension):
    """Applicable declarations intersect; unresolved conditional limits block comparison."""
    if electrical is None:
        return None, []
    records = []
    limits = []
    unresolved = False
    for rating in electrical.conditional_ratings:
        if rating.dimension != dimension:
            continue
        status, reason = rating_scope(rating, operating)
        records.append(
            {"rating": rating.model_dump(mode="json"), "status": status, "explanation": reason}
        )
        if status == "in_scope":
            limits.append((rating.minimum, rating.maximum))
        elif status == "unknown":
            unresolved = True
    legacy_scope = not electrical.condition or electrical.condition == operating.condition
    if dimension == "voltage":
        if (
            legacy_scope
            and electrical.voltage_min_v is not None
            and electrical.voltage_max_v is not None
        ):
            limits.append((electrical.voltage_min_v, electrical.voltage_max_v))
    elif legacy_scope and electrical.current_max_a is not None:
        limits.append((None, electrical.current_max_a))
    if unresolved or not limits:
        return None, records
    minimum = max(low for low, _ in limits) if dimension == "voltage" else None
    return (minimum, min(high for _, high in limits)), records
