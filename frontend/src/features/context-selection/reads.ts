/** Read adapters preserve server-owned calculations and exact contextual source pins. */
import { request, SourceError } from '../sources/api';
import type { SharedScene } from '../shared-scene/api';
import type { Inspection as BomInspection, Purpose } from '../bom/api';
import { sameOccurrence } from './selection';

export type RootPin = { revision_id: string; snapshot_id: string; sha256: string };
export type LoadedBom = { inspection: BomInspection; root: RootPin };

export async function readScene(snapshotId: string): Promise<SharedScene> {
  const definitions = await request<{ definition_id: string }[]>('workspace/definitions', { cache: 'no-store' });
  const scene = await request<SharedScene>(`shared-scenes/snapshots/${encodeURIComponent(snapshotId)}`, { cache: 'no-store' });
  if (!definitions.some(definition => definition.definition_id === scene.root.definition_id)) throw new SourceError(404, 'Scene is unavailable in this project context.');
  return scene;
}

export async function readBom(revisionId: string, purpose: Purpose): Promise<LoadedBom> {
  const inspection = await request<BomInspection>(`bom/revisions/${encodeURIComponent(revisionId)}?purpose=${purpose}`, { cache: 'no-store' });
  if (inspection.revision_id !== revisionId || inspection.purpose !== purpose) {
    throw new SourceError(422, 'Response does not match the requested exact BOM plan and purpose.');
  }
  const root = await request<RootPin>(`revisions/${encodeURIComponent(inspection.bom.assembly_revision_id)}`, { cache: 'no-store' });
  return { inspection, root };
}

export function validBomContext(scene: SharedScene, value: LoadedBom): boolean {
  if (value.inspection.bom.assembly_revision_id !== scene.root.revision_id ||
      value.root.revision_id !== scene.root.revision_id || value.root.snapshot_id !== scene.snapshot_id || value.root.sha256 !== scene.sha256) return false;
  return value.inspection.rows.every(row => {
    if (row.address.snapshot_id !== scene.snapshot_id) return false;
    const node = row.address.path.length ? scene.nodes.find(n => sameOccurrence(n.address, row.address)) : null;
    if (row.address.path.length && !node) return false;
    if (row.need_id !== null) {
      const need = value.inspection.bom.needs.find(n => n.local_id === row.need_id);
      return need !== undefined && need.revision_id === row.revision_id &&
        JSON.stringify(need.context_path) === JSON.stringify(row.address.path) &&
        (need.purpose === value.inspection.purpose || (value.inspection.purpose === 'procurement' && need.purpose !== 'consumables'));
    }
    return row.revision_id === (node?.revision_id ?? scene.root.revision_id);
  });
}

export type BomGroup = { key: string; revision_id: string; rows: BomInspection['rows'] };
export function groupBomRows(rows: BomInspection['rows'], grouped: boolean): BomGroup[] {
  const groups = new Map<string, BomGroup>();
  rows.forEach((row, index) => {
    // Supplemental demand is not an occurrence of its orderable revision.
    const key = grouped ? JSON.stringify([row.revision_id, row.need_id === null ? 'occurrence' : 'need']) : `${index}`;
    const group = groups.get(key) ?? { key, revision_id: row.revision_id, rows: [] };
    group.rows.push(row); groups.set(key, group);
  });
  return [...groups.values()];
}
