"""Full current source authority precedes discrepancy and correspondence diagnostics."""

import hashlib
import json
from contextvars import ContextVar

from pydantic import ValidationError

from specmate.access.permissions import Perm, authorize
from specmate.design.models import Revision
from specmate.design.operations import authorize_snapshot, canonical_bytes
from specmate.operations import NotFound, ValidationFailed
from specmate.pcb.models import PcbInterpretation
from specmate.pcb.report import Report
from specmate.pcb_disagreement.contracts import (
    KINDS,
    VALUE_ADAPTER,
    Assertion,
    AssertionInput,
    Comparison,
    NativeInput,
)
from specmate.sources.models import SourceBundleFile

_AUTHORIZING = ContextVar("pcb_disagreement_authorizing", default=frozenset())


def parse_content(content, kind=None):
    keys = KINDS.intersection(content)
    if not keys and kind not in KINDS:
        return None
    if len(keys) != 1 or set(content) != keys:
        raise ValidationFailed("PCB source review requires one typed content record.")
    key = next(iter(keys))
    if kind is not None and kind != key:
        raise ValidationFailed("PCB source review content must match its definition kind.")
    try:
        value = VALUE_ADAPTER.validate_python(content[key])
    except ValidationError:
        raise ValidationFailed("Invalid PCB source review content.") from None
    if value.kind != key:
        raise ValidationFailed("PCB source review kind disagrees with its content key.")
    return value


def validate_content(kind, content):
    value = parse_content(content, kind)
    return {value.kind: value.model_dump(mode="json")} if value else content


def read_source(user, pin):
    from specmate.queries import get_bundle_revision

    get_bundle_revision(user, pin.source_revision_id)
    file = (
        SourceBundleFile.objects.select_related("revision__bundle", "blob")
        .filter(revision_id=pin.source_revision_id, path=pin.path)
        .first()
    )
    if file is None:
        raise NotFound("Source assertion file unavailable.")
    authorize(user, file.revision.bundle.workspace_id, Perm.WORKSPACE_READ)
    authorize(user, file.blob.workspace_id, Perm.WORKSPACE_READ)
    return file


def validate_source(pin, file):
    if (
        file.revision.manifest_sha256 != pin.manifest_sha256
        or file.blob.sha256 != pin.sha256
        or file.rights != pin.rights
    ):
        raise ValidationFailed(
            "Source assertion pin differs from preserved hash, manifest or rights."
        )


def unique(values, message):
    if len(values) != len(set(values)):
        raise ValidationFailed(message)


