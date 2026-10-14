import { command } from '../sources/api';
import type { BuildInput } from '../configurations/api';

/** BLD-006 levels, weakest first; one tool success is never more than provenance. */
export type ReproducibilityLevel = 'provenance' | 'rerun_recorded' | 'semantic_equality' | 'byte_reproducible';
/** The exact tool pin recorded at request time (BLD-002), never the current approval. */
export type PinnedTool = {
  recipe_id: string; image: string; image_digest: string; argv: string[]; network: string;
  limits: { cpus: number; memory_bytes: number; timeout_seconds: number; pids: number; max_output_bytes: number };
  /** Content-addressed image the runner reported for this execution; null when none was reported. */
  resolved_image_id: string | null;
};
export type Reproducibility = {
  level: ReproducibilityLevel;
  outputs: Record<string, { level: ReproducibilityLevel; attempts_compared: number; comparators: string[] }>;
};
export type ReproducibilityComparison = {
  path: string; other_build_id: string; byte_identical: boolean; comparator: string | null;
  result: 'not_needed' | 'equal' | 'different' | 'unreadable' | 'none_declared';
  level: ReproducibilityLevel; this_sha256: string; other_sha256: string; recorded_at: string;
};
export type BuildSummary = {
  build_id: string; stage_id: string; state: string; state_token: string; terminal: boolean;
  cancellation_requested: boolean; recipe_id: string; requested_at: string; retry_of: string | null; requested_by_viewer: boolean;
  reproduction_of?: string | null;
  /** Null until outputs are accepted. */
  reproducibility?: ReproducibilityLevel | null;
};
export type BuildList = { builds: BuildSummary[]; truncated: boolean };
export type BuildReceipt = {
  outcome: string; exit_code: number | null; message: string;
  outputs: { path: string; sha256: string }[];
  resolution?: string; termination_confirmed?: boolean; cancellation_requested?: boolean; basis?: string;
  // Username of the person who resolved it; never an internal ID.
  resolved_by?: string | null;
} | null;
export type BuildHistory = {
  build_id: string; state: string; state_token: string; receipt: BuildReceipt;
  recipe_id: string; source_revision_id: string; requested_at: string;
  retry_of: string | null; retried_by: string | null; requested_by_viewer: boolean;
  lineage: { build_id: string; state: string; current: boolean }[];
  events: { kind: string; at: string; detail: Record<string, unknown> }[];
  outputs: { path: string; sha256: string; size: number; rights: string; accepted: boolean; reproducibility?: ReproducibilityLevel | null }[];
  pinned?: PinnedTool;
  /** Null until outputs are accepted. */
  reproducibility?: Reproducibility | null;
  comparisons?: ReproducibilityComparison[];
  reproduction_of?: string | null;
  reproductions?: string[];
  reproduce_available?: boolean;
  /** Per-file rights as staged; null for attempts recorded before rights were retained. */
  staged_inputs: { path: string; sha256: string; bytes: number; media_type: string; rights: string }[] | null;
  /** Conservative rights of outputs: the most restrictive input rights, or unknown. */
  output_rights: { rights: string; basis: 'uniform' | 'most_restrictive' | 'unknown' };
  cancel_available: boolean; retry_available: boolean; abandon_available: boolean;
  awaiting_runner_confirmation: boolean;
  /** Exact resolved configuration input pinned at request time; null when none was pinned. */
  configuration: BuildInput | null;
};

const read = { idempotent: false } as const;
export const listBuilds = (workspaceId: string) => command<BuildList>('build.list', { workspace_id: workspaceId }, read);
export const readHistory = (buildId: string) => command<BuildHistory>('build.history', { build_id: buildId }, read);
export const cancelBuild = (buildId: string, expectedState: string, idempotencyKey: string) =>
  command<unknown>('build.cancel', { build_id: buildId }, { expectedState, idempotencyKey });
export const retryBuild = (buildId: string, expectedState: string, idempotencyKey: string) =>
  command<{ build_id: string }>('build.retry', { build_id: buildId }, { expectedState, idempotencyKey });
export const abandonBuild = (buildId: string, basis: string, expectedState: string, idempotencyKey: string) =>
  command<unknown>('build.abandon', { build_id: buildId, basis }, { expectedState, idempotencyKey });
export const reproduceBuild = (buildId: string, expectedState: string, idempotencyKey: string) =>
  command<{ build_id: string; reproduction_of: string }>('build.reproduce', { build_id: buildId }, { expectedState, idempotencyKey });

/** The exact request a reusable result must match (BLD-005); same shape as build.request. */
export type ReuseRequest = { workspace_id: string; source_revision_id: string; recipe_id: string; resolved_configuration_id?: string | null };
export type ReusableOutput = { output_id: string; path: string; sha256: string; size: number; media_type: string; rights: string };
export type ReusableResult = {
  build_id: string; state: string; state_token: string; created_at: string;
  /** Derived from recorded comparisons; null only if nothing was accepted. */
  reproducibility: ReproducibilityLevel | null;
  outputs: ReusableOutput[];
};
const reuseBody = (request: ReuseRequest) => ({
  workspace_id: request.workspace_id, source_revision_id: request.source_revision_id, recipe_id: request.recipe_id,
  ...(request.resolved_configuration_id ? { resolved_configuration_id: request.resolved_configuration_id } : {}),
});
export const findReusable = (request: ReuseRequest) =>
  command<{ reusable: ReusableResult | null }>('build.find_reusable', reuseBody(request), read);
export const reuseResult = (request: ReuseRequest, buildId: string) =>
  command<ReusableResult & { reuse_id: string }>('build.reuse', { ...reuseBody(request), result_build_id: buildId }, read);
export const reusedOutputUrl = (reuseId: string, outputId: string) =>
  `/api/v0/builds/reuse/${encodeURIComponent(reuseId)}/outputs/${encodeURIComponent(outputId)}`;
