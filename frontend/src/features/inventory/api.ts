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
};
export type Detail = {
  account: Account;
  entries: { entry_id: string; kind: string; amount: string | null; unit: string; after: string | null; reason: string; assertion_source: string; assertion_status: string; created_at: string }[];
  reservations: { reservation_id: string; amount: string; unit: string; purpose: string; status: string; release: { reason: string } | null }[];
};
export type Command = { operation: string; payload: object; expected_state?: string; request_id: string; idempotency_key: string };

export function request(operation: string, payload: object, state?: string): Command {
  return { operation, payload, expected_state: state, request_id: crypto.randomUUID(), idempotency_key: crypto.randomUUID() };
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
