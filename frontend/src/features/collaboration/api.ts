import { command, request } from '../sources/api';
export { type Definition, type Identity } from '../identity/api';
export { SourceError } from '../sources/api';
export type Pin = { revision_id: string; definition_id: string; workspace_id: string; name: string; kind: string; number: number; sha256: string };
export type Pair = { old_revision_id: string; candidate_revision_id: string };
export type Page<T> = { results: T[]; next_after: string | null };
export type Comparison = {
  old: Pin; candidate: Pin; identity_relation: string;
  changes: { path: (string | number)[]; change: string; old_present: boolean; candidate_present: boolean; old: unknown; candidate: unknown }[];
  next_changes_offset: number | null; parents_side: 'old' | 'candidate'; parent_scope: string;
  parents: Page<{ snapshot_id: string; label: string; definition_id: string; workspace_id: string }> & { project_references?: { reference_id: string; project_name: string; relation: string; role: string }[] };
  dependency_pins: { old: string[]; candidate: string[] }; limitations: string[];
};
export type Evidence = { status: 'unknown' | 'unverified_citation' | 'registered_file'; citation?: string | null; source_bundle_revision_id?: string | null; source_path?: string | null; sha256?: string | null; rights?: string | null };
export type Review = {
  review_id: string; workspace_id: string; project_id: string | null; in_project?: boolean; title: string; old: Pin; candidate: Pin; state: string; status: string;
  recipients: { user_id: string; username: string }[];
  knowledge: { item_id: string; number: number; title: string; body: string; attachments: { path: string; sha256: string; rights: string }[] } | null;
  entries: { entry_id: string; number: number; action: string; basis: string; author: string; created_at: string; evidence: Evidence; upgrade_proposal_id: string | null }[];
  comparison?: Comparison;
};
export type Notification = { notification_id: string; review_id: string; title: string; action: string; state: string; read_at: string | null; old: Pin; candidate: Pin };
export const read = request;
export const fresh = <T>(operation: string, payload: object) => command<T>(operation, payload, { idempotent: false });
export const mutate = <T>(operation: string, payload: object, expectedState: string | undefined, key: string) => command<T>(operation, payload, { expectedState, idempotencyKey: key });
