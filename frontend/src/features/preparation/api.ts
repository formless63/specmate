import { apiErrorMessage } from "../../lib/api-errors";
import type { Source } from '../workshop-profiles/api';
import { CableOperationError } from '../cables/api';
export { command, authorityDenied } from '../cables/api';
export { read, type Definition, type Identity } from '../identity/api';
export type Allowance = { local_id: string; kind: 'slack' | 'preparation' | 'trim'; scope: 'whole_piece' | 'end_a' | 'end_b'; amount_mm: string | null; basis: string; source: Source | null };
export type Formula = { local_id: string; label: string; target: 'stock_piece' | 'conductive_feature'; element_path: string | null; input_length: 'route' | 'finished' | 'stock_cut' | 'conductor_cut'; input_basis: 'declaration' | 'model_suggestion'; allowances: Allowance[]; review: 'unreviewed' | 'reviewed'; review_basis: string | null };
export type Profile = { schema_version?: '0.1'; stock_revision_id: string; formulas: Formula[] };
export type Draft = { definition_id: string; draft_id: string; state: string; content: { preparation_profile: Profile } };
export type Frozen = { revision_id: string; sha256: string; stock_sha256: string; profile: Profile; conductive_features: { element_path: string; kind: string }[] };
export type Application = { section_id: string | null; profile_revision_id: string };
export type Request = { revision_id: string; applications: Application[]; quantity: number | null };
export type Row = { section_id: string | null; segment_ids: string[]; target: string; element_path: string | null; element_kind: string | null; profile_revision_id: string; profile_sha256: string; stock_revision_id: string; stock_sha256: string; formula: Formula; input_mm: string | null; input_provenance?: { declaration?: { amount_mm: string | null; basis: string; explanation: string | null }; model?: { source: string; review: string; review_basis: string | null; allowances: { kind: string; amount_mm: string | null; scope: string; endpoint_id: string | null; explanation: string }[] } | null } | null; cut_mm: string | null; total_mm: string | null; declared_cut_mm: string | null; declaration_matches_result: boolean | null; status: string };
export type Result = { revision_id: string; sha256: string; quantity: number | null; physical_piece_count: number | null; rows: Row[]; unprofiled_sections: (string | null)[] };
export const emptyProfile = (): Profile => ({ stock_revision_id: '', formulas: [] });
export const emptyFormula = (index: number): Formula => ({ local_id: `cut-${index}`, label: `Cut ${index}`, target: 'stock_piece', element_path: null, input_length: 'route', input_basis: 'declaration', allowances: [], review: 'unreviewed', review_basis: null });
export async function postRead<T>(path: string, payload: object): Promise<T> {
  const csrf = document.cookie.split('; ').find(cookie => cookie.startsWith('csrftoken='))?.split('=')[1];
  const response = await fetch(`/api/v0/preparation/${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': decodeURIComponent(csrf ?? '') }, body: JSON.stringify(payload) });
  const body = await response.json();
  if (!response.ok) throw new CableOperationError(apiErrorMessage(body, `Preparation read failed (${response.status})`), response.status);
  return body as T;
}
