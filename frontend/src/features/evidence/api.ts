import { command } from "../sources/api";
export { read } from "../identity/api";

export type EvidenceKind = "requirement" | "source_claim" | "calculation" | "generated_check" | "review" | "physical_measurement" | "physical_observation" | "preference";
export type EvidenceItem = {
  evidence_id: string; kind: EvidenceKind; kind_label: string; source: string; workspace_id: string;
  subject: { scope: "design" | "actual" | "project"; kind: string; id: string; label: string };
  statement: string; status: string; conditions: { property: string; status: string; value: unknown }[];
  method: { name: string; procedure?: string | null; instrument?: string | null; formula?: string | null; algorithm_version?: string | null; tool?: string | null };
  basis: { origin: string; references: string[]; independently_verified: boolean };
  recorded_at: string; observed_at?: string | null; actor_id?: number | null;
  establishes: string[]; does_not_establish: string[]; warnings: string[]; physical_qualification: false;
  /** Recorded results only: a pinned input has a newer revision. */
  stale?: boolean | null;
};
export type EvidenceList = { workspace_id: string; items: EvidenceItem[]; offset: number; limit: number; has_more: boolean; scan_limit_reached: boolean };
export type KindDescription = { kind: EvidenceKind; label: string; subject_scope: string; summary: string; establishes: string[]; does_not_establish: string[]; fact_methods: string[] };

export const KIND_ORDER: EvidenceKind[] = ["requirement", "source_claim", "calculation", "generated_check", "review", "physical_measurement", "physical_observation", "preference"];

export function evidenceQuery(workspaceId: string, kinds: EvidenceKind[], offset: number): string {
  const params = new URLSearchParams();
  kinds.forEach((kind) => params.append("kind", kind));
  params.set("offset", String(offset));
  params.set("limit", "50");
  return `evidence/workspaces/${workspaceId}?${params.toString()}`;
}

export type RecordedPin = { role: string; revision_id: string; definition_id: string; number: number; latest_number: number; newer_revision_exists: boolean };
export type RecordedResult = {
  record_id: string; workspace_id: string; source: "interface_assessment" | "firmware_impact"; kind: EvidenceKind; algorithm_version: string;
  request: Record<string, unknown>; result: Record<string, unknown>; result_sha256: string; note: string; recorded_at: string; recorded_by_id: number;
  pins: RecordedPin[]; stale: boolean; rewritten: false; physical_qualification: false;
};

export const recordedPath = (recordId: string) => `evidence/recorded/${recordId}`;

/** Explicitly record one exact frozen interface assessment result. Reading never records. */
export function recordInterfaceAssessment(revisionId: string, idempotencyKey: string): Promise<RecordedResult> {
  return command<RecordedResult>("evidence.record_interface_assessment", { revision_id: revisionId }, { idempotencyKey });
}

/** Record the firmware impact comparison that was shown; a changed comparison is a conflict. */
export function recordFirmwareImpact(comparison: object, comparisonSha256: string, idempotencyKey: string): Promise<RecordedResult> {
  return command<RecordedResult>("evidence.record_firmware_impact", { comparison, expected_comparison_sha256: comparisonSha256 }, { idempotencyKey });
}

/** "N–M of T" when a firmware record or comparison covers only part of its observations. */
export function observationRange(result: { observations: unknown[]; observations_total: number; observation_offset: number }): string | null {
  const shown = result.observations.length, total = result.observations_total;
  if (shown >= total) return null;
  const first = result.observation_offset + 1;
  return shown ? `${first}–${first + shown - 1} of ${total}` : `none of ${total}`;
}

export type TestCalibration = "unknown" | "calibrated" | "uncalibrated";
export type TestInstrument = { name: string; identifier?: string; calibration: TestCalibration; calibration_reference?: string };
export type TestCondition = { property: string; status: "known" | "unknown"; value?: { kind: "text"; text: string } };
export type SubjectTestInput = {
  subject: { kind: "physical_unit"; unit_id: string } | { kind: "work_batch"; work_batch_id: string; sample_size?: number };
  configuration_id?: string; test_kind: string; procedure: string; instruments: TestInstrument[]; conditions: TestCondition[];
  observed_at: string; criterion: string; finding: "criterion_met" | "criterion_not_met" | "inconclusive"; summary?: string;
};
export type SubjectTestRecord = { test_id: string; recorded_at: string; applies_to: "this_subject_only"; physical_qualification: false };

/** Record one immutable physical test of exactly one unit, or of one batch as a whole. */
export function recordSubjectTest(input: SubjectTestInput, idempotencyKey: string): Promise<SubjectTestRecord> {
  return command<SubjectTestRecord>("evidence.record_test", input, { idempotencyKey });
}
