import { apiErrorMessage } from "../../lib/api-errors";
import type { Source } from '../workshop-profiles/api';
import type { DemandQuantity, Waste } from '../bom/api';
import type { Row as CutRow } from '../preparation/api';
import type { Request as EndRequest, Result as EndResult } from '../end-preparation/api';
import { CableOperationError } from '../cables/api';
export { command, authorityDenied } from '../cables/api';
export async function read<T>(path: string): Promise<T> {
  const response = await fetch(`/api/v0/${path}`, { credentials: 'same-origin' });
  const body = await response.json();
  if (!response.ok) throw new CableOperationError(apiErrorMessage(body, `Material read failed (${response.status})`), response.status);
  return body as T;
}
// Authority is a fresh read, never an idempotent engineering command.
export async function checkAuthority(plan: Plan): Promise<{ authorized: boolean }> {
  const csrf = document.cookie.split('; ').find(cookie => cookie.startsWith('csrftoken='))?.split('=')[1];
  const response = await fetch('/api/v0/material-accounting/authority', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRFToken': decodeURIComponent(csrf ?? '') },
    body: JSON.stringify(plan),
  });
  const body = await response.json();
  if (!response.ok) throw new CableOperationError(apiErrorMessage(body, `Material authority failed (${response.status})`), response.status);
  return body;
}
export type { Definition, Identity } from '../identity/api';
export type Extent = { amount_mm: string | null; basis: string; source: Source | null };
export type Reconciliation = { consumption_ids: string[]; retained: DemandQuantity; waste: DemandQuantity; basis: string; source: Source | null };
export type Piece = { section_id: string | null; installed: Extent; cut_basis: 'declaration' | 'preparation_suggestion'; profile_revision_id: string | null; extra_waste: Extent; reconciliation: Reconciliation | null };
export type Consumable = { local_id: string; revision_id: string; quantity: DemandQuantity; waste: Waste | null; basis: string; source: Source | null; reconciliation: Reconciliation | null };
export type Plan = { schema_version?: '0.1'; subject_revision_id: string; quantity: number | null; decision: 'make' | 'buy' | 'unknown'; decision_basis: string; pieces: Piece[]; consumables: Consumable[]; end_preparation: EndRequest | null };
export type Draft = { definition_id: string; draft_id: string; state: string; content: { material_plan: Plan } };
export type Actual = { record: Reconciliation; unit: string; issued: string | null; returned: string | null; net_issued: string | null; unallocated: string | null; status: string; inventory_entries: { consumption_id: string; account_id: string; work_batch_id: string; physical_unit_id: string | null; assertion_source: string; assertion_status: string }[] };
export type Result = { revision_id: string; sha256: string; plan: Plan; subject_revision_id: string; subject_sha256: string; quantity: number | null; decision: string; purchased_subject_quantity: number | null; unplanned_sections: (string | null)[]; pieces: { section_id: string | null; stock_revision_id: string; stock_sha256: string; segment_ids: string[]; installed_mm: string | null; installed_total_mm: string | null; cut_mm: string | null; cut_total_mm: string | null; cut_basis: string; declared_cut_mm: string | null; extra_waste_mm: string | null; extra_waste_total_mm: string | null; cut_minus_installed_mm: string | null; procurement_mm: string | null; procurement_status: string; preparation: CutRow | null; reconciliation: Actual | null }[]; consumables: { local_id: string; revision_id: string; sha256: string; declaration: Consumable; unit: string; net_quantity: string | null; waste_quantity: string | null; procurement_quantity: string | null; procurement_status: string; reconciliation: Actual | null }[]; end_preparation: EndResult | null; limitations: string[] };
export const emptyExtent = (): Extent => ({ amount_mm: null, basis: '', source: null });
export const emptyPlan = (): Plan => ({ subject_revision_id: '', quantity: 1, decision: 'unknown', decision_basis: '', pieces: [], consumables: [], end_preparation: null });
