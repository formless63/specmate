import { ApiError, runOperation } from '../workspace/api';
export { requestJson, ApiError } from '../workspace/api';

export type ExportRequest = {
  root_revision_id: string; quantity: number | null; bom_plan_revision_id: string | null;
  bom_purpose: 'procurement' | 'assembly_contents' | 'pcb_fabrication' | 'pcb_population' | 'consumables';
  preparation_document_set_ids: string[]; test_plan_revision_ids: string[];
  pcb_fabrication_builds: { intake_id: string; build_id: string }[]; scene_drawing_ids: string[];
  purpose: 'authorized_review';
};
export type ScopeQuantity = { status: 'known' | 'unknown' | 'not_applicable'; amount: number | null; per_root?: number };
export type Pin = { revision_id: string; definition_id: string; kind: string; name: string; number: number; sha256: string; per_root_occurrences: number | null; scope_quantity: ScopeQuantity };
export type Finding = { status: 'incoherent' | 'unknown'; reason: string; [key: string]: unknown };
export type ExportOutput = {
  id: string; section: string; kind: string; coherence: 'coherent' | 'incoherent' | 'unknown';
  cited_revisions: { revision_id: string; definition_id: string; status: 'pinned' | 'conflict' | 'supplementary' }[];
  scope_quantity: ScopeQuantity | null; findings: Finding[]; files: string[];
};
export type Manifest = {
  scope: { root: Omit<Pin, 'per_root_occurrences' | 'scope_quantity'>; quantity: number | null; quantity_status: 'known' | 'unknown' };
  pins: Pin[]; sections: Record<string, { status: string; [key: string]: unknown }>; outputs: ExportOutput[];
  coherence: 'coherent' | 'incoherent' | 'unknown'; completeness: 'complete' | 'limited';
  unresolved: { output: string; reason: string }[]; unsupported: { id: string; section: string; reason: string }[];
  files: { path: string; sha256: string; bytes: number; section: string }[];
};
export type Review = { manifest: Manifest; sha256: string };

export async function review(request: ExportRequest) {
  return (await runOperation<Review>('export_package.review', request)).result;
}

/** A fresh authorized download; the server refuses a changed review or incoherent outputs. */
function csrfToken() {
  return decodeURIComponent(document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith('csrftoken='))?.slice(10) ?? '');
}

export async function download(request: ExportRequest, sha256: string) {
  const response = await fetch('/api/v0/export-packages/download', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrfToken() },
    body: JSON.stringify({ ...request, reviewed_sha256: sha256 }),
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
  link.href = url; link.download = 'export-package.zip'; link.click();
  URL.revokeObjectURL(url);
}
