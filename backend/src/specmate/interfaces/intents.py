"""Cable intent: validation, deterministic row proposal and labelled inspection.

The proposal pairs the two ends' pins by exact signal identity only. Anything else is an
explicit question (several destination pins, a name-and-type look-alike from another
signal set, a pin whose meaning depends on an unselected condition) or an unpaired row
with its reason. Supplies the destination does not declare become must-not-connect rows.
Conductor and part requirements are carried only from declared port facts.

Checking a cable against an intent and wiring a cable from it are later steps; the
inspection reports them as ``not_evaluated`` (see ``check_hook``).
"""

import re

from specmate.interfaces.intent_contracts import CableIntent, IntentRow
from specmate.operations import ValidationFailed

RETURN_LIKE = {"ground_return", "chassis", "shield"}
COAX_TYPES = {"analog_video", "sync"}


def intent_references(intent: CableIntent):
    refs = [intent.from_revision_id, intent.to_revision_id]
    refs += [r.signal_ref.signal_set_revision_id for r in intent.rows if r.signal_ref]
    return list(dict.fromkeys(refs))


def end_view(closure, revision_id):
    """One end's per-contact expectations: a device port or a bare pinout variant."""
    from specmate.interfaces.contracts import Pinout, Port
    from specmate.interfaces.queries import end_rows

    value = closure.values.get(revision_id)
    if not isinstance(value, (Port, Pinout)):
        raise ValidationFailed("An intent end is a device port or a pinout variant revision.")
    revision = closure.revisions[revision_id]
    view = end_rows(value, revision, closure)
    view["name"] = revision.definition.name
    view["revision_number"] = revision.number
    return view


def contact_text(row):
    number = row["number"] or row["contact_id"]
    signal = (row.get("signal") or {}).get("name")
    return f"{number} · {signal}" if signal else number


def validate_intent(closure, intent: CableIntent):
    source = {r["contact_id"]: r for r in end_view(closure, intent.from_revision_id)["rows"]}
    target = {r["contact_id"]: r for r in end_view(closure, intent.to_revision_id)["rows"]}
    for row in intent.rows:
        if row.from_contact_id is not None and row.from_contact_id not in source:
            raise ValidationFailed("A row's from-contact is not a contact of the from end.")
        if any(c not in target for c in row.to_contact_ids):
            raise ValidationFailed("A row's to-contact is not a contact of the to end.")
        if row.question and any(o.contact_id not in target for o in row.question.options):
            raise ValidationFailed("A question offers a contact the to end does not have.")
        if row.signal_ref is not None:
            closure.signal(row.signal_ref)
    return source, target


def require_answered(intent: CableIntent):
    """Freezing records a decided requirement: every question must be answered first."""
    if intent.open_questions:
        names = ", ".join(r.row_id for r in intent.open_questions[:5])
        raise ValidationFailed(f"Answer the open intent questions before freezing: {names}.")


# ---------------------------------------------------------------- proposal


def _key(signal):
    return (str(signal["signal_set_revision_id"]), signal["key"])


def _ref(signal):
    return {"signal_set_revision_id": str(signal["signal_set_revision_id"]), "key": signal["key"]}


def _known_impedance(row, end_name):
    impedance = ((row or {}).get("device") or {}).get("impedance") or {}
    if impedance.get("status") == "known" and impedance.get("nominal") is not None:
        return impedance["nominal"], f"{end_name} contact {row['number'] or row['contact_id']}"
    return None


def conductor_for(signal, source, targets, names):
    """Coax/pair with an impedance only when a port pin declares that impedance."""
    stated = [
        found
        for found in (
            _known_impedance(source, names[0]),
            *(_known_impedance(t, names[1]) for t in targets),
        )
        if found
    ]
    if not stated or not signal:
        return {"kind": "unknown", "impedance_ohm": None, "basis": None}
    values = {value for value, _ in stated}
    if len(values) > 1:
        return {"kind": "unknown", "impedance_ohm": None, "basis": None}
    kind = "coax" if signal["type"] in COAX_TYPES else "pair" if signal["type"] == "data" else None
    if kind is None:
        return {"kind": "unknown", "impedance_ohm": None, "basis": None}
    value = values.pop()
    where = "; ".join(text for _, text in stated)
    return {"kind": kind, "impedance_ohm": value, "basis": f"Declared {value:g} ohm at {where}"}


def parts_for(source, targets):
    parts = []
    for row, where in ((source, "from_end"), *((t, "to_end") for t in targets)):
        for need in ((row or {}).get("device") or {}).get("needs_in_cable", []):
            parts.append(
                {
                    "conditioning": need["conditioning"],
                    "value": need.get("value"),
                    "where": "anywhere",
                    "basis": f"{need['basis']} (declared at the "
                    f"{'from' if where == 'from_end' else 'to'} end)",
                }
            )
    return parts


def _row_id(prefix, contact, taken):
    base = f"{prefix}-{re.sub(r'[^a-z0-9_.-]', '-', contact.lower())}"[:70]
    candidate, n = base, 2
    while candidate in taken:
        candidate, n = f"{base}-{n}", n + 1
    taken.add(candidate)
    return candidate


