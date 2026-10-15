import { apiErrorMessage, fieldErrorMap } from "../../lib/api-errors";
import { randomUUID } from "../../lib/random-id";
import type { LengthPlan, Projection } from "./Lengths";
import type { Body, Pinout } from '../interfaces/api';
export { read, type Definition, type Identity } from '../identity/api';
import { type EndStack, type ResolvedStack, type Reach, type SignalRef } from '../end-assemblies/api';
/** A schema 0.1 cable end and a harness end: one connector body and pinout. */
export type ConnectorEndpoint = { local_id: string; label: string | null; body_revision_id: string; pinout_revision_id: string };
/** A cable end (schema 0.2): a pinned end assembly or an ad-hoc stack, and the stock end it uses. */
export type Endpoint = { local_id: string; label: string | null; stock_end: 'a' | 'b' | 'unknown'; end_assembly_revision_id: string | null; stack: EndStack | null };
export type Assignment = { endpoint_id: string; element_path: string; layer_id: string; terminal_id: string; basis: string };
export type ResolvedTermination = Assignment & { layer_kind: string; terminal_label: string; contact_id: string | null; signal: SignalRef | null; reaches: Reach[] };
export type Cable = { lengths?: LengthPlan | null; schema_version?: '0.2'; stock_revision_id: string; intent_revision_id?: string | null; endpoints: Endpoint[]; assignments: Assignment[]; review: 'unreviewed' | 'reviewed'; review_basis: string | null };
export type Draft = { definition_id: string; draft_id: string; state: string; content: { cable?: Cable } };
export type InspectedEndpoint = Endpoint & {
  end_assembly_name?: string | null; end_assembly_revision_number?: number | null; resolved_stack?: ResolvedStack;
  body_revision_id: string | null; pinout_revision_id: string | null; body: Body | null; pinout: Pinout | null;
};
export type Inspection = { intent?: { revision_id: string; name: string; number: number; check: 'not_evaluated' } | null; lengths?: Projection; revision_id: string; snapshot_id: string; stored_schema_version?: string; cable: Cable; terminations?: ResolvedTermination[]; conductors: { element_path: string; stock_revision_id: string; kind: string; label: string; ends: { endpoint_id: string; assignment: ResolvedTermination | null }[] }[]; endpoints: InspectedEndpoint[]; continuity: string; compatibility: string; physical_qualification: string };
export function initialCable(): Cable {
  return { schema_version: '0.2', stock_revision_id: '', endpoints: ['a', 'b'].map(local_id => ({ local_id, label: null, stock_end: 'unknown' as const, end_assembly_revision_id: null, stack: null })), assignments: [], review: 'unreviewed', review_basis: null };
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

/**
 * What is still missing before a cable can be saved, one plain sentence per gap and naming the end.
 * A new cable starts with each end unchosen; this mirrors the server's pinned-reference checks so
 * an empty choice is explained here instead of arriving as a raw validation error.
 */
export function cableProblems(cable: Cable): string[] {
  const problems: string[] = [];
  if (!cable.stock_revision_id) problems.push('Stock: choose a wire stock.');
  cable.endpoints.forEach((endpoint, index) => {
    const name = endpoint.label?.trim() || `End ${String.fromCharCode(65 + index)}`;
    if (endpoint.end_assembly_revision_id !== null) {
      if (!endpoint.end_assembly_revision_id) problems.push(`${name}: choose an end assembly revision.`);
      return;
    }
    if (!endpoint.stack) { problems.push(`${name}: choose an end assembly or build this end.`); return; }
    for (const layer of endpoint.stack.layers) {
      if (layer.kind === 'connector') {
        if (!layer.body_revision_id) problems.push(`${name}: choose a connector body.`);
        if (!layer.pinout_revision_id) problems.push(`${name}: choose a connector pinout variant.`);
      } else if (layer.kind === 'board' && !layer.board_revision_id) problems.push(`${name}: choose a board revision.`);
    }
  });
  return problems;
}
