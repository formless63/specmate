import { sha256Hex } from "../../lib/sha256";
import { randomUUID } from "../../lib/random-id";
export type RevisionSummary = {
  revision_id: string; bundle_id: string; name: string; role: 'original' | 'derivative';
  number: number; manifest_sha256: string; derived_from: string | null;
};
export type SourceFile = { path: string; sha256: string; bytes: number; media_type: string; rights: string };
export type RevisionDetail = Omit<RevisionSummary, 'bundle_id'> & {
  expansion: { parser: string; source_revision_id: string; path: string; sha256: string; rights: string; execution: 'none' } | null;
  manifest: { ancestry: string[]; files: SourceFile[] };
  edit_submission?: EditProvenance | null;
};
export type EditSource = { kind: 'files' } | { kind: 'zip'; revision_id: string; path: string; sha256: string; parser: string };
export type EditProvenance = {
  baseline_revision_id: string; baseline_number: number; baseline_manifest_sha256: string;
  target: 'new_derivative' | 'next_revision'; source: EditSource; marker: 'matched' | 'absent';
  root_prefix: string; review_sha256: string; summary: string; execution: 'none'; validation: 'not_performed';
};
export type EditChange = 'added' | 'modified' | 'rights_changed' | 'unchanged';
export type EditReview = {
  baseline: { revision_id: string; number: number; name: string; role: 'original' | 'derivative'; manifest_sha256: string };
  source: EditSource; marker: 'matched' | 'absent'; root_prefix: string;
  files: { path: string; change: EditChange; sha256: string; bytes: number; baseline_sha256: string | null; media_type: string; rights: string | null; rights_source: 'baseline' | 'declared' | 'missing'; suggested_exclusion: boolean }[];
  removed: { path: string; baseline_sha256: string; rights: string }[];
  excluded: { path: string; sha256: string; bytes: number; suggested_exclusion: boolean }[];
  counts: Record<EditChange | 'removed' | 'excluded', number>;
  missing_rights: string[]; ready: boolean; reasons: string[]; review_sha256: string;
  head_revision_id: string; head_number: number; state: string; baseline_is_head: boolean; next_revision_allowed: boolean;
};
export type SourcePage = { revisions: RevisionSummary[]; next_after: string | null };
export class SourceError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function csrf() { return document.cookie.split('; ').find(c => c.startsWith('csrftoken='))?.slice(10) ?? ''; }
export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v0/${url}`, { ...init, credentials: 'same-origin' });
  const body = await response.json();
  if (!response.ok) throw new SourceError(response.status, body?.error?.message ?? `Request failed (${response.status})`);
  return body as T;
}
export async function command<T>(operation: string, payload: object, options: { expectedState?: string; idempotent?: boolean } = {}): Promise<T> {
  const envelope: Record<string, unknown> = { operation, payload, request_id: randomUUID() };
  if (options.idempotent !== false) envelope.idempotency_key = randomUUID();
  if (options.expectedState) envelope.expected_state = options.expectedState;
  return (await request<{ result: T }>('operations', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf() },
    body: JSON.stringify(envelope),
  })).result;
}
/** Register exact bytes in the project after hashing them locally; returns the SHA-256. */
export async function registerBlob(projectId: string, file: Blob) {
  const content = await file.arrayBuffer();
  const sha256 = await sha256Hex(content);
  const form = new FormData();
  for (const [key, value] of Object.entries({ request_id: randomUUID(), sha256, size: `${file.size}`, media_type: 'application/octet-stream' })) form.set(key, value);
  form.set('content', file);
  await request(`projects/${encodeURIComponent(projectId)}/blobs`, { method: 'POST', headers: { 'X-CSRFToken': csrf() }, body: form });
  return sha256;
}
export async function preserve(projectId: string, file: File, name: string, rights: string) {
  const sha256 = await registerBlob(projectId, file);
  return command<{ revision_id: string }>('source.create_original_bundle', {
    project_id: projectId, name, files: [{ path: file.name, sha256, media_type: 'application/octet-stream', rights }],
  });
}
