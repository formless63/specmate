import { randomUUID } from '../../lib/random-id';

export type Pin = { revision_id: string; definition_id: string; kind: string; name: string; number: number; snapshot_sha256: string };
export type DecisionStatus = 'resolved' | 'none' | 'unresolved' | 'invalid';
export type Decision = {
  option_key: string; label: string; domain: string; path: string[] | null; required: boolean;
  status: DecisionStatus; source: 'selected' | 'default' | 'explicit_none' | 'not_selected'; reason: string; compatibility: 'not_evaluated';
  choice: { key: string; label: string; value: string | null; revision: Pin | null; population_option_id?: string | null;
    declared_target?: { population_revision_id: string | null; option_id: string | null } } | null;
  base: { display_ref: string; population_revision_id: string; firmware_revision_id: string | null } | null;
};
export type Resolution = {
  option_set: Pin; target: Pin | null; decisions: Decision[];
  invalid_selections: { option_key: string; choice_key: string | null; reason: string }[];
  counts: Record<DecisionStatus, number>; status: 'complete' | 'incomplete' | 'invalid'; compatibility: 'not_evaluated';
};
export type Selection = { option_key: string; choice_key: string | null };
export type ConfigurationBody = { schema_version: string; option_set_revision_id: string; selections: Selection[] };
export type ResolvedSummary = { resolved_configuration_id: string; status: 'complete' | 'incomplete'; snapshot_id: string; resolution_sha256: string; draft_version: number; basis: string; created_at: string };
export type Available = { option_key: string; label: string; domain: string; required: boolean; default_choice: string | null; choices: { key: string; label: string }[] };
export type DraftResolution = {
  draft_id: string; state: string; content_sha256: string; review_sha256: string; resolution: Resolution;
  configuration: ConfigurationBody; available: Available[]; resolved: ResolvedSummary[]; history_truncated: boolean;
};
export type BuildInput = {
  resolved_configuration_id: string; snapshot_id: string; snapshot_sha256: string; resolution_sha256: string; option_set_revision_id: string;
  pins: { revision_id: string; sha256: string }[];
  choices: { option_key: string; domain: string; path: string[] | null; status: DecisionStatus; source: string; revision_id: string | null; population_option_id: string | null; value: string | null }[];
};
export type Submission = { payload: { draft_id: string; review_sha256: string; basis: string }; state: string; key: string };

export type Described = Pin & { population_options?: { local_id: string; name: string }[]; declared_target?: { population_revision_id: string | null; option_id: string | null } };
export type AuthoringContext = {
  target: (Pin & { occurrences: { path: string[]; display_ref: string; revision: Described; firmware_revision_id: string | null }[] }) | null;
  revisions: Described[];
};
export type AdoptionAction = 'replace_revision' | 'assign_firmware' | 'unchanged' | 'not_applicable' | 'blocked';
export type AdoptionRow = {
  option_key: string; label: string; domain: string; path: string[] | null; decision_status: DecisionStatus; source: Decision['source'];
  choice: { key: string; label: string; revision: Pin | null; population_option_id: string | null; value: string | null } | null;
  action: AdoptionAction; reason: string; selected: boolean; before: Pin | null; display_ref: string | null;
};
export type AdoptionChange = { option_key: string; path: string[]; display_ref: string | null; field: 'revision_id' | 'firmware'; before: Pin | null; after: Pin };
export type AdoptionHistory = { adoption_id: string; draft_id: string; draft_version: number; created_draft: boolean; option_keys: string[]; basis: string; created_at: string };
export type AdoptionReview = {
  resolved_configuration_id: string; resolution_sha256: string; resolution_status: 'complete' | 'incomplete'; configuration_snapshot_sha256: string; target: Pin;
  owner: { mode: 'new_draft' | 'existing_draft'; definition_id: string; draft_id: string | null; state: string | null; base_revision_id: string | null; content_sha256: string };
  option_keys: string[]; rows: AdoptionRow[]; changes: AdoptionChange[]; warnings: { path: string[]; message: string }[];
  eligible: boolean; message: string; review_sha256: string; adoptions: AdoptionHistory[]; history_truncated: boolean;
};
export type AdoptionResult = { draft_id: string; state: string; definition_id: string; adoption_id: string; created_draft: boolean; changes: AdoptionChange[] };

export async function operation<T>(name: string, payload: object, submission?: { state?: string | null; key?: string }): Promise<T> {
  const csrf = document.cookie.split('; ').find((cookie) => cookie.startsWith('csrftoken='))?.split('=')[1];
  const response = await fetch('/api/v0/operations', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRFToken': decodeURIComponent(csrf ?? '') },
    body: JSON.stringify({ operation: name, payload, request_id: randomUUID(),
      ...(submission?.state ? { expected_state: submission.state } : {}), ...(submission?.key ? { idempotency_key: submission.key } : {}) }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? `Operation failed (${response.status})`);
  return body.result as T;
}
