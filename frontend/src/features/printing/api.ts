import { command, request } from '../sources/api';
import type { Basis, Source, Suggestion } from '../workshop-profiles/api';

export type { Basis, Source, Suggestion };
export type Technology = 'fdm' | 'resin';
export type Role = 'printer' | 'process' | 'material';
export const ROLES: Role[] = ['printer', 'process', 'material'];
export type ParameterValue = number | string;

export type ParameterSpec = {
  technology: Technology; role: Role; key: string; label: string; type: 'number' | 'integer' | 'choice';
  unit: string | null; minimum: number | null; maximum: number | null; choices: string[];
  slicer_setting: string | null; required_for_slicing: boolean;
};
/** A named preset inside the pinned OrcaSlicer release; referenced by name, never copied. */
export type VendorPreset = { tool: 'orcaslicer-2.4.2'; vendor: string; bundle_version: string; name: string };
export type OrcaPresetSet = { key: string; label: string } & Record<Role, VendorPreset>;
export type PrintProfile = {
  schema_version: '1'; role: Role; technology: Technology;
  parameters: Record<string, Suggestion<ParameterValue>>; vendor_preset?: VendorPreset | null; limitations: string[];
};
export type SlicerTool = 'orcaslicer-2.4.2' | 'prusaslicer-2.5.0';
export type ParameterRow = {
  role: Role; key: string; label: string; unit: string | null; type: ParameterSpec['type'];
  slicer_setting: string | null; required_for_slicing: boolean; status: 'declared' | 'unknown';
  value: ParameterValue | null; basis: Basis; source: Source | null; note: string | null;
  profile_name?: string; profile_revision_id?: string; profile_revision_number?: number;
};
type RecordBase = {
  definition_id: string; workspace_id: string; name: string; draft_id: string | null; state: string | null;
  base_revision_id: string | null; revision_id: string | null; revision_number: number | null; snapshot_sha256: string | null;
};
export type ProfileRecord = RecordBase & { content: { print_profile?: PrintProfile }; in_project?: boolean };
export type ProfileRead = ProfileRecord & { parameters: ParameterRow[] };
export type RevisionRow = { revision_id: string; number: number; sha256: string; frozen_at: string };

export type Pin = { revision_id: string; snapshot_sha256: string };
export type Orientation = { status: 'unknown' | 'as_modelled' | 'rotated'; rotation_deg: [number, number, number] | null; basis: string | null };
export type Supports = { status: 'unknown' | 'none' | 'auto' | 'buildplate_only'; basis: string | null };
export type PrintPreparation = {
  schema_version: '1'; variant_label: string; technology: Technology;
  part: { mechanical_revision_id: string; snapshot_sha256: string; source_local_id: string; path: string };
  model_units: Suggestion<'mm' | 'in'>;
  profiles: Record<Role, Pin>;
  orientation: Orientation; supports: Supports; copies: number; output_format: 'gcode' | '3mf';
  slicer_tool: SlicerTool; limitations: string[];
};
export type PreparationRecord = RecordBase & { content: { print_preparation?: PrintPreparation }; in_project?: boolean };
export type Status = { printable: 'not_evaluated'; printer_submission: 'not_available'; physical_qualification: false };
export type PreparationRead = PreparationRecord & Status & {
  part_identity: null | {
    mechanical_definition_id: string; name: string; item_role: string; revision_number: number;
    model: { path: string; sha256: string; rights: string; format: string; source_revision_id: string };
  };
  parameters: ParameterRow[];
  slicing: null | {
    tool_id: string; blockers: string[]; requires_frozen_revision: boolean;
    configuration?: Record<string, unknown>; declared_settings?: string[]; tool_default_settings?: string[]; configuration_sha256?: string;
    presets?: Partial<Record<Role, Omit<VendorPreset, 'tool'>>>; preset_settings?: string[]; not_sent_settings?: string[];
  };
};
export type Variant = RecordBase & { variant_label: string; technology: Technology; mechanical_revision_id: string; model_path: string };

