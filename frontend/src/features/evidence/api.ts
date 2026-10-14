export { read } from "../identity/api";

export type EvidenceKind = "requirement" | "source_claim" | "calculation" | "generated_check" | "review" | "physical_measurement" | "physical_observation" | "preference";
export type EvidenceItem = {
  evidence_id: string; kind: EvidenceKind; kind_label: string; source: string; project_id: string;
  subject: { scope: "design" | "actual" | "project"; kind: string; id: string; label: string };
  statement: string; status: string; conditions: { property: string; status: string; value: unknown }[];
  method: { name: string; procedure?: string | null; instrument?: string | null; formula?: string | null; algorithm_version?: string | null; tool?: string | null };
  basis: { origin: string; references: string[]; independently_verified: boolean };
  recorded_at: string; observed_at?: string | null; actor_id?: number | null;
  establishes: string[]; does_not_establish: string[]; warnings: string[]; physical_qualification: false;
};
export type EvidenceList = { project_id: string; items: EvidenceItem[]; offset: number; limit: number; has_more: boolean; scan_limit_reached: boolean };
export type KindDescription = { kind: EvidenceKind; label: string; subject_scope: string; summary: string; establishes: string[]; does_not_establish: string[]; fact_methods: string[] };

export const KIND_ORDER: EvidenceKind[] = ["requirement", "source_claim", "calculation", "generated_check", "review", "physical_measurement", "physical_observation", "preference"];

export function evidenceQuery(projectId: string, kinds: EvidenceKind[], offset: number): string {
  const params = new URLSearchParams();
  kinds.forEach((kind) => params.append("kind", kind));
  params.set("offset", String(offset));
  params.set("limit", "50");
  return `evidence/projects/${projectId}?${params.toString()}`;
}
