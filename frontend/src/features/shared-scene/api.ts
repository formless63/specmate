import type { StockSpecification } from '../../../../packages/section-layout/src';
import type { OccurrenceRef, ProjectionNode, RelationshipKind, RevisionRef } from '../assemblies/api';
export { request, SourceError } from '../sources/api';

export type Matrix = number[][];
export type Vec3 = [number, number, number];
export type Address = { snapshot_id: string; path: string[]; feature_id?: string };
export type Pin = { revision_id: string; definition_id: string; snapshot_sha256: string; kind: string };
export type Feature = {
  feature_id: string; role: string; label: string; address: Address;
  data: Record<string, unknown>; geometry_id: string | null;
  placement_status: 'unknown'; local_transform: null; world_transform: null;
};
type GeometryBase = {
  geometry_id: string; local_id: string; owner: Pin; role: 'manufacturing' | 'clearance' | 'illustration';
  quality: string; units: string | null; frame: string | null;
  source: Record<string, unknown>; limitations: string[];
};
export type Geometry = GeometryBase & (
  { type: 'pcb_planar'; outline: Vec3[][]; cutouts: Vec3[][]; coverage: Record<string, string>; outline_bridged_gaps?: { at: Vec3; to: Vec3; size_mm: number }[] } |
  { type: 'wire_construction'; stock: StockSpecification; length_mm: string | null } |
  { type: 'unavailable_model'; millimeter_factor: number | null }
);
export type SceneNode = ProjectionNode & {
  node_id: string; parent_path: string[]; local_transform: Matrix | null; world_transform: Matrix | null;
  world_status: 'known' | 'unknown'; placement_limit: string | null;
  geometry_ids: string[]; features: Feature[]; provenance: Record<string, unknown>[];
  limitations: string[]; firmware: Pin | null;
};
export type SharedScene = {
  schema_version: '1'; snapshot_id: string; sha256: string; root: Pin & { world_transform: Matrix };
  units: 'mm'; frame: 'right_handed_z_up'; matrix_convention: string;
  nodes: SceneNode[]; geometry: Geometry[];
  relationships: ({ kind: RelationshipKind; local_id: string; context_path: string[] } & Partial<Record<'parent' | 'child' | 'a' | 'b' | 'mounted' | 'support' | 'subject' | 'source' | 'document' | 'orderable', OccurrenceRef | RevisionRef>>)[];
  qualification: { fit: 'not_evaluated'; clearance: 'not_evaluated'; manufacturing: 'not_evaluated'; physical: false };
};
/** Renderer-only input: rendering never grants frozen revision semantics. */
export type GeometryScene = Pick<SharedScene, 'snapshot_id' | 'sha256' | 'nodes' | 'geometry'>;
/** Explicit saved capture; this root deliberately has no revision identity. */
export type CapturedScenePreview = Omit<SharedScene, 'root'> & {
  root: Omit<SharedScene['root'], 'revision_id'>;
  basis: { kind: 'captured_draft'; draft_id: string; draft_version: number; snapshot_id: string; snapshot_sha256: string };
};
export type SceneChoices = { assemblies: { snapshot_id: string; revision_id: string; definition_id?: string; name: string; number: number }[]; window: string };

/** Identical display references and shared meshes never collapse contextual selection. */
export const selectionKey = (address: Address) => JSON.stringify([address.snapshot_id, address.path, address.feature_id ?? null]);
