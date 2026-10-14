import { ApiError, runOperation } from '../workspace/api';
import type { ExportOutput, ExportRequest, ScopeQuantity } from '../export-packages/api';
import type { RightsReview } from '../selected-packages/api';
export { ApiError, requestJson } from '../workspace/api';
export { candidates } from '../export-packages/api';
export type { RightsReview } from '../selected-packages/api';

export type ReleaseRequest = ExportRequest & { resolved_configuration_ids: string[]; rights_reviews: RightsReview[] };
export type UnresolvedItem = { id: string; category: 'quantity' | 'artifacts' | 'configuration' | 'dependencies' | 'evidence' | 'rights'; reason: string; [key: string]: unknown };
export type ReleasedRevision = {
  revision_id: string; definition_id: string; kind: string; name: string; number: number; snapshot_sha256: string;
  role: 'root' | 'occurrence' | 'dependency'; per_root_occurrences: number | null; scope_quantity: ScopeQuantity; later_revision_number: number | null;
};
export type RightsSubject = { subject: string; kind: 'design' | 'source_file'; revision_id: string; path?: string; declared_rights: string | null; review: RightsReview };
export type ReleaseReviewBody = {
  root: { revision_id: string; name: string; kind: string; number: number; sha256: string };
  quantity: { status: 'known' | 'unknown'; amount: number | null };
  revisions: ReleasedRevision[];
  configurations: { resolved_configuration_id: string; status: string; constraint_outcome: string; target_revision_id: string | null; resolution_sha256: string }[];
  dependencies: { revisions: ReleasedRevision[]; sources: { source_revision_id: string; path: string; sha256: string; declared_rights: string }[]; opaque_source_revision_ids: string[] };
  artifacts: { package_manifest_sha256: string; coherence: 'coherent' | 'incoherent' | 'unknown'; completeness: 'complete' | 'limited'; outputs: ExportOutput[]; files: { path: string; sha256: string; bytes: number }[]; unsupported: { id: string; section: string; reason: string }[] };
  rights: { subjects: RightsSubject[]; cleared: number; uncleared: number };
  evidence: { items: { revision_id: string; evidence_id: string; kind: string; status: string }[]; counts: Record<string, number>; evaluated_revisions: number; not_evaluated_revisions: number };
  unresolved: UnresolvedItem[];
  blockers: UnresolvedItem[];
  status: 'clear' | 'unresolved' | 'blocked';
};
export type ReleaseReview = { review: ReleaseReviewBody; sha256: string };
export type ReleaseSummary = {
  release_id: string; workspace_id: string; name: string; root: ReleaseReviewBody['root']; status: ReleaseReviewBody['status'];
  unresolved_count: number; acknowledged: boolean; record_sha256: string; released_by: string; released_at: string;
};
export type ReleaseRecord = ReleaseSummary & {
  record: { name: string; notes: string; review: ReleaseReviewBody; review_sha256: string; acknowledgement: { reason: string; unresolved_ids: string[] } | null; archive: { sha256: string; bytes: number; manifest_sha256: string } };
  archive_sha256: string; archive_bytes: number;
};
export type Verification = { release_id: string; status: 'verified' | 'problems'; reconstruction: 'identical' | 'differs' | 'unavailable'; problems: string[]; pins: number; configurations: number };
export type ResolvedSummary = { resolved_configuration_id: string; status: string; basis: string; created_at: string; constraint_outcome: string };

export async function reviewRelease(request: ReleaseRequest) {
  return (await runOperation<ReleaseReview>('release.review', request)).result;
}

export async function createRelease(request: ReleaseRequest, extra: { name: string; notes: string; reviewed_sha256: string; acknowledgement: { reason: string } | null; project_id: string | null }, idempotencyKey: string) {
  return (await runOperation<ReleaseRecord>('release.create', { ...request, ...extra }, { idempotencyKey })).result;
}

export async function listReleases(workspaceId: string, projectId: string | null) {
  return (await runOperation<{ releases: ReleaseSummary[]; total: number }>('release.list', { workspace_id: workspaceId, project_id: projectId })).result;
}

export async function readRelease(releaseId: string) {
  return (await runOperation<ReleaseRecord>('release.read', { release_id: releaseId })).result;
}

export async function verifyRelease(releaseId: string) {
  return (await runOperation<Verification>('release.verify', { release_id: releaseId })).result;
}

export async function listConfigurations(workspaceId: string) {
  return (await runOperation<{ resolved: ResolvedSummary[]; truncated: boolean }>('configuration.list_resolved', { workspace_id: workspaceId })).result;
}

function csrfToken() {
  return decodeURIComponent(document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith('csrftoken='))?.slice(10) ?? '');
}

/** The exact retained archive under current access. */
export async function downloadRelease(releaseId: string) {
  const response = await fetch('/api/v0/releases/download', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrfToken() },
    body: JSON.stringify({ release_id: releaseId }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(response.status, body?.error?.message ?? `Download failed (${response.status}).`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = 'release-package.zip'; link.click();
  URL.revokeObjectURL(url);
}
