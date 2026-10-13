import type { StockElement, StockSpecification } from '../../../../packages/section-layout/src';
import type { Source } from '../workshop-profiles/api';
import type { Inspection } from '../cables/api';
import { CableOperationError } from '../cables/api';
export { command, authorityDenied } from '../cables/api';
export type { Definition, Identity } from '../identity/api';
export type Review = 'unreviewed' | 'reviewed';
export type Dimension = { nominal_mm: string | null; minus_mm: string | null; plus_mm: string | null; datum: 'unknown' | 'from_stock_cut_end' | 'along_finished_lead'; basis: string | null };
type Base = { local_id: string; element_path: string; basis: string | null; source: Source | null };
export type Instruction = Base & (
  { kind: 'layer_strip'; treatment: 'unknown' | 'retain' | 'remove' | 'strip_back'; length: Dimension } |
  { kind: 'drain_treatment'; treatment: 'unknown' | 'retain' | 'trim' | 'insulate' | 'prepare_termination'; length: Dimension } |
  { kind: 'shield_lead'; treatment: 'unknown' | 'retain_shield' | 'trim' | 'form_lead' | 'fold_back'; length: Dimension } |
  { kind: 'bond_expectation'; treatment: 'unknown' | 'isolate' | 'bond'; target: { kind: 'stock_feature'; element_path: string } | { kind: 'endpoint_contact'; body_revision_id: string; contact_id: string } | null }
);
export type End = { instructions: Instruction[]; review: Review; review_basis: string | null };
export type Profile = { schema_version?: '0.1'; stock_revision_id: string; a: End; b: End };
export type Draft = { definition_id: string; draft_id: string; state: string; content: { end_preparation_profile: Profile } };
export type Feature = { element_path: string; kind: string; label?: string | null };
export type Frozen = { revision_id: string; definition_id: string; sha256: string; stock_sha256: string; profile: Profile; features: Feature[]; body_revisions: { revision_id: string; sha256: string }[]; physical_qualification: string };
export type Request = { cable_revision_id: string; profile_revision_id: string; a_endpoint_id: string; b_endpoint_id: string; mapping_basis: string; mapping_review: Review };
export type Result = { cable_revision_id: string; cable_sha256: string; profile_revision_id: string; profile_sha256: string; stock_revision_id: string; stock_sha256: string; mapping_basis: string; mapping_review: Review; ends: { profile_end: 'a' | 'b'; endpoint: Inspection['endpoints'][number]; review: Review; review_basis: string | null; instructions: { instruction: Instruction; element_kind: string; unresolved: string[]; status: string; bond_created: false }[]; missing_instructions: { element_path: string; kind: string; status: string }[] }[]; actual_bonds: string; measured_preparation: string; physical_qualification: string };
export const emptyProfile = (): Profile => ({ stock_revision_id: '', a: { instructions: [], review: 'unreviewed', review_basis: null }, b: { instructions: [], review: 'unreviewed', review_basis: null } });
export const emptyDimension = (): Dimension => ({ nominal_mm: null, minus_mm: null, plus_mm: null, datum: 'unknown', basis: null });
export function emptyInstruction(kind: Instruction['kind'], local_id: string): Instruction {
  const base = { local_id, element_path: '', basis: null, source: null, treatment: 'unknown' as const };
  return kind === 'bond_expectation' ? { ...base, kind, target: null } : { ...base, kind, length: emptyDimension() };
}
export function stockFeatures(node: StockElement, prefix = ''): Feature[] {
  const element_path = prefix ? `${prefix}.${node.id}` : node.id;
  return node.kind === 'group' ? node.children.flatMap(child => stockFeatures(child, element_path)) : [{ element_path, kind: node.kind, label: node.label }];
}
export async function read<T>(path: string): Promise<T> { return request<T>(path); }
export async function postRead<T>(path: string, payload: object): Promise<T> { return request<T>(`end-preparation/${path}`, payload); }
async function request<T>(path: string, payload?: object): Promise<T> {
  const csrf = decodeURIComponent(document.cookie.split('; ').find(c => c.startsWith('csrftoken='))?.slice(10) ?? '');
  const response = await fetch(`/api/v0/${path}`, { credentials: 'same-origin', ...(payload ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf }, body: JSON.stringify(payload) } : {}) });
  const body = await response.json();
  if (!response.ok) throw new CableOperationError(body.error?.message ?? `End preparation request failed (${response.status})`, response.status);
  return body as T;
}
export async function loadStock(revisionId: string): Promise<StockSpecification> { const result = await read<{ content: { stock: StockSpecification } }>(`revisions/${revisionId}/snapshot`); return result.content.stock; }

export type HarnessRequest = { schema_version?: '0.1'; harness_revision_id: string; section_id: string; profile_revision_id: string; a_physical_end_id: string | null; b_physical_end_id: string | null; mapping_basis: string; mapping_review: Review };
export type HarnessResult = Omit<Result, 'cable_revision_id' | 'cable_sha256' | 'ends'> & { harness_revision_id: string; harness_sha256: string; section_id: string; physical_piece_count: number; status: string; unresolved: string[]; declared_physical_ends: import('../harnesses/api').PhysicalEnd[]; ends: (Omit<Result['ends'][number], 'endpoint'> & { endpoint: Result['ends'][number]['endpoint'] | null; physical_end: import('../harnesses/api').PhysicalEnd })[] };
