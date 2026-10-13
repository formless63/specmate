import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { readScene } from './reads';
import { scopeKey, SelectionController } from './selection';
import type { Scope, SelectionState } from './selection';

type ContextValue = { state: SelectionState; controller: SelectionController; refresh: () => Promise<void> };
const SelectionContext = createContext<ContextValue | null>(null);

/** Mount beneath the signed-in project boundary. Principal/root/project changes remount
 * the scope, immediately clearing retained data, selections and old asynchronous readers.
 */
export function ContextSelectionProvider({ scope, children, onUnavailable, authorityPending = false }: {
  scope: Scope; children: ReactNode; onUnavailable?: () => void; authorityPending?: boolean;
}) {
  return <ScopeProvider key={scopeKey(scope)} scope={scope} onUnavailable={onUnavailable} authorityPending={authorityPending}>{children}</ScopeProvider>;
}
function ScopeProvider({ scope, children, onUnavailable, authorityPending }: { scope: Scope; children: ReactNode; onUnavailable?: () => void; authorityPending: boolean }) {
  const [controller] = useState(() => new SelectionController(scope));
  const pending = useRef(authorityPending); pending.current = authorityPending;
  const wasPending = useRef(authorityPending);
  const unavailable = useRef(onUnavailable); unavailable.current = onUnavailable;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const refresh = useCallback(async () => {
    const ticket = controller.beginRead();
    if (pending.current) return;
    try {
      const scene = await readScene(scope.project_id, scope.snapshot_id);
      controller.accept(ticket, scene);
    } catch (error) {
      controller.unavailable(ticket, error instanceof Error ? error.message : 'Scene unavailable.');
    }
  }, [controller, scope.project_id, scope.snapshot_id]);
  useEffect(() => {
    controller.activate();
    void refresh();
    const focus = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { controller.dispose(); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [controller, refresh]);
  useEffect(() => {
    const previous = wasPending.current; wasPending.current = authorityPending;
    if (authorityPending || previous) void refresh();
  }, [authorityPending, refresh]);
  useEffect(() => { if (state.status === 'unavailable') unavailable.current?.(); }, [state.status, state.read_epoch]);
  return <SelectionContext.Provider value={{ state: authorityPending ? { ...state, status: 'checking', scene: null, selection: null, error: '' } : state, controller, refresh }}>{children}</SelectionContext.Provider>;
}
export function useContextSelection(): ContextValue {
  const value = useContext(SelectionContext);
  if (!value) throw new Error('Contextual view requires ContextSelectionProvider.');
  return value;
}
