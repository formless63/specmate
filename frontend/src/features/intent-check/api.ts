import type { ResolvedSignal } from "../interfaces/api";
export { read } from "../identity/api";

export type Status = "pass" | "fail" | "unknown" | "not_evaluated" | "flagged";
export type Dimension = { status: Status; reason: string; evidence: string[] };
export const DIMENSIONS = ["connection", "signal_match", "conductor", "level", "required_parts", "return", "isolation", "shield", "convention", "mating"] as const;
export type DimensionName = typeof DIMENSIONS[number];
export const DIMENSION_LABELS: Record<DimensionName, string> = {
  connection: "Connection", signal_match: "Signal", conductor: "Conductor", level: "Level", required_parts: "Parts",
  return: "Return", isolation: "Isolation", shield: "Shield", convention: "Convention", mating: "Mating",
};
export type Chip = { kind: string; label: string; status?: "declared" | "unknown" | Status };
export type CheckRow = {
  row_id: string; requirement: "required" | "optional" | "must_not_connect"; from_label: string | null; to_labels: string[];
  signal: ResolvedSignal | null; outcome: Status; dimensions: Record<DimensionName, Dimension>; path: Chip[]; reached: string[]; note?: string;
};
export type IntentCheck = {
  algorithm_version: string; cable_revision_id: string | null; draft_id: string | null; intent_revision_id: string; intent_name: string; intent_number: number;
  ends: Record<"from" | "to", { endpoint_id: string; label: string; intent_end: string; mating: Dimension }>;
  rows: CheckRow[]; cable: { isolation: Dimension; shield: Dimension }; counts: Partial<Record<Status, number>>;
  continuity: "not_evaluated"; physical_qualification: "not_evaluated";
};

export function checkPath(target: { revisionId?: string | null; draftId?: string | null }, intentRevisionId?: string | null): string {
  const query = intentRevisionId ? `?intent_revision_id=${encodeURIComponent(intentRevisionId)}` : "";
  return target.revisionId ? `cables/revisions/${target.revisionId}/intent-check${query}` : `cables/drafts/${target.draftId}/intent-check${query}`;
}
