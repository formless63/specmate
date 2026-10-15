import type { DocumentSettingsSnapshot } from "../settings/api";
import { apiErrorMessage } from "../../lib/api-errors";
import { sha256Hex } from '../../lib/sha256';
import { ApiError, requestJson as request, runOperation } from '../workspace/api';
import type { DocumentSections } from '../../../../packages/docs/src/model';
export { ApiError } from '../workspace/api';
export const requestJson = <T,>(path: string) => request<T>(path, { cache: 'no-store' });
export type RightsReview = { subject: string; decision: 'unknown' | 'permitted' | 'withheld'; basis: string };
export type EndBinding = { section_id: string | null; profile_revision_id: string; a_end_id: string | null; b_end_id: string | null; mapping_review: 'unreviewed' | 'reviewed'; mapping_basis: string };
export type Binding = { occurrence_path: string[]; cut_profiles: { section_id: string | null; profile_revision_id: string }[]; end_profiles: EndBinding[]; test_plan_revision_id: string | null };
export type Configuration = { document_settings?: DocumentSettingsSnapshot; root_revision_id: string; quantity: number | null; bom_plan_revision_id: string | null; standalone_decision: 'unknown' | 'make' | 'buy'; standalone_basis: string | null; bindings: Binding[]; purpose: 'authorized_review' | 'distribution'; rights_reviews: RightsReview[]; output_rights: string; output_rights_basis: string | null };
export type ContextPin = { address: { root_snapshot_id: string; path: string[]; revision_id: string; snapshot_sha256: string }; kind: string; disposition: string; sections: { section_id: string | null; stock_revision_id: string; end_ids: string[] }[] };
export type Output = { filename: string; sha256: string; size: number; media_type: string; rights: string; inputs_sha256: string };
export type Manifest = { inputs_sha256: string; readiness: string; inputs: { root: { revision_id: string; snapshot_id: string; snapshot_sha256: string; name: string; kind: string }; generator: string; format: string; physical_test: string; physical_continuity: string; fit: string; physical_qualification: boolean; revision_pins: { revision_id: string; snapshot_id: string; snapshot_sha256: string; name: string; kind: string }[]; source_pins: { bundle_revision_id: string; path: string; sha256: string; rights: string; source_manifest_sha256: string; ancestry: unknown[] }[]; rights_reviews: { subject: string; review: RightsReview }[]; configuration: Configuration }; context_pins: ContextPin[]; document_assessments: Record<string, { status: string; physical_qualification: string; limitations?: unknown[]; missing_end_profiles?: unknown[]; missing_or_empty_intent?: unknown[]; unassigned_count?: number }>; issues: { path: string[]; code: string; status: string; message: string }[]; outputs: Output[] };
export type Review = { manifest: Manifest; state: string };
export type Defaults = { configuration: Configuration; root: Manifest['inputs']['root']; context_pins: ContextPin[]; rights_subjects: string[] };
export type Preview = Review & { sections: DocumentSections };
export type RetainedSetPage = { root_revision_id: string; results: { document_set_id: string; root_revision_id: string; created_at: string; generator: string; quantity: number | null; inputs_sha256: string }[]; next_after: string | null; listing: string };
export async function listSets(rootRevisionId: string, after: string | null = null) { return (await runOperation<RetainedSetPage>('preparation_documents.list', { root_revision_id: rootRevisionId, after, limit: 10 })).result; }
export async function defaults(rootRevisionId: string) { return (await runOperation<Defaults>('preparation_documents.defaults', { root_revision_id: rootRevisionId })).result; }
export async function preview(config: Configuration) { return (await runOperation<Preview>('preparation_documents.preview', config)).result; }
export type RootCurrency = { root_revision_number: number; status: 'latest' | 'superseded'; newer_revision: { revision_id: string; number: number; definition_id: string; kind: string; name: string; frozen_at: string } | null };
export type Receipt = { root_currency?: RootCurrency; document_set_id: string; manifest: Manifest; sha256: string; generator: string; created_at: string; created_by_id: number };
export const emptyConfiguration = (): Configuration => ({ root_revision_id: '', quantity: 1, bom_plan_revision_id: null, standalone_decision: 'unknown', standalone_basis: null, bindings: [], purpose: 'authorized_review', rights_reviews: [], output_rights: 'unknown', output_rights_basis: null });
export async function review(config: Configuration) { return (await runOperation<Review>('preparation_documents.review', config)).result; }
export async function generate(config: Configuration, state: string, key: string) { return (await runOperation<Receipt>('preparation_documents.generate', config, { expectedState: state, idempotencyKey: key })).result; }
export async function receipt(id: string) { return (await runOperation<Receipt>('preparation_documents.read', { document_set_id: id })).result; }
export async function download(id: string, output: Output): Promise<Blob> {
  const token = document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith('csrftoken='))?.slice(10) ?? '';
  const response = await fetch('/api/v0/preparation-documents/download', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': decodeURIComponent(token) }, body: JSON.stringify({ document_set_id: id, filename: output.filename }) });
  if (!response.ok) { const body = await response.json().catch(() => null); throw new ApiError(response.status, apiErrorMessage(body, `Document download failed (${response.status}).`)); }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== output.size || await sha256Hex(bytes) !== output.sha256) throw new Error('Retained document hash or size mismatch.');
  return new Blob([bytes], { type: output.media_type });
}
export function saveFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  try { link.href = url; link.download = filename; link.click(); } finally { URL.revokeObjectURL(url); }
}

export function references(config: Configuration) {
  return [...new Set([config.bom_plan_revision_id, ...config.bindings.flatMap(b => [b.test_plan_revision_id, ...b.cut_profiles.map(p => p.profile_revision_id), ...b.end_profiles.map(p => p.profile_revision_id)])].filter((id): id is string => !!id && id !== config.root_revision_id))].sort();
}
export async function authority(config: Configuration) {
  return (await runOperation<{ authorized: true }>('preparation_documents.authority', { root_revision_id: config.root_revision_id, supplementary_revision_ids: references(config) })).result;
}
