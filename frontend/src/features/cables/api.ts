import { apiErrorMessage, fieldErrorMap } from "../../lib/api-errors";
import { randomUUID } from "../../lib/random-id";
import type { LengthPlan, Projection } from "./Lengths";
import type { Body, Pinout } from '../interfaces/api';
export { read, type Definition, type Identity } from '../identity/api';
export type Endpoint = { local_id: string; label: string | null; body_revision_id: string; pinout_revision_id: string };
export type Assignment = { endpoint_id: string; element_path: string; contact_id: string; basis: string };
export type Cable = { lengths?: LengthPlan | null; schema_version?: '0.1'; stock_revision_id: string; endpoints: Endpoint[]; assignments: Assignment[]; review: 'unreviewed' | 'reviewed'; review_basis: string | null };
export type Draft = { definition_id: string; draft_id: string; state: string; content: { cable?: Cable } };
export type Inspection = { lengths?: Projection; revision_id: string; snapshot_id: string; cable: Cable; conductors: { element_path: string; stock_revision_id: string; kind: string; label: string; ends: { endpoint_id: string; assignment: Assignment | null }[] }[]; endpoints: (Endpoint & { body: Body; pinout: Pinout })[]; continuity: string; compatibility: string; physical_qualification: string };
export function initialCable(): Cable {
  return { stock_revision_id: '', endpoints: ['a', 'b'].map(local_id => ({ local_id, label: null, body_revision_id: '', pinout_revision_id: '' })), assignments: [], review: 'unreviewed', review_basis: null };
}

export class CableOperationError extends Error {
  constructor(message: string, readonly status: number, readonly fieldErrors: Record<string, string> = {}) { super(message); }
}
export const authorityDenied = (error: unknown) => error instanceof CableOperationError && [401, 403, 404].includes(error.status);

// Retain HTTP authority status so the workspace can gate stale source-derived content.
export async function command<T>(operation: string, payload: object, expectedState?: string): Promise<T> {
  const csrf = document.cookie.split('; ').find(cookie => cookie.startsWith('csrftoken='))?.split('=')[1];
  const response = await fetch('/api/v0/operations', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRFToken': decodeURIComponent(csrf ?? '') },
    body: JSON.stringify({ operation, payload, request_id: randomUUID(), idempotency_key: randomUUID(), expected_state: expectedState }),
  });
  const body = await response.json();
  if (!response.ok) throw new CableOperationError(apiErrorMessage(body, `Operation failed (${response.status})`), response.status, fieldErrorMap(body));
  return body.result as T;
}
