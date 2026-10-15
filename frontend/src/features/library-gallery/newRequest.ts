import { useEffect, useRef } from "react";
import type { LibraryView } from "../shell/scope";

/**
 * "New…" from the Library home: the home navigates to a lens and asks that lens's list to open
 * its New form (the same `reveal(true)` its own New button uses). A request waits until a list
 * of that view is mounted, so a lens opened for the first time picks it up as it mounts.
 */
let pending: LibraryView | null = null;
const listeners = new Set<() => void>();

export function requestNew(view: LibraryView) {
  pending = view;
  // Let the lens become visible first, so its editor can scroll into view and take focus.
  setTimeout(() => { for (const listener of [...listeners]) listener(); }, 60);
}

export function useNewRequest(view: LibraryView, enabled: boolean, onNew: () => void) {
  const handler = useRef(onNew);
  handler.current = onNew;
  useEffect(() => {
    if (!enabled) return;
    const check = () => { if (pending === view) { pending = null; handler.current(); } };
    check();
    listeners.add(check);
    return () => { listeners.delete(check); };
  }, [view, enabled]);
}
