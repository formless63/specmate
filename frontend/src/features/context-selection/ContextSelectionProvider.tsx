import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { readScene, type ExpectedSceneRoot } from './reads';
import { scopeKey, SelectionController } from './selection';
import { sceneAddress, sceneRelations, sceneTarget, useProbe, useRelationContributor } from '../probe';
import type { Scope, SelectionState } from './selection';

type ContextValue = { state: SelectionState; controller: SelectionController; refresh: () => Promise<void>; clearSelection: () => void };
const SelectionContext = createContext<ContextValue | null>(null);

/** Mount beneath the signed-in project boundary. Principal/root/project changes remount
 * the scope, immediately clearing retained data, selections and old asynchronous readers.
 */
export function ContextSelectionProvider({ scope, children, onUnavailable, authorityPending = false, revision = null, active = true, expectedRoot, recordKey }: {
  scope: Scope; children: ReactNode; onUnavailable?: () => void; authorityPending?: boolean; revision?: number | null; active?: boolean; expectedRoot?: ExpectedSceneRoot; recordKey?: string;
}) {
  return <ScopeProvider key={recordKey ? JSON.stringify([scope.principal_key, scope.project_id, recordKey]) : scopeKey(scope)} scope={scope} onUnavailable={onUnavailable} authorityPending={authorityPending} revision={revision} active={active} expectedRoot={expectedRoot}>{children}</ScopeProvider>;
}
function ScopeProvider({ scope, children, onUnavailable, authorityPending, revision, active, expectedRoot }: { scope: Scope; children: ReactNode; onUnavailable?: () => void; authorityPending: boolean; revision: number | null; active: boolean; expectedRoot?: ExpectedSceneRoot }) {
  const exactScope = scopeKey(scope);
  const controller = useMemo(() => new SelectionController(scope), [exactScope]);
  const pending = useRef(authorityPending || !active); pending.current = authorityPending || !active;
  const wasPending = useRef(authorityPending);
  const unavailable = useRef(onUnavailable); unavailable.current = onUnavailable;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const refresh = useCallback(async () => {
    const ticket = controller.beginRead();
    if (pending.current) return;
    try {
      const scene = await readScene(scope.snapshot_id, expectedRoot);
      controller.accept(ticket, scene);
    } catch (error) {
      controller.unavailable(ticket, error instanceof Error ? error.message : 'Scene unavailable.');
    }
  }, [controller, scope.project_id, scope.snapshot_id, expectedRoot?.definitionId, expectedRoot?.revisionId, expectedRoot?.sha256]);
  useEffect(() => { controller.activate(); return () => controller.dispose(); }, [controller]);
  useEffect(() => {
    if (!active) { controller.beginRead(); return; }
    void refresh();
    const focus = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [controller, refresh, active]);
  useEffect(() => {
    const previous = wasPending.current; wasPending.current = authorityPending;
    if (authorityPending || previous) void refresh();
  }, [authorityPending, refresh]);
  useEffect(() => { if (state.status === 'unavailable') unavailable.current?.(); }, [state.status, state.read_epoch]);
  // The shared probe (and so the URL) follows this controller's occurrence selection and vice versa.
  // Each side acts only when the other differs, so the two cannot echo. Selection is navigation
  // only; the scene was already read under current authority and the probe grants nothing.
  const shared = useProbe();
  const probe = shared?.probe ?? null, setProbe = shared?.setProbe;
  const contributor = useMemo(() => (active && state.scene ? sceneRelations(state.scene) : null), [active, state.scene]);
  useRelationContributor(contributor);
  const latest = useRef({ state, probe, setProbe, revision }); latest.current = { state, probe, setProbe, revision };
  useEffect(() => {
    if (!active) return;
    const { state: current, probe: shown, setProbe: set, revision: rev } = latest.current;
    const selection = current.selection;
    if (!set || current.status !== 'ready' || !current.scene || selection?.kind !== 'occurrence') return;
    const target = sceneTarget(current.scene, selection.address, rev);
    // The open root's exact revision belongs in the probe; when its number is unknown here, keep the probe's own.
    if (rev === null && shown && shown.object === target.object) target.rev = shown.rev;
    const same = shown && shown.object === target.object && shown.rev === target.rev && shown.path.length === target.path.length && shown.path.every((part, index) => part === target.path[index]);
    if (!same) set(target);
  }, [active, state.selection]);
  const previous = useRef(probe);
  useEffect(() => {
    if (!active) return;
    const before = previous.current; previous.current = probe;
    const { state: current } = latest.current;
    if (!probe) { if (before) controller.clear(); return; }
    if (current.status !== 'ready' || !current.scene) return;
    const address = sceneAddress(current.scene, probe);
    const selection = current.selection;
    if (!address) return;
    if (selection?.kind === 'occurrence' && JSON.stringify([selection.address.path, selection.address.feature_id ?? null]) === JSON.stringify([address.path, address.feature_id ?? null])) return;
    controller.selectOccurrence(address);
  }, [active, probe, state.status, state.scene, controller]);
  const clearSelection = useCallback(() => {
    controller.clear();
    const { state: current, probe: shown, setProbe: set } = latest.current;
    if (set && shown && current.scene && shown.object === current.scene.root.definition_id) set(null);
  }, [controller]);
  return <SelectionContext.Provider value={{ state: authorityPending || !active ? { ...state, status: 'checking', scene: null, selection: null, error: '' } : state, controller, refresh, clearSelection }}>{children}</SelectionContext.Provider>;
}
export function useContextSelection(): ContextValue {
  const value = useContext(SelectionContext);
  if (!value) throw new Error('Contextual view requires ContextSelectionProvider.');
  return value;
}
