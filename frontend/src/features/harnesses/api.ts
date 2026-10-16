import { apiErrorMessage } from "../../lib/api-errors";
import type { EndStack, ResolvedStack } from '../end-assemblies/api';
export { type Definition, type Identity } from '../identity/api';
export { command } from '../cables/api';
import { CableOperationError } from '../cables/api';
export type PhysicalEnd = { local_id: string; label: string | null; segment_ends: SegmentEnd[]; endpoint_id: string | null; basis: string; review: 'unreviewed' | 'reviewed' };
export type Section = { local_id: string; stock_revision_id: string; planned_cut_length_mm: string | null; cut_basis: string | null; physical_ends?: PhysicalEnd[] };
export type Segment = { local_id: string; section_id: string; label: string | null; element_paths: string[] | null };
export type SegmentEnd = { segment_id: string; end: 'a' | 'b' };
export type SegmentTerminal = SegmentEnd & { kind: 'segment'; element_path: string };
/** One harness endpoint (content 0.2): a pinned end assembly or an ad-hoc end stack. */
export type Endpoint = { local_id: string; label: string | null; end_assembly_revision_id: string | null; stack: EndStack | null };
export type EndpointTerminal = { kind: 'endpoint'; endpoint_id: string; layer_id: string; terminal_id: string };
export type Terminal = SegmentTerminal | EndpointTerminal;
export type Joint = { local_id: string; kind: 'termination' | 'splice' | 'shield_bond'; members: Terminal[]; basis: string };
export type Fate = { local_id: string; kind: 'through'; trunk: SegmentTerminal; leg: SegmentTerminal; basis: string } | { local_id: string; kind: 'joint'; terminal: SegmentTerminal; joint_id: string } | { local_id: string; kind: 'unconnected'; terminal: SegmentTerminal; basis: string };
export type Breakout = { local_id: string; trunk: SegmentEnd; legs: SegmentEnd[]; fates: Fate[] };
export type Harness = { schema_version?: '0.2' | '0.3'; intent_revision_id?: string | null; sections: Section[]; segments: Segment[]; endpoints: Endpoint[]; joints: Joint[]; breakouts: Breakout[]; review: 'unreviewed' | 'reviewed'; review_basis: string | null };
export type Draft = { definition_id: string; draft_id: string; base_revision_id?: string | null; state: string; content: { harness?: Harness } };
export type DeclaredRelationship = { id: string; breakout_id?: string; kind: string; members: Terminal[]; basis: string };
export type Inspection = { revision_id: string; harness: Harness; terminals: { terminal: Terminal; feature_kind: string; layer_kind?: string; label?: string; contact_id?: string; signal?: ResolvedStack['layers'][number]['terminals'][number]['signal'] }[]; endpoints?: { local_id: string; label: string | null; end_assembly_revision_id: string | null; end_assembly_name: string | null; resolved_stack: ResolvedStack }[]; stored_schema_version?: string; declared_relationships: DeclaredRelationship[]; breakout_fates: { breakout_id: string; terminal: SegmentTerminal; fate: string }[]; quantities: { harness_count: number | null; segment_count: number | null; physical_piece_count: number | null; stock: { stock_revision_id: string; section_ids: string[]; piece_count: number | null; planned_cut_total_mm: string | null }[] }; continuity: string; compatibility: string; physical_qualification: string };
export const initialHarness = (): Harness => ({ schema_version: '0.2', sections: [], segments: [], endpoints: [], joints: [], breakouts: [], review: 'unreviewed', review_basis: null });
export const terminalLabel = (t: Terminal): string => t.kind === 'segment' ? `${t.segment_id} / ${t.end} / ${t.element_path}` : `${t.endpoint_id} / ${t.layer_id} / ${t.terminal_id}`;
export const terminalKey = (t: Terminal): string => JSON.stringify(t.kind === 'segment' ? [t.kind, t.segment_id, t.end, t.element_path] : [t.kind, t.endpoint_id, t.layer_id, t.terminal_id]);
/** How an endpoint is built, in a few words: its end assembly or its stack's layer kinds. */
export const endpointSummary = (e: Endpoint): string => e.end_assembly_revision_id ? 'end assembly' : e.stack ? e.stack.layers.map(l => l.kind).join(' → ') : 'no stack';

export async function read<T>(path: string, payload?: Harness): Promise<T> {
  const csrf = decodeURIComponent(document.cookie.split('; ').find(c => c.startsWith('csrftoken='))?.slice(10) ?? '');
  const response = await fetch(`/api/v0/${path}`, { credentials: 'same-origin', ...(payload ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf }, body: JSON.stringify(payload) } : {}) });
  const body = await response.json();
  if (!response.ok) throw new CableOperationError(apiErrorMessage(body, `Harness request failed (${response.status})`), response.status);
  return body as T;
}
