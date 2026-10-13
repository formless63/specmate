import { runOperation, ApiError } from '../workspace/api';
export { requestJson, type ApiError } from '../workspace/api';
export type RightsReview = { subject: string; decision: 'permitted' | 'withheld' | 'unknown'; basis: string };
export type Selection = { root_revision_id: string; occurrence_path: string[]; purpose: 'authorized_review' | 'distribution'; rights_reviews: RightsReview[] };
export type Manifest = {
  scope: { selected_revision_id: string; selected_sha256: string; root_sha256: string; occurrence_path: string[] };
  completeness: string; rights: string;
  design_revisions: { revision_id: string; kind: string; sha256: string; rights_review: RightsReview }[];
  source_files: { source_path: string; sha256: string; declared_rights: string; status: string; rights_review: RightsReview }[];
  occurrences: { path: string[]; revision_id: string; sha256: string; assignments: { firmware_revision_id?: string | null } }[];
  boundary_interfaces: { path: string[]; kind: string; boundary_exposure: string; endpoints?: unknown[]; terminals?: unknown[]; declaration?: unknown }[];
  boundary_crossings: { kind: string; selected_terminals: { path: string[]; feature_id: string | null }[]; external_contract: string }[];
  unresolved: { reason: string; subject?: string; kinds?: string[] }[];
};
export type Review = { manifest: Manifest; sha256: string };
export async function review(selection: Selection) {
  return (await runOperation<Review>('selected_package.review', selection)).result;
}
export async function download(selection: Selection, sha256: string) {
  const csrf = document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith('csrftoken='))?.slice(10) ?? '';
  const response = await fetch('/api/v0/selected-packages/download', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': decodeURIComponent(csrf) },
    body: JSON.stringify({ ...selection, reviewed_sha256: sha256 }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(response.status, body?.error?.message ?? `Download failed (${response.status}).`);
  }
  return response.blob();
}
export function saveArchive(blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = 'selected-assembly-package.zip'; link.click();
  URL.revokeObjectURL(url);
}
