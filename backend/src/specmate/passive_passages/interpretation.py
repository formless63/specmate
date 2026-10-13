"""Bounded declared-model paths; no extraction, topology or arithmetic is measurement."""

from decimal import Decimal, DecimalException, Inexact, Rounded, localcontext

from specmate.passive_passages.contracts import ELECTRICAL_CONTEXT, validate_assignments

MAX_EXPANSIONS = 20000
PI_APPROXIMATION = Decimal("3.1415926535897932384626433832795028841971693993751")


def enumerate_paths(graph, passages, start, end, max_paths, max_hops):
    records = {}
    incident = {node["id"]: [] for node in graph["nodes"]}
    for edge in graph["edges"]:
        records[edge["id"]] = {**edge, "record_type": "copper"}
        for node in edge["members"]:
            incident[node].append(edge["id"])
    for passage in passages:
        record_id = f"passage:{passage['local_id']}"
        records[record_id] = {
            **passage,
            "record_type": "passage",
            "id": record_id,
            "members": [passage["from_terminal_id"], passage["to_terminal_id"]],
        }
        for node in records[record_id]["members"]:
            incident[node].append(record_id)
    for links in incident.values():
        links.sort()
    # Iterative DFS avoids recursion and keeps hyperedges out of an O(n²) adjacency table.
    stack = [(start, (start,), ())]
    found, expansions, limited = [], 0, False
    while stack:
        node, terminals, links = stack.pop()
        if node == end:
            found.append((terminals, links))
            if len(found) > max_paths:
                limited = True
                break
            continue
        options = []
        for link in incident[node]:
            if link in links:
                continue
            for other in records[link]["members"]:
                expansions += 1
                if expansions > MAX_EXPANSIONS:
                    limited = True
                    break
                if other not in terminals:
                    options.append((other, link))
            if expansions > MAX_EXPANSIONS:
                break
        if expansions > MAX_EXPANSIONS:
            break
        if len(links) >= max_hops:
            if options:
                limited = True
            continue
        for other, link in reversed(sorted(options)):
            stack.append((other, (*terminals, other), (*links, link)))
        if len(stack) > MAX_EXPANSIONS:
            limited = True
            break
    return found[:max_paths], records, limited


def evaluate_path(terminals, links, records, query):
    steps, reasons, blocked = [], [], False
    assignments = {a.condition_id: a.state for a in query.condition_assignments}
    requirements = {}
    for link in links:
        contact = records[link].get("conditional_contact")
        if contact:
            requirements.setdefault(contact["condition_id"], set()).add(contact["state"])
    conflicts = sorted(key for key, states in requirements.items() if len(states) > 1)
    if conflicts:
        reasons.append("mutually_exclusive_condition_states")
    real, imaginary = Decimal(0), Decimal(0)
    approximate = False
    for index, link in enumerate(links):
        record = records[link]
        step = {
            "record_id": link,
            "kind": record["kind"],
            "from_terminal_id": terminals[index],
            "to_terminal_id": terminals[index + 1],
            "basis": record["basis"],
            "provenance": record.get("provenance"),
            "status": "not_evaluated",
        }
        if record["record_type"] == "copper":
            step["evidence"] = record["evidence"]
            if query.copper_assumption != "ideal_zero_resistance":
                reasons.append("copper_resistance_and_continuity_assumption_unspecified")
                step["status"] = "unknown"
            else:
                step["status"] = "idealized_connection"
        else:
            kind = record["kind"]
            step["evidence"] = record["evidence"]
            step["condition"] = record.get("condition")
            step["direction"] = (
                "forward" if record["from_terminal_id"] == terminals[index] else "reverse"
            )
            contact = record.get("conditional_contact")
            if contact:
                selected = assignments.get(contact["condition_id"])
                step["condition_requirement"] = contact
                step["assigned_state"] = selected
            if record.get("condition") or kind in {
                "diode",
                "inductor",
                "transformer",
                "active",
                "unknown",
            }:
                reasons.append("operating_condition_or_supported_behavior_model_required")
                step["status"] = "unknown"
            elif kind == "conditional":
                if not contact:
                    reasons.append("typed_conditional_contact_model_required")
                    step["status"] = "unknown"
                elif contact["condition_id"] in conflicts:
                    step["status"] = "incompatible_condition_requirements"
                elif selected is None:
                    reasons.append("condition_assignment_required")
                    step["status"] = "unknown"
                elif selected != contact["state"]:
                    blocked = True
                    step["status"] = "ideal_contact_open_under_assignment"
                else:
                    step["status"] = "ideal_contact_closed_under_assignment"
            elif kind == "resistor":
                resistance = record["resistance_ohm"]
                if resistance is None:
                    reasons.append("resistance_ohm_unknown")
                    step["status"] = "unknown"
                else:
                    try:
                        with localcontext(ELECTRICAL_CONTEXT) as context:
                            context.traps[Inexact] = True
                            context.traps[Rounded] = True
                            real += Decimal(resistance)
                        step["status"] = (
                            "ideal_zero_ohm_passage" if Decimal(resistance) == 0 else "resistive"
                        )
                        step["resistance_ohm"] = resistance
                    except DecimalException:
                        reasons.append("resistance_arithmetic_exceeds_exact_bounds")
                        step["status"] = "unknown"
            elif kind == "capacitor":
                if query.query != "signal":
                    blocked = True
                    step["status"] = "ideal_steady_state_dc_block"
                elif record["capacitance_f"] is None or query.frequency_hz is None:
                    reasons.append("positive_frequency_and_capacitance_required")
                    step["status"] = "unknown"
                else:
                    try:
                        with localcontext(ELECTRICAL_CONTEXT):
                            imaginary -= 1 / (
                                2
                                * PI_APPROXIMATION
                                * query.frequency_hz
                                * Decimal(record["capacitance_f"])
                            )
                        approximate = True
                        step["status"] = "ideal_capacitive_impedance_approximation"
                        step["capacitance_f"] = record["capacitance_f"]
                    except DecimalException:
                        reasons.append("impedance_arithmetic_exceeds_supported_bounds")
                        step["status"] = "unknown"
        steps.append(step)
    # Unsupported/conditional behavior outranks a local capacitor block: it cannot
    # become an open-circuit proof for a broader unknown active circuit model.
    status = "unknown" if reasons else "modeled_blocked" if blocked else "modeled_path"
    return {
        "terminal_ids": list(terminals),
        "steps": steps,
        "status": status,
        "reasons": sorted(set(reasons)),
        "condition_requirements": [
            {"condition_id": key, "states": sorted(states)}
            for key, states in sorted(requirements.items())
        ],
        "conflicting_condition_ids": conflicts,
        "series_resistance_ohm": str(real) if not reasons and not blocked else None,
        "series_impedance_ohm": {
            "real": str(real),
            "imaginary": str(imaginary),
            "precision": "derived_approximation"
            if approximate
            else "exact_declared_model_arithmetic",
        }
        if query.query == "signal" and not reasons and not blocked
        else None,
        "shortness": "not_evaluated"
        if reasons or query.query == "signal"
        else "blocked"
        if blocked
        else "ideal_zero_resistance_path"
        if real == 0
        else "resistive_not_ideal_short",
    }


