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
export async function command<T>(operation: string, payload: object): Promise<T> {
  return (await request<{ result: T }>('operations', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf() },
    body: JSON.stringify({ operation, payload, request_id: randomUUID(), idempotency_key: randomUUID() }),
  })).result;
}
export async function preserve(projectId: string, file: File, name: string, rights: string) {
  const content = await file.arrayBuffer();
  const sha256 = await sha256Hex(content);
  const form = new FormData();
  for (const [key, value] of Object.entries({ request_id: randomUUID(), sha256, size: `${file.size}`, media_type: 'application/octet-stream' })) form.set(key, value);
  form.set('content', file);
  await request(`projects/${encodeURIComponent(projectId)}/blobs`, { method: 'POST', headers: { 'X-CSRFToken': csrf() }, body: form });
  return command<{ revision_id: string }>('source.create_original_bundle', {
    project_id: projectId, name, files: [{ path: file.name, sha256, media_type: 'application/octet-stream', rights }],
  });
}
