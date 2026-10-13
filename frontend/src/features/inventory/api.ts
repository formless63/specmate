import { randomUUID } from "../../lib/random-id";
import { read } from "../identity/api";

export { read };
export type Account = {
  account_id: string; project_id: string; lot_id: string; lot_label: string;
  revision_id: string; definition_id: string; location_id: string; location_name: string;
  dimension: string; unit: string; quantity_status: "known" | "unknown";
  physical_quantity: string | null; reserved_quantity: string; available_quantity: string | null;
  state: string; assertion_source: string; assertion_status: string;
};
export type Inventory = {
  accounts: Account[]; locations: { location_id: string; name: string }[];
  lots: { lot_id: string; label: string }[];
  work_batches?: WorkBatch[];
};
export type WorkBatch = {
  work_batch_id: string; project_id: string; revision_id: string; definition_id: string;
  kind: "job" | "batch"; label: string; planned_units: number | null;
  reported_completed_units: number; progress: string; state: string;
  actual_unit_tracking: "separate_records"; physical_qualification: false;
};
export type Entry = {
  entry_id: string; kind: string; amount: string | null; unit: string; after: string | null;
  reason: string; assertion_source: string; assertion_status: string; created_at: string;
  reservation_id?: string | null; work_batch_id?: string | null;
  physical_unit_id?: string | null;
  consumption_origin_id?: string | null; returnable_quantity?: string | null;
};
export type Detail = {
  account: Account; entries: Entry[];
  reservations: { reservation_id: string; amount: string; unit: string; purpose: string;
    consumed_quantity?: string; remaining_quantity?: string; status: string;
    release: { reason: string } | null }[];
};
export type WorkDetail = {
  work_batch: WorkBatch; usage: Entry[];
  completions: { completion_id: string; units_completed: number; reason: string;
    assertion_source: string; assertion_status: string; created_at: string }[];
};
export type Submit = (operation: string, payload: object, state?: string) => void;
export type Command = { operation: string; payload: object; expected_state?: string; request_id: string; idempotency_key: string };

export function request(operation: string, payload: object, state?: string): Command {
  return { operation, payload, expected_state: state, request_id: randomUUID(), idempotency_key: randomUUID() };
}

export async function command(envelope: Command): Promise<unknown> {
  const csrf = document.cookie.split("; ").find((value) => value.startsWith("csrftoken="))?.split("=")[1];
  const response = await fetch("/api/v0/operations", {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRFToken": decodeURIComponent(csrf ?? "") },
    body: JSON.stringify(envelope),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? `Operation failed (${response.status})`);
  return body.result;
}