class Closure:
    def __init__(self, user, value):
        self.user, self.value = user, value
        self.revisions, self.inputs = {}, {}
        if isinstance(value, Assertion):
            self.file = read_source(user, value.source)
            validate_source(value.source, self.file)
            self.assertion(value)
            return
        if not isinstance(value, Comparison):
            return
        # Gather both source scopes and all typed references before hash, kind or net diagnostics.
        pending = {}
        for side in ("left", "right"):
            pin = getattr(value, side)
            if isinstance(pin, AssertionInput):
                revision = (
                    Revision.objects.select_related("definition", "snapshot")
                    .filter(id=pin.revision_id)
                    .first()
                )
                if revision is None:
                    raise NotFound("Source assertion revision unavailable.")
                authorize(user, revision.definition.workspace_id, Perm.WORKSPACE_READ)
                self.revisions[revision.id] = revision
                content = json.loads(bytes(revision.snapshot.canonical))["content"]
                assertion = parse_content(content, revision.definition.kind)
                file = (
                    read_source(user, assertion.source)
                    if isinstance(assertion, Assertion)
                    else None
                )
                pending[side] = (pin, revision, assertion, file)
            elif isinstance(pin, NativeInput):
                from specmate.pcb_disagreement.native_operations import scoped_interpretation

                interpretation = scoped_interpretation(user, pin.interpretation_id)
                file = read_source(user, pin.source)
                pending[side] = (pin, interpretation, file, interpretation.attempt.source_file)
            else:
                interpretation = (
                    PcbInterpretation.objects.select_related(
                        "attempt__intake__source_revision__bundle", "output__stage__build"
                    )
                    .filter(id=pin.interpretation_id)
                    .first()
                )
                if interpretation is None:
                    raise NotFound("PCB source interpretation unavailable.")
                source = interpretation.attempt.intake.source_revision
                authorize(user, source.bundle.workspace_id, Perm.WORKSPACE_READ)
                file = read_source(user, pin.source)
                # Include the owning file even when the supplied pin differs.
                original = (
                    SourceBundleFile.objects.select_related("revision__bundle", "blob")
                    .filter(revision=source, path=interpretation.attempt.intake.board_path)
                    .first()
                )
                if original is None:
                    raise NotFound("PCB source interpretation unavailable.")
                authorize(user, original.blob.workspace_id, Perm.WORKSPACE_READ)
                pending[side] = (pin, interpretation, file, original)
        for revision in self.revisions.values():
            active = _AUTHORIZING.get()
            if revision.snapshot_id in active or len(active) >= 32:
                raise ValidationFailed("Source review reference cycle or nesting limit.")
            token = _AUTHORIZING.set(active | {revision.snapshot_id})
            try:
                authorize_snapshot(user, revision.snapshot)
            finally:
                _AUTHORIZING.reset(token)
        for side, record in pending.items():
            pin, owner, item, file = record
            if isinstance(pin, AssertionInput):
                if not isinstance(item, Assertion) or owner.snapshot.sha256 != pin.snapshot_sha256:
                    raise ValidationFailed("Comparison requires an exact human assertion revision.")
                validate_source(item.source, file)
                self.inputs[side] = self.assertion(item)
                self.inputs[side]["revision_id"] = str(owner.id)
                self.inputs[side]["snapshot_sha256"] = owner.snapshot.sha256
            elif isinstance(pin, NativeInput):
                from specmate.pcb_disagreement.native_operations import project_interpretation

                validate_source(pin.source, item)
                if item.id != file.id or owner.sha256 != pin.report_sha256:
                    raise ValidationFailed("Source net input differs from exact accepted evidence.")
                self.inputs[side] = project_interpretation(owner)
            else:
                validate_source(pin.source, item)
                if (
                    item.id != file.id
                    or owner.sha256 != pin.report_sha256
                    or hashlib.sha256(bytes(owner.canonical)).hexdigest() != owner.sha256
                ):
                    raise ValidationFailed(
                        "Comparison report differs from exact accepted PCB evidence."
                    )
                report = Report.model_validate_json(bytes(owner.canonical))
                if report.source_sha256 != pin.source.sha256:
                    raise ValidationFailed("PCB report does not belong to the preserved source.")
                if len(report.pads) > 2000:
                    raise ValidationFailed(
                        "Source comparison supports at most 2000 terminals per input."
                    )
                components = {str(c.id): c for c in report.components}
                self.inputs[side] = {
                    "method": "accepted_board_extraction",
                    "source_role": "pcb",
                    "property_owner": "preserved_source",
                    "source": pin.source.model_dump(mode="json"),
                    "coverage": "board_pad_inventory",
                    "coverage_basis": (
                        "Accepted native board pad inventory; "
                        "net membership is not routed connectivity."
                    ),
                    "extractor": {
                        "adapter": report.adapter,
                        "tool_version": report.tool_version,
                        "interpretation_id": str(owner.id),
                        "report_sha256": owner.sha256,
                        "build_id": str(owner.attempt.build_id),
                        "output_id": str(owner.output_id),
                    },
                    "terminals": [
                        {
                            "local_id": str(p.id),
                            "component_ref": components[str(p.component_id)].reference,
                            "pin": p.number,
                            "native_component_id": str(p.component_id),
                            "native_terminal_id": str(p.id),
                            "net_state": "assigned" if p.net else "unknown",
                            "net_name": p.net or None,
                            "basis": "Native reported pad net membership",
                        }
                        for p in report.pads
                        if p.type != "npth"
                    ],
                    "unsupported": report.unsupported,
                }
        self.findings = compare(value, self.inputs)

    @staticmethod
    def assertion(value):
        unique([t.local_id for t in value.terminals], "Assertion terminal IDs must be unique.")
        return {
            **value.model_dump(mode="json"),
            "extractor": None,
            "unsupported": [
                "Human assertions are not native extraction or automatic schematic parity.",
                "Native IDs entered by a human remain assertions; label equality is not identity.",
            ],
        }