export type Tool = { id: string; name: string; package: string; package_version: string };
export type SliceOptions = Status & {
  preparation_revision_id: string; recipe_id: string | null; available_recipe_id: string | null;
  unavailable_reason: string | null; tool: Tool; proposed_recipe: Record<string, unknown> | null;
  builds: { build_id: string; state: string; failure: string | null; exit_code: number | null }[];
};
export type Estimate = { value: number | null; status: 'slicer_estimate' | 'unknown' };
export type SliceRead = Status & {
  preparation_revision_id: string; build_id: string; recipe_id: string; image: string; report_sha256: string;
  inputs: { tool: Tool; profiles: Record<Role, Pin>; part: { path: string; sha256: string; rights: string };
    declared: string[]; tool_defaults: string[]; config: Record<string, string> };
  report: { estimates: { print_time_s: Estimate; filament_length_mm: Estimate; filament_mass_g: Estimate;
      layer_count?: Estimate; filament_volume_cm3?: Estimate; model_print_time_s?: Estimate };
    applied_settings?: Record<string, string | null>;
    printable: 'not_evaluated'; printer_submission: 'not_performed'; physical_qualification: false };
  outputs: { output_id: string; path: string; sha256: string; size: number; rights: string; media_type: string }[];
};

export type MechanicalRecords = { records: { definition_id: string; name: string; revisions: { revision_id: string; number: number }[] }[] };
export type MechanicalRevision = { definition_id: string; name: string; revision_id: string; snapshot_sha256: string;
  content: { mechanical_source: { sources: { local_id: string; files: { path: string; role: string; format: string }[] }[] } } };

const scope = (projectId?: string | null) => projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
const id = encodeURIComponent;

export const listParameters = () => request<ParameterSpec[]>('printing/parameters');
export const listOrcaPresets = () => request<OrcaPresetSet[]>('printing/orca-presets');
export const listProfiles = (projectId?: string | null) => request<ProfileRecord[]>(`printing/profiles${scope(projectId)}`);
export const listPreparations = (projectId?: string | null) => request<PreparationRecord[]>(`printing/preparations${scope(projectId)}`);
export const listProfileRevisions = (definitionId: string) => request<RevisionRow[]>(`printing/profiles/${id(definitionId)}/revisions`);
export const listPreparationRevisions = (definitionId: string) => request<RevisionRow[]>(`printing/preparations/${id(definitionId)}/revisions`);
export const listMechanical = (workspaceId: string) => request<MechanicalRecords>(`mechanical-sources/workspaces/${id(workspaceId)}/records`);
export const readMechanicalRevision = (revisionId: string) => request<MechanicalRevision>(`mechanical-sources/revisions/${id(revisionId)}`);
export const sliceOptions = (revisionId: string) => request<SliceOptions>(`printing/preparation-revisions/${id(revisionId)}/slicing`);
export const sliceRead = (revisionId: string, buildId: string) => request<SliceRead>(`printing/preparation-revisions/${id(revisionId)}/slices/${id(buildId)}`);
export const sliceOutputUrl = (item: SliceRead, outputId: string) =>
  `/api/v0/printing/preparation-revisions/${id(item.preparation_revision_id)}/slices/${id(item.build_id)}/outputs/${id(outputId)}`;

type Ref = { draft_id: string } | { revision_id: string };
export const readProfile = (ref: Ref) => command<ProfileRead>('print_profile.read', ref, { idempotent: false });
export const readPreparation = (ref: Ref) => command<PreparationRead>('print_preparation.read', ref, { idempotent: false });
export const variantsOf = (mechanicalDefinitionId: string) =>
  command<{ variants: Variant[] }>('print_preparation.variants', { mechanical_definition_id: mechanicalDefinitionId }, { idempotent: false });

/** New records join the workspace library; the server resolves the actor's workspace. */
export function saveProfile(name: string, profile: PrintProfile, current: { draft_id: string; state: string } | null) {
  return command<ProfileRecord>(current ? 'print_profile.update' : 'print_profile.create',
    current ? { draft_id: current.draft_id, print_profile: profile } : { name, print_profile: profile },
    { expectedState: current?.state });
}
export function savePreparation(name: string, preparation: PrintPreparation, current: { draft_id: string; state: string } | null) {
  return command<PreparationRecord>(current ? 'print_preparation.update' : 'print_preparation.create',
    current ? { draft_id: current.draft_id, print_preparation: preparation } : { name, print_preparation: preparation },
    { expectedState: current?.state });
}
export const freezeRecord = (operation: 'print_profile.freeze' | 'print_preparation.freeze', current: { draft_id: string; state: string }) =>
  command<{ revision_id: string; number: number; draft: { state: string } }>(operation, { draft_id: current.draft_id }, { expectedState: current.state });
export const requestSlice = (revisionId: string, recipeId: string) =>
  command<{ build_id: string }>('print_slice.request', { preparation_revision_id: revisionId, recipe_id: recipeId });
