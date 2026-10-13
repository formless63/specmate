export { command, read, type Definition, type Identity } from "../identity/api";

export type Target = { kind: "project"; project_id: string } | { kind: "definition"; definition_id: string; feature_id?: string | null } | { kind: "revision"; revision_id: string; feature_id?: string | null } | { kind: "occurrence"; snapshot_id: string; path: string[]; feature_id?: string | null } | { kind: "physical_unit"; unit_id: string };
export type Subject = { subject_id: string; project_id: string; target: Target; state: string; physical_unit_serial?: string };
export type Status = "known" | "unknown" | "conflicting" | "not_applicable" | "not_evaluated";
export type Method = "source_observation" | "reviewed_association" | "calculation" | "measurement" | "preference";
export type Purpose = "general" | "manufacturing" | "clearance" | "illustration" | "rating" | "preference";
export type Role = "actual" | "nominal" | "lower_bound" | "upper_bound" | "tolerance";
export type Numeric = { kind: "quantity" | "range" | "tolerance"; dimension: string; unit: string; magnitude?: string | null; lower?: string | null; upper?: string | null; minus?: string | null; plus?: string | null };
export type Value = Numeric | { kind: "text"; text: string } | { kind: "boolean"; value: boolean };
export type Evidence = { kind: "citation"; citation: string } | { kind: "source_file"; bundle_revision_id: string; path: string; locator?: string } | { kind: "assertion"; assertion_id: string };
export type Fact = { property: string; status: Status; purpose: Purpose; role: Role; value: Value | null; conditions: { property: string; status: "known" | "unknown"; value: Value | null }[]; basis: string; provenance: { method: Method; evidence: Evidence[]; observed_at?: string | null; instrument?: string | null; procedure?: string | null; formula?: string | null; algorithm_version?: string | null } };
export type Assertion = { assertion_id: string; subject_id: string; sequence: number; fact: Fact; canonical_value: Value | null; recorded_at: string; relation_to_design_state: "attached_evidence"; evidence_status: "declared" };
export type Assessment = { status: Status; value: Value | null; assertion_ids: string[]; purpose?: Purpose; role?: Role; conditions?: Fact["conditions"]; reason?: string };
export type Facts = Subject & { assertions: Assertion[]; assessments: Record<string, Assessment[]>; offset: number; limit: number; has_more: boolean };

export function targetLabel(target: Target, serial?: string): string {
  if (target.kind === "project") return `Project ${target.project_id}`;
  if (target.kind === "definition") return `Definition ${target.definition_id}${target.feature_id ? ` / ${target.feature_id}` : ""}`;
  if (target.kind === "revision") return `Revision ${target.revision_id}${target.feature_id ? ` / ${target.feature_id}` : ""}`;
  if (target.kind === "physical_unit") return `Physical unit ${serial ?? target.unit_id}`;
  return `${target.snapshot_id} / ${target.path.join("/")}${target.feature_id ? ` / ${target.feature_id}` : ""}`;
}

export function valueLabel(value: Value | null): string {
  if (!value) return "No value";
  if (value.kind === "text") return value.text;
  if (value.kind === "boolean") return value.value ? "True" : "False";
  if (value.kind === "range") return `${value.lower} to ${value.upper} ${value.unit}`;
  if (value.kind === "tolerance") return `−${value.minus} / +${value.plus} ${value.unit}`;
  return `${value.magnitude} ${value.unit}`;
}
