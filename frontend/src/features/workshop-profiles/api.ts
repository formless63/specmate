import { randomUUID } from "../../lib/random-id";
import type { StockSpecification } from '../../../../packages/section-layout/src';

export type Basis = 'unknown' | 'documented' | 'inferred' | 'preference';
export type Source = { kind: 'citation'; citation: string } | {
  kind: 'source_file'; bundle_revision_id: string; path: string; locator: string; sha256: string; rights: string;
};
export interface Suggestion<T> { value: T | null; basis: Basis; source: Source | null; note: string | null }
export interface LeadDisplay {
  length_mm: Suggestion<number>; diameter_mm: Suggestion<number>;
  reach_mm: Suggestion<number>; angle_deg: Suggestion<number>;
}
export interface EndPractice {
  cutback_mm: Suggestion<number>; prepend_cut_mm: Suggestion<number>; lead: LeadDisplay | null;
}
export interface ElementPractice { a: EndPractice; b: EndPractice }
export interface WorkshopProfile {
  schema_version: '1'; stock_revision_id: string;
  foil_visibility: Suggestion<'show' | 'hide'>;
  illustration_lay_length_mm: Suggestion<number>;
  /** Older exact frozen snapshots may omit this; absence remains unknown. */
  illustration_lay_direction?: Suggestion<'positive' | 'negative'>;
  omit_occluded: Suggestion<boolean>;
  element_rules: Record<string, ElementPractice>;
  hidden_element_paths: string[];
}
export interface ProfileRecord {
  definition_id: string; draft_id: string; name: string; state: string;
  base_revision_id: string | null; content: { profile?: WorkshopProfile };
}
export interface ProfileRevision {
  revision_id: string; definition_id: string; name: string; number: number; sha256: string;
  content: { profile: WorkshopProfile };
}
export interface StockChoice { definition_id: string; draft_id: string; name: string; base_revision_id: string | null }

const csrf = (): string => decodeURIComponent(document.cookie.split('; ').find(c => c.startsWith('csrftoken='))?.slice(10) ?? '');
async function read<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? `Request failed (${response.status}).`);
  return body as T;
}

export const listProfiles = (projectId: string): Promise<ProfileRecord[]> =>
  read(`/api/v0/projects/${encodeURIComponent(projectId)}/workshop-profiles`);
export const listStocks = (projectId: string): Promise<StockChoice[]> =>
  read(`/api/v0/projects/${encodeURIComponent(projectId)}/stocks`);
export const listProfileRevisions = (definitionId: string): Promise<ProfileRevision[]> =>
  read(`/api/v0/workshop-profile-definitions/${encodeURIComponent(definitionId)}/revisions`);
export const readProfileRevision = (revisionId: string): Promise<ProfileRevision> =>
  read(`/api/v0/workshop-profile-revisions/${encodeURIComponent(revisionId)}`);
export async function readStockRevision(revisionId: string): Promise<StockSpecification> {
  const canonical = await read<{ content: { stock: StockSpecification } }>(
    `/api/v0/revisions/${encodeURIComponent(revisionId)}/snapshot`);
  return canonical.content.stock;
}

async function command<T>(operation: string, payload: object, expectedState?: string): Promise<T> {
  const response = await read<{ result: T }>('/api/v0/operations', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf() },
    body: JSON.stringify({ operation, request_id: randomUUID(), idempotency_key: randomUUID(),
      expected_state: expectedState ?? null, payload }),
  });
  return response.result;
}
export function saveProfile(projectId: string, name: string, profile: WorkshopProfile, current: ProfileRecord | null): Promise<ProfileRecord> {
  return command(current ? 'workshop_profile.update' : 'workshop_profile.create',
    current ? { draft_id: current.draft_id, profile } : { project_id: projectId, name, profile }, current?.state);
}
export function freezeProfile(current: ProfileRecord): Promise<{ revision_id: string; number: number; draft: { state: string } }> {
  return command('workshop_profile.freeze', { draft_id: current.draft_id }, current.state);
}
