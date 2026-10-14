import { apiErrorMessage } from "../../lib/api-errors";
import { randomUUID } from "../../lib/random-id";
import type { StockSpecification } from '../../../../packages/section-layout/src';

export interface StockRecord {
  definition_id: string;
  workspace_id?: string;
  in_project?: boolean;
  draft_id: string;
  name: string;
  state: string;
  content: { stock?: StockSpecification };
}
const csrf = (): string => decodeURIComponent(document.cookie.split('; ').find(c => c.startsWith('csrftoken='))?.slice(10) ?? '');
async function read<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(apiErrorMessage(body, `Request failed (${response.status}).`));
  return body as T;
}
/** Library stock; a project id only lists the stock that project references first. */
export const listStocks = (projectId?: string | null): Promise<StockRecord[]> =>
  read(`/api/v0/stocks${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`);
/** New stock joins the workspace library (the server resolves the actor's workspace); a `projectId` also references it from that project in the same operation. */
export async function saveStock(name: string, stock: StockSpecification, current: StockRecord | null, projectId?: string | null): Promise<StockRecord> {
  const result = await read<{ result: StockRecord }>('/api/v0/operations', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf() },
    body: JSON.stringify({ operation: current ? 'wire_stock.update' : 'wire_stock.create',
      request_id: randomUUID(), idempotency_key: randomUUID(), expected_state: current?.state ?? null,
      payload: current ? { draft_id: current.draft_id, stock } : { name, stock, ...(projectId ? { project_id: projectId } : {}) } }),
  });
  return result.result;
}
export async function freezeStock(current: StockRecord): Promise<{ number: number; draft: { state: string } }> {
  const result = await read<{ result: { number: number; draft: { state: string } } }>('/api/v0/operations', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf() },
    body: JSON.stringify({ operation: 'wire_stock.freeze', request_id: randomUUID(),
      idempotency_key: randomUUID(), expected_state: current.state, payload: { draft_id: current.draft_id } }),
  });
  return result.result;
}