def compare(value, inputs):
    unique([c.local_id for c in value.correspondences], "Correspondence IDs must be unique.")
    by_side = {
        side: {t["local_id"]: t for t in record["terminals"]} for side, record in inputs.items()
    }
    for side in ("left", "right"):
        selected = [
            getattr(c, f"{side}_terminal_id")
            for c in value.correspondences
            if getattr(c, f"{side}_terminal_id") is not None
        ]
        unique(selected, "Each exact terminal can participate in only one correspondence.")
        if set(selected) - set(by_side[side]):
            raise ValidationFailed("Correspondence terminal is absent from its exact source input.")
    salt = {
        "left": value.left.model_dump(mode="json"),
        "right": value.right.model_dump(mode="json"),
        "correspondences": [c.model_dump(mode="json") for c in value.correspondences],
    }
    fingerprint = hashlib.sha256(canonical_bytes(salt)).hexdigest()
    findings = {}
    remaining_references = 20000

    def finding(kind, anchors, left, right, explanation):
        nonlocal remaining_references
        references = len(anchors) + sum(
            len(record["members"]) if "members" in record else 1
            for record in (left, right)
            if record is not None
        )
        if references > remaining_references:
            raise ValidationFailed(
                "Comparison exceeds the 20000 finding-detail reference bound; "
                "reduce the explicitly compared subset. No partial conclusion was retained."
            )
        remaining_references -= references
        detail = {
            "kind": kind,
            "correspondence_ids": sorted(anchors),
            "left": left,
            "right": right,
            "explanation": explanation,
        }
        fid = (
            "finding-"
            + hashlib.sha256(
                canonical_bytes({"inputs": fingerprint, "finding": detail})
            ).hexdigest()
        )
        findings[fid] = {"finding_id": fid, **detail, "review": None}

    known = []
    for pair in value.correspondences:
        left = by_side["left"].get(pair.left_terminal_id)
        right = by_side["right"].get(pair.right_terminal_id)
        if left is None or right is None:
            absent_side = "left" if left is None else "right"
            complete = inputs[absent_side]["coverage"] in {
                "declared_complete",
                "board_pad_inventory",
            }
            finding(
                "declared_missing_terminal" if complete else "unknown_missing_coverage",
                [pair.local_id],
                left,
                right,
                "A counterpart is explicitly declared absent; completeness is "
                + ("declared for this input." if complete else "unknown or partial."),
            )
        elif left["net_state"] == "unknown" or right["net_state"] == "unknown":
            finding(
                "unknown_net_assignment",
                [pair.local_id],
                left,
                right,
                "Unknown assignment cannot agree or disagree with a known net.",
            )
        else:
            known.append((pair.local_id, left, right))
            if left["net_state"] != right["net_state"]:
                finding(
                    "assignment_difference",
                    [pair.local_id],
                    left,
                    right,
                    "The inputs disagree on assigned versus explicitly unconnected state.",
                )
            elif left["net_name"] != right["net_name"]:
                finding(
                    "net_name_difference",
                    [pair.local_id],
                    left,
                    right,
                    "Different net names are reported independently of membership differences.",
                )
    groups = {"left": {}, "right": {}}
    for pair_id, left, right in known:
        for side, terminal in (("left", left), ("right", right)):
            key = (
                terminal["net_state"],
                terminal["net_name"] if terminal["net_state"] == "assigned" else pair_id,
            )
            groups[side].setdefault(key, []).append(pair_id)
    member_sets = {"left": {}, "right": {}}
    for side, collection in groups.items():
        for members in collection.values():
            ordered = tuple(sorted(members))
            for member in members:
                member_sets[side][member] = ordered
    seen_groups = set()
    for pair_id, _, _ in known:
        left, right = member_sets["left"][pair_id], member_sets["right"][pair_id]
        if left != right and (left, right) not in seen_groups:
            seen_groups.add((left, right))
            finding(
                "net_membership_difference",
                set(left + right),
                {"members": list(left)},
                {"members": list(right)},
                "The same explicitly matched terminals have different net grouping.",
            )
    for side in ("left", "right"):
        selected = {getattr(c, f"{side}_terminal_id") for c in value.correspondences}
        for tid, terminal in by_side[side].items():
            if tid not in selected:
                finding(
                    "unmapped_terminal",
                    [],
                    terminal if side == "left" else None,
                    terminal if side == "right" else None,
                    "No explicit correspondence is recorded; "
                    "matching reference labels do not establish identity.",
                )
    unique([r.finding_id for r in value.reviews], "A finding has at most one review decision.")
    if {r.finding_id for r in value.reviews} - findings.keys():
        raise ValidationFailed(
            "Review targets a stale or absent finding; review the exact current comparison."
        )
    for review in value.reviews:
        findings[review.finding_id]["review"] = review.model_dump(mode="json")
    return sorted(findings.values(), key=lambda f: f["finding_id"])


