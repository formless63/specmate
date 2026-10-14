import { requestJson, runOperation } from "../workspace/api";

export type Integration = {
  integration_id: string; workspace_id: string; name: string; adapter: string;
  ownership: Record<string, string>; columns: Record<string, string>; enabled: boolean; state: string;
  updated_by: { username: string }; updated_at: string;
};
export type ImportRun = {
  run_id: string; field: string; file_sha256: string; row_count: number; accepted_count: number; rejected_count: number;
  rejections: { row: number | null; reason: string }[]; duplicate_of_earlier_run: boolean; actor: { username: string }; created_at: string;
};
export type ExportRow = { export_id: string; revision_id: string; purpose: string; file_sha256: string; row_count: number; unresolved_count: number; actor: { username: string }; created_at: string };
export type ExportResult = ExportRow & { file_format: string; content: string; unresolved: unknown[] };
export type History = { runs: ImportRun[]; exports: ExportRow[] };
export type Observation = {
  observation_id: string; kind: string; observed_on: string; valid_until: string | null; supplier: string; external_ref: string;
  price: { amount: string | null; currency: string | null; per_unit: string | null } | null;
  availability: string | null; lead_time_days: number | null; promoted_offer_id: string | null;
  attribution: { integration: string; file_sha256: string; imported_by: { username: string }; row_number: number };
};

const base = "/api/v0/integrations";
export const listIntegrations = (workspaceId: string) => requestJson<{ integrations: Integration[] }>(`${base}/workspaces/${workspaceId}`);
export const readHistory = (id: string) => requestJson<History>(`${base}/${id}/history`);
export const listObservations = (workspaceId: string, revisionId: string) =>
  requestJson<{ label: string; observations: Observation[] }>(`${base}/workspaces/${workspaceId}/revisions/${revisionId}/observations?kind=supplier_offer`);
export const run = <T,>(operation: string, payload: object, expectedState?: string) =>
  runOperation<T>(operation, payload, { expectedState, idempotencyKey: crypto.randomUUID() }).then((r) => r.result);
