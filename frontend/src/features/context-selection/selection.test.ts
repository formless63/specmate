import { expect, test } from 'vitest';
import { exactKey, selectedFeature, selectedNode, SelectionController } from './selection';
import { contextBom, contextScene } from './test-fixtures';
import { groupBomRows, validBomContext } from './reads';

const scope = { project_id: 'project-one', principal_key: 'actor-one', snapshot_id: 'root-snapshot' };
function ready() { const controller = new SelectionController(scope); const scene = contextScene(); controller.accept(controller.beginRead(), scene); return { controller, scene }; }

test('exact repeated feature selection remains scoped to the second use despite equal geometry, IDs and labels', () => {
  const { controller, scene } = ready(), before = structuredClone(scene);
  const right = scene.nodes[1]!.features[0]!.address;
  expect(controller.selectOccurrence(right)).toBe(true);
  expect(selectedNode(controller.getSnapshot())?.address.path).toEqual(['right', 'board']);
  expect(selectedFeature(controller.getSnapshot())?.feature_id).toBe('component:one');
  expect(controller.selectOccurrence({ ...right, path: ['right', 'cable'] })).toBe(false);
  expect(controller.selectOccurrence({ ...right, snapshot_id: 'other-root' })).toBe(false);
  expect(controller.selectOccurrence({ ...right, feature_id: 'U1' })).toBe(false);
  expect(exactKey((controller.getSnapshot().selection as { address: typeof right }).address)).toBe(exactKey(right));
  expect(scene).toEqual(before);
});

test('standalone reusable revision selection never resolves to either repeated occurrence', () => {
  const { controller, scene } = ready(); controller.selectOccurrence(scene.nodes[1]!.address);
  expect(controller.selectRevision('board-r1')).toBe(true);
  expect(controller.getSnapshot().selection).toEqual({ kind: 'revision', revision_id: 'board-r1' });
  expect(selectedNode(controller.getSnapshot())).toBeNull(); expect(selectedFeature(controller.getSnapshot())).toBeNull();
  expect(controller.selectRevision('not-in-closure')).toBe(false);
});

test('fresh successful recheck preserves exact selection, denial destroys intent and fences old successes', () => {
  const { controller, scene } = ready(); controller.selectOccurrence(scene.nodes[1]!.features[0]!.address);
  const refresh = controller.beginRead(); expect(controller.getSnapshot().scene).toBeNull(); expect(controller.getSnapshot().selection).toBeNull();
  controller.accept(refresh, scene); expect(selectedNode(controller.getSnapshot())?.address.path).toEqual(['right', 'board']);
  const stale = controller.beginRead(), latest = controller.beginRead();
  controller.unavailable(latest, 'Source unavailable');
  expect(controller.accept(stale, scene)).toBe(false); expect(controller.accept(latest, scene)).toBe(false);
  expect(controller.getSnapshot().scene).toBeNull(); expect(controller.getSnapshot().selection).toBeNull();
  controller.accept(controller.beginRead(), scene); expect(controller.getSnapshot().selection).toBeNull();
});

test('scope, principal and selection tickets independently fence old adapter replies and denials', () => {
  const { controller, scene } = ready(); controller.selectOccurrence(scene.nodes[0]!.address);
  const left = controller.capture(true); controller.selectOccurrence(scene.nodes[1]!.address);
  expect(controller.current(left)).toBe(false); expect(controller.unavailable(left, 'Old selected detail denial')).toBe(false);
  const other = new SelectionController({ ...scope, principal_key: 'actor-two' });
  expect(other.current(controller.capture())).toBe(false);
  const rootTicket = controller.capture(); controller.dispose(); controller.activate(); controller.accept(controller.beginRead(), scene);
  expect(controller.current(rootTicket)).toBe(false); expect(controller.accept(rootTicket, scene)).toBe(false);
});

test('wrong-root or wrong-owner projection cannot enter the shared context', () => {
  const controller = new SelectionController(scope), scene = contextScene();
  scene.nodes[1]!.features[0]!.address.path = ['left', 'board'];
  expect(controller.accept(controller.beginRead(), scene)).toBe(false); expect(controller.getSnapshot().status).toBe('unavailable');
  const another = contextScene(); another.snapshot_id = 'other-root';
  expect(controller.accept(controller.beginRead(), another)).toBe(false);
});

test('BOM mapping requires root revision, snapshot/hash and per-use pins; grouping never collapses selected uses or combines quantities', () => {
  const scene = contextScene(), bom = contextBom(), before = structuredClone(bom);
  expect(validBomContext(scene, bom)).toBe(true);
  const groups = groupBomRows(bom.inspection.rows, true);
  expect(groups).toHaveLength(1); expect(groups[0]!.rows.map(row => row.address.path)).toEqual([['left', 'board'], ['right', 'board']]);
  expect(groups[0]!.rows.map(row => row.quantity.amount)).toEqual([2, 2]); expect(bom).toEqual(before);
  for (const change of [
    (b: typeof bom) => { b.root.snapshot_id = 'other-snapshot'; },
    (b: typeof bom) => { b.root.sha256 = 'e'.repeat(64); },
    (b: typeof bom) => { b.inspection.bom.assembly_revision_id = 'other-root-revision'; },
    (b: typeof bom) => { b.inspection.rows[1]!.revision_id = 'other-board'; },
    (b: typeof bom) => { b.inspection.rows[1]!.address.snapshot_id = 'other-root'; },
  ]) { const changed = structuredClone(bom); change(changed); expect(validBomContext(scene, changed)).toBe(false); }
});
