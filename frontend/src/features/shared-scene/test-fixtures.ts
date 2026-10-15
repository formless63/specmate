import type { SharedScene, SceneNode } from './api';
import type { StockSpecification } from '../../../../packages/section-layout/src';

export const identityMatrix = (): number[][] => [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
export function syntheticScene(): SharedScene {
  const resource = {
    geometry_id: 'board-plane', local_id: 'board-plane',
    owner: { revision_id: 'board-r1', definition_id: 'board', snapshot_sha256: 'b'.repeat(64), kind: 'pcb_population' },
    type: 'pcb_planar' as const, role: 'illustration' as const, quality: 'native_extracted_planar', units: 'mm',
    frame: 'illustration plane: x/-y; depth unknown',
    source: { interpretation_id: 'interpretation-one', source_revision_id: 'source-one', source_manifest_sha256: 'c'.repeat(64), source_rights: 'MIT' },
    outline: [[[0, 0, 0], [40, 0, 0], [40, -25, 0], [0, -25, 0]]] as [number, number, number][][],
    cutouts: [], coverage: { outline: 'closed-line-polygons' }, limitations: ['Thickness and component envelopes unknown.'],
  };
  const nodes: SceneNode[] = ['left', 'right'].map((side, index) => {
    const transform = identityMatrix(); transform[0]![3] = index * 60;
    const address = { snapshot_id: 'root-snapshot', path: [side, 'board'] };
    return {
      address, node_id: `${side}-board`, definition_id: 'board', revision_id: 'board-r1', kind: 'pcb_population',
      name: 'Synthetic repeated board', display_ref: 'J1', snapshot_sha256: 'b'.repeat(64),
      parent_path: [side], placement: { status: 'known', translation: [index * 60, 0, 0], rotation_xyzw: [0, 0, 0, 1] },
      assignments: { firmware_revision_id: `firmware-${side}` },
      local_transform: transform, world_transform: transform, world_status: 'known', placement_limit: null,
      firmware: { revision_id: `firmware-${side}`, definition_id: `program-${side}`, snapshot_sha256: `${index}`, kind: 'firmware' },
      geometry_ids: ['board-plane'], features: [{
        feature_id: 'component:one', role: 'native_component', label: 'U1', data: { population: 'unknown', position: [10, 5] },
        address: { ...address, feature_id: 'component:one' }, geometry_id: null, placement_status: 'unknown', local_transform: null, world_transform: null,
      }], provenance: [{ role: 'native_board', ...resource.source }], limitations: ['Population option unknown.'],
    };
  });
  return {
    schema_version: '1', snapshot_id: 'root-snapshot', sha256: 'a'.repeat(64),
    root: { revision_id: 'root-r1', definition_id: 'root', snapshot_sha256: 'a'.repeat(64), kind: 'assembly', world_transform: identityMatrix() },
    units: 'mm', frame: 'right_handed_z_up', matrix_convention: 'row-major; column vectors; parent-from-local',
    nodes, geometry: [resource], relationships: [], qualification: { fit: 'not_evaluated', clearance: 'not_evaluated', manufacturing: 'not_evaluated', physical: false },
  };
}

export const syntheticStock = (): StockSpecification => ({
  schema_version: '1', construction: 'coax', viewed_from: 'a', facts: {},
  structure: { id: 'stock', label: 'Synthetic six millimeter tube', kind: 'group', role: 'stock', arrangement: 'concentric', pitch_mm: null, direction: 'cw', x_mm: 0, y_mm: 0, material: null, color: null, source: null, children: [
    { id: 'shell', label: 'Synthetic shell', kind: 'jacket', x_mm: 0, y_mm: 0, material: null, color: null, source: null, outer_diameter_mm: 6, inner_diameter_mm: 4, construction: 'solid', area_mm2: null },
  ] },
});
