import { requestJson, runOperation } from "../workspace/api";

export const LIST_KEYS = ["preferred_suppliers", "wire_colors", "connector_families"] as const;
export type ListKey = (typeof LIST_KEYS)[number];
export type PreferenceValues = Partial<Record<ListKey, string[]>> & { default_length_unit?: string; default_wire_gauge_system?: string };
export type Layer = { values: PreferenceValues; state_token: string };
export type Effective = Record<string, { value: string[] | string | null; source: "user" | "workspace" | "none" }>;
export type Preferences = {
  workspace_id: string; kind: "preference"; engineering_fact: false; note: string;
  workspace: Layer; user: Layer; effective: Effective;
};

export function readPreferences(workspaceId: string) {
  return requestJson<Preferences>(`/api/v0/preferences?workspace_id=${encodeURIComponent(workspaceId)}`);
}

/** Every key is sent; null clears it so the layer below (or "no preference") shows through. */
export async function savePreferences(workspaceId: string, scope: "workspace" | "user", values: Record<string, string[] | string | null>, state: string) {
  const response = await runOperation<Preferences>("preferences.set", { workspace_id: workspaceId, scope, values }, { expectedState: state });
  return response.result;
}