def propose_rows(source_view, target_view):
    """Deterministic proposed rows; ambiguity is returned as questions, never chosen."""
    names = (source_view["name"], target_view["name"])
    targets = [r for r in target_view["rows"] if r["status"] == "declared" and r.get("signal")]
    by_signal = {}
    for row in targets:
        by_signal.setdefault(_key(row["signal"]), []).append(row)
    rows, taken, offered, unassigned = [], set(), set(), []

    def option(row):
        return {"contact_id": row["contact_id"], "label": contact_text(row)}

    def add(source, **fields):
        signal = fields.pop("signal", None)
        chosen = [t for t in targets if t["contact_id"] in fields.get("to_contact_ids", [])]
        row = {
            "row_id": _row_id(
                "from" if source else "to", (source or chosen[0])["contact_id"], taken
            ),
            "requirement": "required",
            "from_contact_id": source["contact_id"] if source else None,
            "to_contact_ids": [],
            "signal_ref": _ref(signal) if signal else None,
            "pairing": "declared",
            "return_policy": "unknown",
            "conductor": {"kind": "unknown", "impedance_ohm": None, "basis": None},
            "required_parts": parts_for(source, chosen),
            "question": None,
            "basis": None,
        }
        row.update(fields)
        if signal and row["requirement"] != "must_not_connect":
            if signal["type"] in RETURN_LIKE:
                row["return_policy"] = "not_applicable"
            row["conductor"] = conductor_for(signal, source, chosen, names)
            if row["conductor"]["kind"] == "coax":
                row["return_policy"] = "dedicated_screen"
        offered.update(row["to_contact_ids"])
        if row["question"]:
            offered.update(o["contact_id"] for o in row["question"]["options"])
        rows.append(row)

    for source in source_view["rows"]:
        device = source.get("device") or {}
        label = contact_text(source)
        if device.get("must_not_connect"):
            add(
                source,
                requirement="must_not_connect",
                basis=device["must_not_connect_reason"],
                signal=source.get("signal"),
            )
            continue
        if source["status"] != "declared" or not source.get("signal"):
            alternatives = source.get("alternatives") or []
            if not alternatives:
                unassigned.append({"contact_id": source["contact_id"], "label": label})
                continue
            keys = {_key(a["signal_ref"]) for a in alternatives if a.get("signal_ref")}
            options = [option(t) for t in targets if _key(t["signal"]) in keys]
            hazard = (
                " It may carry a supply: consider must-not-connect."
                if ("may_be_power" in source.get("hazards", []))
                else ""
            )
            add(
                source,
                question={
                    "kind": "conditional_pin",
                    "text": f"{names[0]} contact {label}: {source['reason']}{hazard}",
                    "options": options,
                },
            )
            continue
        signal = source["signal"]
        matches = by_signal.get(_key(signal), [])
        if len(matches) == 1:
            add(
                source,
                signal=signal,
                to_contact_ids=[matches[0]["contact_id"]],
                pairing="same_signal",
                basis=f"Same signal {signal['name']} ({signal['set_name']} "
                f"r{signal['set_revision_number']}) at both ends",
            )
        elif matches:
            add(
                source,
                signal=signal,
                question={
                    "kind": "several_destinations",
                    "text": f"{signal['name']} is declared on {len(matches)} contacts of "
                    f"{names[1]}; choose which this row must reach.",
                    "options": [option(t) for t in matches],
                },
            )
        else:
            alike = [
                t
                for t in targets
                if t["signal"]["type"] == signal["type"]
                and t["signal"]["name"].casefold() == signal["name"].casefold()
            ]
            if alike:
                add(
                    source,
                    signal=signal,
                    question={
                        "kind": "name_and_type_only",
                        "text": f"{signal['name']} matches only by name and type, from another "
                        "signal set; confirm the destination contact.",
                        "options": [option(t) for t in alike],
                    },
                )
            elif signal["type"] == "power":
                add(
                    source,
                    signal=signal,
                    requirement="must_not_connect",
                    basis=f"{names[1]} declares no contact accepting {signal['name']}.",
                )
            else:
                add(
                    source,
                    signal=signal,
                    requirement="optional",
                    pairing="unpaired",
                    basis=f"{names[1]} declares no contact carrying {signal['name']}.",
                )
    for target in targets:
        if target["contact_id"] in offered:
            continue
        add(
            None,
            signal=target["signal"],
            to_contact_ids=[target["contact_id"]],
            requirement="optional",
            pairing="unpaired",
            basis=f"{names[0]} declares no contact carrying {target['signal']['name']}.",
        )
    # Every proposed row must itself be a valid declaration.
    for row in rows:
        IntentRow.model_validate(row)
    return rows, unassigned


def propose(closure, from_id, to_id):
    source = end_view(closure, from_id)
    target = end_view(closure, to_id)
    rows, unassigned = propose_rows(source, target)
    return {
        "from": source,
        "to": target,
        "rows": rows,
        "open_questions": sum(1 for r in rows if r["question"]),
        "unassigned_from_contacts": unassigned,
        "status": "proposed",
        "review": "required",
    }


# ---------------------------------------------------------------- inspection


def check_hook():
    """Where checking a cable against this intent will report (phase 7)."""
    return {
        "status": "not_evaluated",
        "reason": "Checking a cable against this intent is not available yet.",
    }


def intent_view(closure, intent: CableIntent):
    source, target = validate_intent(closure, intent)
    from_view = end_view(closure, intent.from_revision_id)
    to_view = end_view(closure, intent.to_revision_id)
    rows = []
    for row in intent.rows:
        rows.append(
            {
                **row.model_dump(mode="json"),
                "from_label": contact_text(source[row.from_contact_id])
                if row.from_contact_id
                else None,
                "to_labels": [contact_text(target[c]) for c in row.to_contact_ids],
                "signal": closure.describe(row.signal_ref),
                "open": row.question is not None,
            }
        )
    return {
        "from": {k: v for k, v in from_view.items() if k != "rows"},
        "to": {k: v for k, v in to_view.items() if k != "rows"},
        "rows": rows,
        "open_questions": len(intent.open_questions),
        "check": check_hook(),
        "proposal": {
            "status": "not_evaluated",
            "reason": "Wiring a cable from this intent is not available yet.",
        },
    }