def authorize_value(user, value):
    return Closure(user, value)


def dependency_revisions(user, definition, content):
    value = parse_content(content, definition.kind)
    return sorted(Closure(user, value).revisions, key=str) if value else []


def projection(user, definition, content):
    value = parse_content(content, definition.kind)
    if value is None:
        raise ValidationFailed("PCB source review content is required.")
    closure = Closure(user, value)
    if isinstance(value, Assertion):
        return {
            "assertion": closure.assertion(value),
            "parity": "not_evaluated",
            "physical_qualification": "not_evaluated",
        }
    return {
        "inputs": closure.inputs,
        "correspondences": [c.model_dump(mode="json") for c in value.correspondences],
        "findings": closure.findings,
        "comparison_status": "findings_present"
        if closure.findings
        else "no_difference_in_compared_subset",
        "parity": "not_evaluated",
        "physical_qualification": "not_evaluated",
        "limitations": [
            "Review never chooses a correct source or mutates preserved source assertions.",
            "Comparison is limited to explicit terminal correspondence "
            "and declared input coverage.",
        ],
    }


def inspect_revision(user, revision_id):
    revision = (
        Revision.objects.select_related("definition", "snapshot").filter(id=revision_id).first()
    )
    if revision is None:
        raise NotFound("PCB source review unavailable.")
    authorize_snapshot(user, revision.snapshot)
    content = json.loads(bytes(revision.snapshot.canonical))["content"]
    return {
        "revision_id": str(revision.id),
        "definition_id": str(revision.definition_id),
        "snapshot_id": str(revision.snapshot_id),
        "sha256": revision.snapshot.sha256,
        "content": content,
        "projection": projection(user, revision.definition, content),
    }


def source_files(user, revision_id):
    from specmate.queries import get_bundle_revision

    revision = get_bundle_revision(user, revision_id)
    files = list(revision.files.select_related("blob"))
    for file in files:
        authorize(user, file.blob.workspace_id, Perm.WORKSPACE_READ)
    return {
        "source_revision_id": str(revision.id),
        "manifest_sha256": revision.manifest_sha256,
        "files": [
            {
                "source_revision_id": str(revision.id),
                "manifest_sha256": revision.manifest_sha256,
                "path": file.path,
                "sha256": file.blob.sha256,
                "rights": file.rights,
            }
            for file in files
        ],
        "coverage": "preserved_unparsed",
    }