def interpret(graph, model, query):
    validate_assignments(model, query)
    candidates, records, limited = enumerate_paths(
        graph,
        model["passages"],
        query.from_terminal_id,
        query.to_terminal_id,
        query.max_paths,
        query.max_hops,
    )
    paths = [evaluate_path(terminals, links, records, query) for terminals, links in candidates]
    modeled = [p for p in paths if p["status"] == "modeled_path"]
    unknown = [p for p in paths if p["status"] == "unknown"]
    status, reason = "unknown", "no_modeled_path_is_not_physical_disconnection"
    value = None
    if limited:
        reason = "path_or_expansion_bound_reached"
    elif query.query == "resistance" and len(paths) > 1:
        reason = "multiple_paths_require_network_solver"
    elif modeled:
        if query.query == "shortness":
            if any(p["shortness"] == "ideal_zero_resistance_path" for p in modeled):
                status, reason = "modeled_ideal_short", "explicit_ideal_model_only"
            elif not unknown:
                status, reason = (
                    "modeled_no_ideal_short",
                    "declared_model_paths_are_resistive_or_blocked",
                )
            else:
                reason = "unknown_alternative_path_behavior"
        elif query.query == "resistance":
            status, reason, value = (
                "modeled_series_resistance",
                "single_declared_model_path_only",
                modeled[0]["series_resistance_ohm"],
            )
        elif query.query == "dc_continuity":
            status, reason = (
                "modeled_dc_path",
                "resistive_or_ideal_connection_not_physical_continuity",
            )
        else:
            status, reason = (
                "modeled_signal_candidate",
                "series_impedance_does_not_establish_signal_transfer",
            )
    elif paths and not unknown:
        status = "modeled_blocked"
        reason = (
            "declared_ideal_contact_open_under_assignment"
            if any(
                step["status"] == "ideal_contact_open_under_assignment"
                for path in paths
                for step in path["steps"]
            )
            else "ideal_capacitor_steady_state_dc_only"
        )
    elif unknown:
        reason = "missing_parameters_or_unsupported_behavior"
    return {
        "query": query.query,
        "status": status,
        "reason": reason,
        "series_resistance_ohm": value,
        "paths": paths,
        "limited": limited,
        "assumptions": {
            "component_model": model["assumptions"],
            "model_basis": model["model_basis"],
            "copper": query.copper_assumption,
            "frequency_hz": str(query.frequency_hz) if query.frequency_hz is not None else None,
            "condition_assignments": [
                a.model_dump(mode="json") for a in query.condition_assignments
            ],
            "conditional_contacts": "ideal_zero_resistance_when_assigned_state_matches",
        },
        "unmodeled_boundaries": graph["boundaries"],
        "physical_continuity": "not_evaluated",
        "signal_transfer": "not_evaluated",
        "compatibility": "not_evaluated",
        "physical_qualification": "not_evaluated",
    }
