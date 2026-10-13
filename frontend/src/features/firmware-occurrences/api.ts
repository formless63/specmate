import { randomUUID } from '../../lib/random-id';
import type { FirmwareRead } from '../firmware/api';

export type Owner = { draft_id?: string; snapshot_id?: string };
export type OccurrenceInspection = {
  draft_id: string | null; snapshot_id: string | null; state: string | null;
  occurrences: { path: string[]; display_ref: string; name: string; kind: string; revision_id: string;
    snapshot_sha256: string; firmware_revision_id: string | null }[];
  adoptions: { adoption_id: string; path: string[]; basis: string; created_at: string }[];
  history_truncated: boolean;
};
export type Selection = { draft_id: string; path: string[]; firmware_revision_id: string | null };
export type SelectionReview = Selection & {
  state: string; review_sha256: string; occurrence_revision_id: string; occurrence_snapshot_sha256: string;
  display_ref: string; eligible: boolean; message: string; previous: FirmwareRead | null; candidate: FirmwareRead | null;
};
export type Adoption = { adoption_id: string; draft_id: string; basis: string; path: string[]; review: SelectionReview };
export type Submission = { payload: Selection & { review_sha256: string; basis: string }; state: string; key: string };

export async function operation<T>(name: string, payload: object, submission?: Pick<Submission, 'state' | 'key'>): Promise<T> {
  const csrf = document.cookie.split('; ').find((cookie) => cookie.startsWith('csrftoken='))?.split('=')[1];
  const response = await fetch('/api/v0/operations', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRFToken': decodeURIComponent(csrf ?? '') },
    body: JSON.stringify({ operation: name, payload, request_id: randomUUID(),
      ...(submission ? { expected_state: submission.state, idempotency_key: submission.key } : {}) }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? `Operation failed (${response.status})`);
  return body.result as T;
}
