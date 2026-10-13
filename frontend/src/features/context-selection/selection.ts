/** Ephemeral contextual selection. It grants no authority and stores no engineering state. */
import type { Address, Feature, SceneNode, SharedScene } from '../shared-scene/api';

export type Selection =
  | { kind: 'occurrence'; address: Address }
  | { kind: 'revision'; revision_id: string };
export type Scope = { project_id: string; principal_key: string; snapshot_id: string };
export type Ticket = { scope: string; read_epoch: number; selection_epoch?: number };
export type SelectionState = {
  scope: Scope; status: 'empty' | 'checking' | 'ready' | 'unavailable';
  scene: SharedScene | null; selection: Selection | null; error: string;
  read_epoch: number; selection_epoch: number;
};
export const scopeKey = (scope: Scope) => JSON.stringify([scope.principal_key, scope.project_id, scope.snapshot_id]);
export const occurrenceKey = (address: Address) => JSON.stringify([address.snapshot_id, address.path]);
export const exactKey = (address: Address) => JSON.stringify([address.snapshot_id, address.path, address.feature_id ?? null]);
export const sameOccurrence = (a: Address, b: Address) => occurrenceKey(a) === occurrenceKey(b);

export function selectedNode(state: SelectionState): SceneNode | null {
  const selection = state.selection;
  return state.status === 'ready' && state.scene && selection?.kind === 'occurrence'
    ? state.scene.nodes.find(node => sameOccurrence(node.address, selection.address)) ?? null : null;
}
export function selectedFeature(state: SelectionState): Feature | null {
  const node = selectedNode(state), selection = state.selection;
  return node && selection?.kind === 'occurrence' && selection.address.feature_id
    ? node.features.find(feature => exactKey(feature.address) === exactKey(selection.address)) ?? null : null;
}
export function validOccurrence(scene: SharedScene, address: Address): boolean {
  if (address.snapshot_id !== scene.snapshot_id) return false;
  const node = scene.nodes.find(row => sameOccurrence(row.address, address));
  if (!node) return false;
  return !address.feature_id || node.features.some(feature =>
    feature.feature_id === address.feature_id && exactKey(feature.address) === exactKey(address));
}

function validSelection(scene: SharedScene, selection: Selection | null): Selection | null {
  if (!selection) return null;
  if (selection.kind === 'occurrence') return validOccurrence(scene, selection.address) ? selection : null;
  return scene.root.revision_id === selection.revision_id || scene.nodes.some(node =>
    node.revision_id === selection.revision_id || node.firmware?.revision_id === selection.revision_id) ? selection : null;
}
function coherentScene(scope: Scope, scene: SharedScene): boolean {
  if (scene.snapshot_id !== scope.snapshot_id || scene.root.snapshot_sha256 !== scene.sha256) return false;
  const keys = new Set<string>();
  for (const node of scene.nodes) {
    const key = occurrenceKey(node.address);
    if (node.address.snapshot_id !== scene.snapshot_id || keys.has(key)) return false;
    keys.add(key);
    if (node.features.some(feature => !sameOccurrence(feature.address, node.address) || feature.address.feature_id !== feature.feature_id)) return false;
  }
  return true;
}

/** Scope/read/selection tickets fence asynchronous adapter reads independently of labels.
 * Root refresh temporarily hides all data, retaining only private selection intent;
 * denial destroys that intent so later success cannot restore denied context.
 */
export class SelectionController {
  private value: SelectionState;
  private intent: Selection | null = null;
  private listeners = new Set<() => void>();
  private disposed = false;
  constructor(scope: Scope) {
    this.value = { scope, status: 'empty', scene: null, selection: null, error: '', read_epoch: 0, selection_epoch: 0 };
  }
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(change: Partial<SelectionState>) {
    if (this.disposed) return;
    this.value = { ...this.value, ...change }; for (const listener of this.listeners) listener();
  }
  capture(selection = false): Ticket {
    return { scope: scopeKey(this.value.scope), read_epoch: this.value.read_epoch,
      ...(selection ? { selection_epoch: this.value.selection_epoch } : {}) };
  }
  current(ticket: Ticket): boolean {
    return !this.disposed && ticket.scope === scopeKey(this.value.scope) && ticket.read_epoch === this.value.read_epoch &&
      (ticket.selection_epoch === undefined || ticket.selection_epoch === this.value.selection_epoch);
  }
  beginRead(): Ticket {
    if (this.value.selection) this.intent = this.value.selection;
    this.publish({ status: 'checking', scene: null, selection: null, error: '', read_epoch: this.value.read_epoch + 1, selection_epoch: this.value.selection_epoch + 1 });
    return this.capture();
  }
  accept(ticket: Ticket, scene: SharedScene): boolean {
    if (!this.current(ticket)) return false;
    if (!coherentScene(this.value.scope, scene)) { this.unavailable(ticket, 'Scene response does not match the exact requested context.'); return false; }
    const selection = validSelection(scene, this.intent); this.intent = selection;
    this.publish({ status: 'ready', scene, selection, error: '' }); return true;
  }
  unavailable(ticket: Ticket, error: string): boolean {
    if (!this.current(ticket)) return false;
    this.intent = null;
    this.publish({ status: 'unavailable', scene: null, selection: null, error,
      read_epoch: this.value.read_epoch + 1, selection_epoch: this.value.selection_epoch + 1 }); return true;
  }
  selectOccurrence(address: Address): boolean {
    if (!this.value.scene || this.value.status !== 'ready' || !validOccurrence(this.value.scene, address)) return false;
    this.intent = { kind: 'occurrence', address: { snapshot_id: address.snapshot_id, path: [...address.path],
      ...(address.feature_id ? { feature_id: address.feature_id } : {}) } };
    this.publish({ selection: this.intent, selection_epoch: this.value.selection_epoch + 1 }); return true;
  }
  selectRevision(revision_id: string): boolean {
    if (!this.value.scene || this.value.status !== 'ready') return false;
    const selection = validSelection(this.value.scene, { kind: 'revision', revision_id });
    if (!selection) return false;
    this.intent = selection; this.publish({ selection, selection_epoch: this.value.selection_epoch + 1 }); return true;
  }
  clear() { this.intent = null; this.publish({ selection: null, selection_epoch: this.value.selection_epoch + 1 }); }
  activate() { this.disposed = false; }
  dispose() { this.disposed = true; this.intent = null; this.value = { ...this.value, status: 'empty', scene: null, selection: null,
    read_epoch: this.value.read_epoch + 1, selection_epoch: this.value.selection_epoch + 1 }; }
}
