import { randomUUID } from "../../lib/random-id";
export type FilePin = { source_bundle_revision_id: string; source_path: string; sha256: string; rights: string };
export type RecipeReference = { recipe_id: string; version: string; digest: string };
export type Entry = { key: string; label: string; category: "content" | "rule" | "profile" | "model" | "recipe_reference"; revision_id?: string | null; revision_sha256?: string | null; source?: FilePin | null; recipe?: RecipeReference | null; rights: string };
export type AuthorityRequest = { kind: "execution" | "network_egress" | "in_process_code"; scope: string; reason: string };
export type Manifest = { format: "specmate.catalog-pack"; kind: "catalog" | "adapter"; contract_version: string; compatible_contract_versions: string[]; package_key: string; label: string; version: string; publisher: string; rights: string; capabilities: string[]; requested_authority: AuthorityRequest[]; dependencies: string[]; entries: Entry[] };
export type Pack = { pack_id: string; workspace_id: string; package_key: string; state: string; installed_version_id: string | null; enabled: boolean; versions: { version_id: string; version: string; label: string; sha256: string }[]; kind: "catalog" | "adapter"; enabled_needs: string[] };
export type Version = { version_id: string; pack_id: string; sha256: string; manifest: Manifest; manifest_source: FilePin | null; compatibility: "supported_contract" | "unsupported_contract"; declared_needs: string[]; dependency_versions: { version_id: string; package_key: string; version: string; sha256: string; enabled: boolean }[]; registered_by_id: number; registered_at: string; entries: (Entry & { engineering: { definition_id: string; revision_id: string; name: string; kind: string; number: number; sha256: string } | null; interpretation: string })[] };
export type Decision = { decision_id: string; sequence: number; action: "install" | "adopt" | "disable"; version_id: string; version: string; basis: string; decided_by_id: number; decided_at: string; adoptions: { key: string; source_revision_id: string | null; definition_id: string | null; draft_id: string | null; status: "draft_created" | "inert_reference" }[] };
export type SourceFile = FilePin & { file_id: number; bundle_name: string; bundle_number: number };

export class PackRequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export async function read<T>(path: string): Promise<T> {
  const response = await fetch(`/api/v0/${path}`, { credentials: "same-origin" });
  const body = await response.json();
  if (!response.ok) throw new PackRequestError(body.error?.message ?? `Request failed (${response.status})`, response.status);
  return body as T;
}
export async function command<T>(operation: string, payload: object, expectedState?: string): Promise<T> {
  const csrf = document.cookie.split("; ").find((cookie) => cookie.startsWith("csrftoken="))?.split("=")[1];
  const response = await fetch("/api/v0/operations", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRFToken": decodeURIComponent(csrf ?? "") }, body: JSON.stringify({ operation, payload, request_id: randomUUID(), idempotency_key: randomUUID(), expected_state: expectedState }) });
  const body = await response.json();
  if (!response.ok) throw new PackRequestError(body.error?.message ?? `Operation failed (${response.status})`, response.status);
  return body.result as T;
}
