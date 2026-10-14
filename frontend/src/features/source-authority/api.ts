export type Point = [number, number];
export type OutlineValue = { outline: Point[][] | null; cutouts: Point[][] | null; reason?: string[] };
export type OutlineSummary =
  | { status: 'known'; outline_polygons: number; cutouts: number; vertices: number; bbox_mm: [number, number, number, number]; net_area_mm2: number; geometry?: 'exact-arcs'; tolerance_mm?: number; arcs?: number; circles?: number }
  | { status: 'unknown'; reason: string[] };
export type Candidate = {
  interpretation_id: string; report_sha256: string; build_id: string; source_revision_id: string; source_path: string;
  source_sha256: string; adapter: string; tool_version: string; status: 'known' | 'unknown'; value_sha256: string;
  summary: OutlineSummary; accepted_at: string; bundle_id?: string; bundle_name?: string; differs_from_projection?: boolean | null;
};
export type Projection = {
  projection_id: string; version: number; interpretation_id: string; attempt_id: string; build_id: string; output_id: string;
  adapter: string; tool_version: string; native_format_version: number; source_revision_id: string; source_number: number;
  source_path: string; source_sha256: string; report_sha256: string; status: 'known' | 'unknown'; value: OutlineValue;
  value_sha256: string; summary: OutlineSummary; previous_projection_id: string | null;
  changes: { kind: 'initial' | 'changed' | 'unchanged'; before: OutlineSummary | null; after: OutlineSummary; vertices?: { added: number; removed: number } | null };
  basis: string; reconciled_by: string; created_at: string;
};
export type AuthorityStatus = 'unreconciled' | 'current' | 'stale' | 'conflicting';
export type Authority = {
  authority_id: string; workspace_id: string; property: 'pcb.board_outline'; extractor: string; state: string; version: number; basis: string;
  lineage_root_bundle_id: string;
  owner: { bundle_id: string; name: string; role: 'original' | 'derivative'; path: string; head_revision_id: string; head_number: number;
    head_manifest_sha256: string; head_file_sha256: string | null; head_file_rights: string | null; head_file_present: boolean; editable: boolean; handoff_url: string };
  status: AuthorityStatus; projection: Projection | null; head_candidates: Candidate[]; head_candidates_agree: boolean | null;
  non_owner_evidence: { items: Candidate[]; truncated: boolean }; history: Projection[];
  owner_changes: { version: number; owner_revision_id: string; owner_bundle_id: string; owner_path: string; basis: string; changed_by: string; created_at: string }[];
  editable_copy: string; physical_qualification: false;
};
export type AuthoritySummary = {
  authority_id: string; property: string; owner_bundle_name: string; owner_path: string; state: string; head_revision_id: string;
  projection_current: boolean; projection_status: 'known' | 'unknown' | null;
};
