import { runOperation } from '../workspace/api';
export type OptionValue = { local_id: string; label: string };
export type OptionAxis = OptionValue & { values: OptionValue[] };
export type Variant = { local_id: string; label: string | null; design_revision_id: string; number: string | null; declared_length_mm: string | null; options: Record<string, string>; note: string | null };
export type Family = { schema_version: '1'; number: string | null; options: OptionAxis[]; variants: Variant[] };
export type Exact = { definition_id: string; revision_id: string; name: string; kind: string; number: number; sha256: string };
export type LineupRow = { family: Exact; family_number: string | null; variant: Variant; selected_options: { axis_id: string; axis_label: string; value_id: string; value_label: string }[]; design: Exact; in_project?: boolean };
export type LineupPage = { results: LineupRow[]; next_after: string | null; as_of: string; basis: string };
export const blankFamily = (): Family => ({ schema_version: '1', number: null, options: [], variants: [] });
export const readLineup = (workspaceId: string, projectId: string | null, after: string | null) => runOperation<LineupPage>('products.lineup', { workspace_id: workspaceId, project_id: projectId, after }).then(response => response.result);

export type VersionsPage = { revisions: Exact[]; drafts: { draft_id: string; version: number; label: string }[]; next_offset: number | null };
export const readVersions = (definitionId: string, offset: number) => runOperation<VersionsPage>('products.versions', { definition_id: definitionId, offset }).then(response => response.result);
