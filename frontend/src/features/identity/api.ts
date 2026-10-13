export type Definition = { definition_id: string; name: string; kind: string };
export type Identity = Definition & {
  revisions: { revision_id: string; number: number }[];
  drafts: { draft_id: string; state: string; dependencies: string[] }[];
};
export type Catalog = {
  revision_id: string;
  variants: { variant_id: string; manufacturer: string; part_number: string; association_basis: string }[];
  lots: { lot_id: string; variant_id: string | null; label: string }[];
  representations: { representation_id: string; kind: string; label: string; source_bundle_revision_id: string; source_path: string; sha256: string; rights: string }[];
};

export async function read<T>(path: string): Promise<T> {
  const response = await fetch(`/api/v0/${path}`, { credentials: "same-origin" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? `Request failed (${response.status})`);
  return body as T;
}

export async function command<T>(operation: string, payload: object, expectedState?: string): Promise<T> {
  const csrf = document.cookie.split("; ").find((cookie) => cookie.startsWith("csrftoken="))?.split("=")[1];
  const response = await fetch("/api/v0/operations", {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRFToken": decodeURIComponent(csrf ?? "") },
    body: JSON.stringify({ operation, payload, request_id: crypto.randomUUID(), idempotency_key: crypto.randomUUID(), expected_state: expectedState }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? `Operation failed (${response.status})`);
  return body.result as T;
}
