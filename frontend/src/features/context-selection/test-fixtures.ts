import type { Feature, SceneNode } from '../shared-scene/api';
import { syntheticScene } from '../shared-scene/test-fixtures';
import type { LoadedBom } from './reads';

export function contextScene() {
  const scene = syntheticScene();
  scene.nodes.forEach(node => { node.features[0]!.data.id = 'one'; });
  for (const side of ['left', 'right']) {
    const base = scene.nodes.find(n => n.address.path[0] === side)!;
    const address = { snapshot_id: scene.snapshot_id, path: [side, 'cable'] };
    const feature: Feature = { feature_id: 'endpoint:a', role: 'endpoint', label: 'U1', data: { local_id: 'a', body_revision_id: 'body-r1', pinout_revision_id: 'pinout-r1' }, geometry_id: null,
      address: { ...address, feature_id: 'endpoint:a' }, placement_status: 'unknown', local_transform: null, world_transform: null };
    const cable: SceneNode = { ...structuredClone(base), address, node_id: side + '-cable', revision_id: 'cable-r1', definition_id: 'cable', kind: 'cable', name: 'Repeated synthetic cable', display_ref: 'J1',
      firmware: null, assignments: {}, geometry_ids: [], features: [feature], provenance: [], limitations: ['Installed route unknown.'] };
    scene.nodes.push(cable);
    scene.relationships.push({ kind: 'electrical', local_id: side + '-declared-link', context_path: [],
      a: { kind: 'occurrence', path: [side, 'board'], feature_id: 'component:one' },
      b: { kind: 'occurrence', path: [side, 'cable'], feature_id: 'endpoint:a' } });
  }
  return scene;
}
export function contextBom(): LoadedBom {
  const scene = contextScene();
  return { root: { revision_id: scene.root.revision_id, snapshot_id: scene.snapshot_id, sha256: scene.sha256 },
    inspection: { revision_id: 'bom-r1', snapshot_id: 'independent-bom-snapshot', sha256: 'd'.repeat(64), purpose: 'assembly_contents', status: 'resolved',
      bom: { schema_version: '0.1', assembly_revision_id: scene.root.revision_id, quantity: { status: 'known', amount: 2, unit: 'ea' }, scope_paths: [], policies: [], needs: [] },
      rows: scene.nodes.slice(0, 2).map(node => ({ address: node.address, revision_id: node.revision_id, name: node.name,
        quantity: { status: 'known', amount: 2, unit: 'ea' }, reason: 'retained_occurrence', basis: null, need_id: null })),
      boundaries: [], unresolved: [], excluded_needs: [], limitations: ['No physical qualification.'] } };
}
