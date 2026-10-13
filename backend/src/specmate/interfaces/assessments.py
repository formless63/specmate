"""Explain independent, narrowly scoped comparisons of retained declarations."""

from collections import Counter

from specmate.catalog_matching.contracts import EvidenceResult
from specmate.catalog_matching.operations import evidence_fields
from specmate.interfaces.assessment_contracts import AssessmentResult, Finding
from specmate.interfaces.contracts import Pinout
from specmate.operations import ValidationFailed


def evidence_inputs(value):
    yield from (
        value.mating.evidence,
        value.fit.evidence,
        value.shielding.evidence,
        value.grounding.evidence,
    )
    for pair in value.pairs:
        yield pair.evidence
        yield pair.operating.evidence


def authorize_evidence(user, value):
    resolved = {}
    for evidence in evidence_inputs(value):
        fields = evidence_fields(user, evidence)
        source = fields["source_file"]
        resolved[evidence.model_dump_json()] = EvidenceResult(
            status=evidence.status,
            citation=evidence.citation,
            source_bundle_revision_id=source.revision_id if source else None,
            source_path=source.path if source else None,
            sha256=source.blob.sha256 if source else None,
            rights=source.rights if source else None,
            media_type=source.media_type if source else None,
        )
    return resolved


def subjects(value, closure):
    pins = [
        closure.values.get(rid)
        for rid in (value.left_pinout_revision_id, value.right_pinout_revision_id)
    ]
    if not all(isinstance(p, Pinout) for p in pins):
        raise ValidationFailed("Assessment subjects require two exact pinout revisions.")
    return pins


