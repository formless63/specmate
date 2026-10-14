import { type Firmware } from '../firmware/api';
import { operation, type ResolvedSummary } from '../configurations/api';
import { request } from '../sources/api';

export type FirmwareBuildRef = { firmware_revision_id: string; assembly_snapshot_id?: string | null; path?: string[] };
export type CompilerInputs = Firmware & {
  adapter: string; firmware_revision_id: string; firmware_snapshot_sha256: string;
  occurrence: { assembly_snapshot_id: string; assembly_snapshot_sha256: string; path: string[]; population_revision_id: string; population_snapshot_sha256: string } | null;
};
export type CompileOptions = {
  workspace_id: string; inputs: CompilerInputs; available_recipe_id: string | null; unavailable_reason: string | null;
  builds: { build_id: string; state: string; failure: string | null; retry_of: string | null; requested_by_viewer: boolean; state_token: string; cancel_available: boolean; retry_available: boolean }[]; truncated: boolean;
};
export type CompileReview = {
  reference: FirmwareBuildRef & { build_id: string }; retry_of: string | null;
  lineage: { build_id: string; state: string; current: boolean }[]; inputs: CompilerInputs; image: string; recipe_id: string; report_sha256: string;
  report: { compiler_version: string; tool_packages: Record<string, string>; physical_qualification: false; flashing: 'not_performed'; device_operation: 'not_observed'; hardware_compatibility: 'not_evaluated' };
  outputs: { output_id: string; path: string; sha256: string; size: number; rights: string; media_type: string }[];
};
function base(ref: FirmwareBuildRef, suffix = '') {
  const query = new URLSearchParams();
  if (ref.assembly_snapshot_id) query.set('assembly_snapshot_id', ref.assembly_snapshot_id);
  if (ref.path?.length) query.set('path', ref.path.join('/'));
  return `firmware-builds/firmware/${encodeURIComponent(ref.firmware_revision_id)}${suffix}${query.size ? `?${query}` : ''}`;
}
export const compileOptions = (ref: FirmwareBuildRef, signal: AbortSignal) => request<CompileOptions>(base(ref), { signal });
export const compileReview = (ref: FirmwareBuildRef, buildId: string, signal: AbortSignal) => request<CompileReview>(base(ref, `/builds/${encodeURIComponent(buildId)}`), { signal });
export const compileOutputUrl = (item: CompileReview, outputId: string) => `/api/v0/${base(item.reference, `/builds/${encodeURIComponent(item.reference.build_id)}/outputs/${encodeURIComponent(outputId)}`)}`;
export type ResolvedChoices = { resolved: ResolvedSummary[]; truncated: boolean };
export const listResolvedConfigurations = (workspaceId: string) =>
  operation<ResolvedChoices>('configuration.list_resolved', { workspace_id: workspaceId });
