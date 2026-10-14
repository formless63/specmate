import { command, request } from '../sources/api';

export type Side = 'west' | 'east' | 'north' | 'south';
export type Face = 'lid' | 'floor';
export type Num = number | null;
export type Parameters = {
  shell: { board_clearance_mm: Num; wall_mm: Num; corner_radius_mm: Num; interior_height_mm: Num; board_thickness_mm: Num };
  boss: { outer_diameter_mm: Num; pilot_diameter_mm: Num; height_mm: Num; lid_clearance_diameter_mm: Num };
  mounts: { pad_id: string; use: boolean }[];
  connectors: { component_id: string; side: Side; lateral_offset_mm: Num; width_mm: Num; height_mm: Num; center_above_board_mm: Num; clearance_mm: Num }[];
  vents: { local_id: string; face: Face; slot_width_mm: Num; slot_length_mm: Num; pitch_x_mm: Num; pitch_y_mm: Num; edge_margin_mm: Num; keepout_margin_mm: Num }[];
  cable_guides: { local_id: string; side: Side; offset_along_wall_mm: Num; cable_diameter_mm: Num; clearance_mm: Num; post_width_mm: Num; post_depth_mm: Num }[];
};
export type Rect = { x0: number; y0: number; x1: number; y1: number };
export type Check = { code: string; status: 'pass' | 'fail' | 'not_evaluated'; detail: string };
export type Feature = {
  feature_id: string; kind: string; status: 'incomplete' | 'declared_inputs_complete'; unresolved: string[];
  geometry: Record<string, unknown>; parameters_used: Record<string, unknown>; checks: Check[]; notes: string[];
};
export type Unresolved = { feature_id: string; code: string; parameter: string; message: string };
export type Proposal = {
  generator: string; units: 'mm'; frame: string; status: 'incomplete' | 'declared_inputs_complete';
  features: Feature[]; unresolved: Unresolved[]; facts_used: { name: string; value: unknown; origin: string }[];
  checks_summary: { pass: number; fail: number; not_evaluated: number };
  remaining_physical_checks: string[]; limitations: string[];
  qualification: { physical: false; fit: string; clearance: string; printability: string; manufacturing: string };
  board: { interpretation_id: string; interpretation_sha256: string; source_revision_id: string; source_sha256: string; adapter: string; tool_version: string };
};
export type DecisionKind = 'accepted' | 'rejected' | 'deferred';
export type RevisionSummary = { revision_id: string; number: number; sha256: string; status: Proposal['status']; current_decision?: DecisionKind | null };
export type Decision = {
  decision_id: string; revision_id: string; version: number; decision: DecisionKind; reason: string;
  link_mode: 'created' | 'linked' | null; definition_id: string | null; draft_id: string | null; decided_by_id: number; created_at: string;
};
export type Decisions = { decision_state: string; current_decision: Decision | null; decisions: Decision[] };
export type DecidePayload = { decision: DecisionKind; reason: string; draftName?: string; linkDraftId?: string };
export type Draft = {
  draft_id: string; workspace_id: string; interpretation_id: string; name: string; parameters: Parameters;
  version: number; state: string; proposal: Proposal; revisions: RevisionSummary[]; updated_at: string;
};
export type DraftRow = { draft_id: string; name: string; interpretation_id: string; version: number; state: string; updated_at: string; revision_count: number };
export type BoardChoice = { interpretation_id: string; sha256: string; board_path: string; source_revision_id: string; outline: string; hole_candidates: number; components: number };
export type BoardInputs = {
  interpretation_id: string; sha256: string; units: string; frame: string; outline_polygons: number; cutouts: number;
  holes: { pad_id: string; position: [number, number]; drill: [number, number]; mounting_status: string }[];
  components: { component_id: string; reference: string; value: string; footprint: string; position: [number, number]; side: 'front' | 'back' }[];
};
export type Retained = Partial<Decisions> & {
  revision_id: string; draft_id: string; workspace_id: string; number: number; interpretation_id: string; interpretation_sha256: string;
  generator: string; draft_version: number; status: Proposal['status']; sha256: string; created_at: string;
  document?: { draft_id: string; draft_name: string; draft_version: number; parameters: Parameters; proposal: Proposal };
};
const base = (workspaceId: string) => `mechanical-proposals/workspaces/${encodeURIComponent(workspaceId)}`;
export const listBoards = (workspaceId: string, signal?: AbortSignal) => request<{ boards: BoardChoice[] }>(`${base(workspaceId)}/boards`, { signal, cache: 'no-store' });
export const boardInputs = (workspaceId: string, id: string, signal?: AbortSignal) => request<BoardInputs>(`${base(workspaceId)}/boards/${encodeURIComponent(id)}`, { signal, cache: 'no-store' });
export const listDrafts = (workspaceId: string, signal?: AbortSignal) => request<{ drafts: DraftRow[]; truncated: boolean }>(`${base(workspaceId)}/drafts`, { signal, cache: 'no-store' });
export const readDraft = (id: string, signal?: AbortSignal) => request<Draft>(`mechanical-proposals/drafts/${encodeURIComponent(id)}`, { signal, cache: 'no-store' });
export const readRetained = (id: string, workspaceId: string, signal?: AbortSignal) => request<Retained>(`mechanical-proposals/revisions/${encodeURIComponent(id)}?workspace_id=${encodeURIComponent(workspaceId)}`, { signal, cache: 'no-store' });
export const createDraft = (workspaceId: string, interpretationId: string, name: string, parameters: Parameters, key: string) =>
  command<Draft>('mechanical_proposal.create', { workspace_id: workspaceId, interpretation_id: interpretationId, name, parameters }, { idempotencyKey: key });
export const updateDraft = (draftId: string, parameters: Parameters, state: string, key: string) =>
  command<Draft>('mechanical_proposal.update', { draft_id: draftId, parameters }, { expectedState: state, idempotencyKey: key });
export const retainDraft = (draftId: string, state: string, key: string) =>
  command<Retained>('mechanical_proposal.retain', { draft_id: draftId }, { expectedState: state, idempotencyKey: key });
export const decideRetained = (revisionId: string, payload: DecidePayload, state: string, key: string) =>
  command<Decisions & { revision_id: string; recorded: Decision }>('mechanical_proposal.decide', {
    revision_id: revisionId, decision: payload.decision, reason: payload.reason,
    ...(payload.draftName ? { draft_name: payload.draftName } : {}),
    ...(payload.linkDraftId ? { link_draft_id: payload.linkDraftId } : {}),
  }, { expectedState: state, idempotencyKey: key });
