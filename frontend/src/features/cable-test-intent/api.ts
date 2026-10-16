import { requestJson, runOperation } from '../workspace/api';
export type Terminal = { endpoint_id?: string | null; kind: 'contact' | 'stock_feature' | 'stack_terminal' | 'segment' | 'pigtail'; pigtail_id?: string | null; layer_id?: string | null; terminal_id?: string | null; segment_id?: string | null; end?: 'a' | 'b' | null; contact_id?: string | null; element_path?: string | null };
export type Evidence = { status: 'unknown' | 'unverified_citation' | 'registered_file'; citation?: string | null; source_bundle_revision_id?: string | null; source_path?: string | null; sha256?: string | null; rights?: string | null };
export type Pair = { local_id: string; first: Terminal; second: Terminal; intent: 'continuity' | 'isolation' | 'unknown'; basis: string; evidence: Evidence; signal?: string | null; expected_resistance_ohm?: number | null; derived_from?: { intent_revision_id: string; row_ids: string[] } | null };
export type Label = { local_id: string; text: string; endpoint_id?: string | null; terminal?: Terminal | null; basis: string; evidence: Evidence };
export type TestPlan = { root_revision_id: string; occurrence_path: string[]; cable_revision_id: string; pairs: Pair[]; labels: Label[] };
export type Draft = { definition_id: string; draft_id: string; state: string; content: { test_plan: TestPlan } };
export type Identity = { name?: string; drafts: { draft_id: string; state: string }[]; revisions: { revision_id: string; number: number }[] };
export type Definition = { definition_id: string; name: string; kind: string };
export type Target = { root_revision_id: string; root_snapshot_id: string; root_sha256: string; cable_revision_id: string; cable_sha256: string; occurrence_path: string[]; endpoints: { local_id: string; label: string | null }[]; terminals: { terminal: Terminal; label: string; physical_role: string }[] };
export type Inspection = { revision_id: string; sha256: string; root_snapshot_id: string; root_sha256: string; cable_sha256: string; test_plan: TestPlan; evidence: { kind: string; local_id: string; evidence: Evidence }[]; physical_test: string; physical_continuity: string; physical_qualification: string };
export const initialPlan = (): TestPlan => ({ root_revision_id: '', occurrence_path: [], cable_revision_id: '', pairs: [], labels: [] });
export const keyOf = (t: Terminal) => JSON.stringify(t.kind === 'pigtail' ? [t.segment_id, t.kind, t.end, t.pigtail_id] : t.kind === 'stack_terminal' ? [t.endpoint_id, t.kind, t.layer_id, t.terminal_id] : t.kind === 'segment' ? [t.segment_id, t.kind, t.end, t.element_path] : [t.endpoint_id, t.kind, t.contact_id || t.element_path]);
export const terminalText = (t: Terminal) => t.kind === 'pigtail' ? `${t.segment_id} / ${t.end} / pigtail ${t.pigtail_id}` : t.kind === 'stack_terminal' ? `${t.endpoint_id} / ${t.layer_id} / ${t.terminal_id}` : t.kind === 'segment' ? `${t.segment_id} / ${t.end} / ${t.element_path}` : `${t.endpoint_id} · ${t.kind} · ${t.contact_id || t.element_path}`;
export const read = <T,>(path: string) => requestJson<T>(`/api/v0/${path}`);
export async function command<T>(name: string, payload: unknown, state?: string) {
  return (await runOperation<T>(name, payload, { expectedState: state })).result;
}
export const inspectTarget = (value: TestPlan) => command<Target>('cable_test_plan.inspect_target', { root_revision_id: value.root_revision_id, occurrence_path: value.occurrence_path, cable_revision_id: value.cable_revision_id });
export type DerivedRow = { row_id: string; requirement: 'required' | 'optional' | 'must_not_connect'; signal: string | null; pairs: string[]; reasons: string[] };
export type Derivation = {
  algorithm_version: string; intent_revision_id: string; intent_name: string; intent_number: number; test_plan: TestPlan; rows: DerivedRow[];
  counts: Record<'continuity' | 'isolation' | 'unknown', number>; limited: boolean; review: 'required'; stored: false; physical_test: string;
};
export const deriveFromIntent = (value: TestPlan, intentRevisionId: string | null = null) => command<Derivation>('cable_test_plan.derive_from_intent', { root_revision_id: value.root_revision_id, occurrence_path: value.occurrence_path, cable_revision_id: value.cable_revision_id, ...(intentRevisionId ? { intent_revision_id: intentRevisionId } : {}) });
