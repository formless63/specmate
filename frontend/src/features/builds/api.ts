import { command } from '../sources/api';
import type { BuildInput } from '../configurations/api';

export type BuildSummary = {
  build_id: string; stage_id: string; state: string; state_token: string; terminal: boolean;
  cancellation_requested: boolean; recipe_id: string; requested_at: string; retry_of: string | null; requested_by_viewer: boolean;
};
export type BuildList = { builds: BuildSummary[]; truncated: boolean };
export type BuildReceipt = {
  outcome: string; exit_code: number | null; message: string;
  outputs: { path: string; sha256: string }[];
  resolution?: string; termination_confirmed?: boolean; cancellation_requested?: boolean; basis?: string;
} | null;
export type BuildHistory = {
  build_id: string; state: string; state_token: string; receipt: BuildReceipt;
  recipe_id: string; source_revision_id: string; requested_at: string;
  retry_of: string | null; retried_by: string | null; requested_by_viewer: boolean;
  lineage: { build_id: string; state: string; current: boolean }[];
  events: { kind: string; at: string; detail: Record<string, unknown> }[];
  outputs: { path: string; sha256: string; size: number; accepted: boolean }[];
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