def assess(value, closure):
    left, right = subjects(value, closure)
    bodies = [closure.body_for(p) for p in (left, right)]
    contacts = [{c.contact_id: c for c in b.contacts} for b in bodies]
    assignments = [{a.contact_id: a.electrical for a in p.assignments} for p in (left, right)]
    evidence = closure.assessment_evidence[id(value)]
    findings = []

    def finding(dimension, status, explanation, *, pair=None, facts=None, refs=(), declared=False):
        findings.append(
            Finding(
                dimension=dimension,
                pair_id=pair.local_id if pair else None,
                status=status,
                basis="declaration" if declared else "comparison_of_declarations",
                explanation=explanation,
                facts=facts or {},
                evidence=[evidence[e.model_dump_json()] for e in refs],
            )
        )

    for dimension in ("mating", "fit"):
        declaration = getattr(value, dimension)
        finding(
            dimension,
            declaration.status,
            "No declaration supplied."
            if declaration.status == "unknown"
            else "Explicit declared " + dimension + ": " + declaration.basis,
            declared=True,
            refs=[declaration.evidence],
            facts=declaration.model_dump(mode="json"),
        )

    counts = [
        Counter(getattr(p, field) for p in value.pairs)
        for field in ("left_contact_id", "right_contact_id")
    ]
    for pair in value.pairs:
        ids = [pair.left_contact_id, pair.right_contact_id]
        physical = [table.get(cid) for table, cid in zip(contacts, ids, strict=True)]
        electrical = [table.get(cid) for table, cid in zip(assignments, ids, strict=True)]
        facts = {
            "pair": pair.model_dump(mode="json"),
            "left": electrical[0].model_dump(mode="json") if electrical[0] else None,
            "right": electrical[1].model_dump(mode="json") if electrical[1] else None,
        }
        invalid = None
        if any(c is None or c.physical_role == "key" for c in physical):
            invalid = "A proposed contact is absent or is a key, which cannot carry a signal."
        elif any(count[cid] > 1 for count, cid in zip(counts, ids, strict=True)):
            invalid = "Proposed correspondence reuses a contact; it is not one-to-one."
        elif physical[0].physical_role != physical[1].physical_role:
            invalid = "Contact and shell roles differ in the proposed correspondence."
        elif pair.expected_signal and any(
            e and e.signal and e.signal != pair.expected_signal for e in electrical
        ):
            invalid = "A retained signal declaration contradicts the explicitly expected signal."
        if invalid:
            status, explanation = "invalid", invalid
        elif not pair.expected_signal or any(not e or not e.signal for e in electrical):
            status, explanation = "unknown", "Expected or retained signal identity is unknown."
        else:
            status, explanation = (
                "satisfied",
                "Distinct physical contacts carry the explicitly expected "
                "signal in both declarations.",
            )
        finding(
            "pin_correspondence", status, explanation, pair=pair, facts=facts, refs=[pair.evidence]
        )
        operating = pair.operating
        conditional = any(
            e and e.condition and e.condition != operating.condition for e in electrical
        )
        for dimension in ("levels", "current", "protocol"):
            result, reason = "unknown", "Required operating input or retained rating is unknown."
            if invalid:
                reason = (
                    "Invalid proposed correspondence prevents this row's electrical comparison."
                )
            elif conditional:
                reason = (
                    "A retained electrical condition is not the explicitly "
                    "selected operating condition."
                )
            elif dimension == "levels" and operating.voltage_min_v is not None:
                if all(
                    e and e.voltage_min_v is not None and e.voltage_max_v is not None
                    for e in electrical
                ):
                    within = all(
                        e.voltage_min_v <= operating.voltage_min_v
                        and operating.voltage_max_v <= e.voltage_max_v
                        for e in electrical
                    )
                    result = "satisfied" if within else "invalid"
                    reason = (
                        "Declared operating voltage envelope "
                        + ("is within" if within else "exceeds")
                        + " the retained limits at both contacts; signal thresholds "
                        "are not evaluated."
                    )
            elif dimension == "current" and operating.demand_a is not None:
                if all(e and e.current_max_a is not None for e in electrical):
                    within = all(operating.demand_a <= e.current_max_a for e in electrical)
                    result = "satisfied" if within else "invalid"
                    reason = (
                        "Explicit current demand "
                        + ("is within" if within else "exceeds")
                        + " the retained contact maxima; supply capability, heating "
                        "and derating are not evaluated."
                    )
            elif dimension == "protocol" and operating.required_protocol is not None:
                if all(e and e.protocol for e in electrical):
                    same = all(e.protocol == operating.required_protocol for e in electrical)
                    result = "satisfied" if same else "invalid"
                    reason = (
                        "Required protocol name "
                        + ("matches" if same else "contradicts")
                        + " both declarations; timing, negotiation and "
                        "interoperability are not evaluated."
                    )
            finding(
                dimension,
                result,
                reason,
                pair=pair,
                facts=facts,
                refs=[pair.evidence, operating.evidence],
            )
    if not value.pairs:
        for dimension in ("pin_correspondence", "levels", "current", "protocol"):
            finding(dimension, "unknown", "No explicit contact correspondence rows were supplied.")
    for dimension in ("shielding", "grounding"):
        intent = getattr(value, dimension)
        ids = [intent.left_contact_id, intent.right_contact_id]
        physical = [table.get(cid) for table, cid in zip(contacts, ids, strict=True)]
        electrical = [table.get(cid) for table, cid in zip(assignments, ids, strict=True)]
        status, reason = "unknown", "Required or declared bond/isolation intent is unknown."
        if all(ids):
            if any(c is None or c.physical_role == "key" for c in physical):
                status, reason = "invalid", "Bond/isolation intent names an absent contact or key."
            elif any(
                e
                and e.role != "unknown"
                and e.role
                not in (
                    {"shield", "chassis"} if dimension == "shielding" else {"return", "chassis"}
                )
                for e in electrical
            ):
                status, reason = (
                    "invalid",
                    "A retained electrical role contradicts this bond/isolation intent.",
                )
            elif dimension == "shielding" and any(
                c.physical_role != "shell" and (not e or e.role != "shield")
                for c, e in zip(physical, electrical, strict=True)
            ):
                reason = "Shield or shell role is not declared at both selected contacts."
            elif dimension == "grounding" and any(
                not e or e.role not in {"return", "chassis"} for e in electrical
            ):
                reason = "Return or chassis role is not declared at both selected contacts."
            elif intent.required != "unknown" and intent.declared != "unknown":
                same = intent.required == intent.declared
                status = "satisfied" if same else "invalid"
                reason = (
                    "Required and declared "
                    + dimension
                    + " intents "
                    + ("agree" if same else "conflict")
                    + "; no electrical bond, impedance or safety ground is established."
                )
        finding(
            dimension, status, reason, facts=intent.model_dump(mode="json"), refs=[intent.evidence]
        )
    return AssessmentResult(
        left_pinout_revision_id=value.left_pinout_revision_id,
        right_pinout_revision_id=value.right_pinout_revision_id,
        findings=findings,
        limitations=[
            "Results apply only to the exact pinout pair, proposed "
            "contact rows and explicit operating inputs.",
            "Mating and fit are declarations, not measured clearance, "
            "assembly success or physical qualification.",
            "Unknown ratings, conditions and omitted contacts remain "
            "unresolved; there is no overall compatibility result.",
            "No topology bond, signal transfer, driver/receiver logic, "
            "thermal rating or protocol interoperability is inferred.",
        ],
    ).model_dump(mode="json")
