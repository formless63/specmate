import { createBrowserHistory, type RouterHistory } from "@tanstack/react-router";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { formatLocation, parseLocation, sameTarget, type ProbeTarget, type WorkspaceLocation } from "./url";

type Patch = Partial<Omit<WorkspaceLocation, "malformed">>;
export type NavigateOptions = { replace?: boolean };
export type Navigation = {
  location: WorkspaceLocation;
  /** Merge a change into the current location and record it (push) or rewrite it (replace). */
  navigate: (patch: Patch, options?: NavigateOptions) => void;
  history: RouterHistory;
};

const NavigationContext = createContext<Navigation | null>(null);

let shared: RouterHistory | null = null;

/**
 * One browser history per page. TanStack's history wraps the platform API, follows external
 * history changes and is the same layer TanStack Router uses, so a full route tree can adopt it later.
 */
function browserHistory(): RouterHistory {
  shared ??= createBrowserHistory();
  return shared;
}

/**
 * Owns the shell URL: area, lens, project context and probe. State changes write the URL
 * synchronously; back/forward and reload read it. Tests may pass a memory history.
 */
export function NavigationProvider({ history: given, children }: { history?: RouterHistory; children: ReactNode }) {
  const [history] = useState(() => given ?? browserHistory());
  const href = useSyncExternalStore(
    useCallback((notify: () => void) => history.subscribe(notify), [history]),
    () => history.location.href,
  );
  // The href is the store snapshot; the parsed location changes only when it does.
  const location = useMemo(() => {
    const url = new URL(href, "http://local.invalid");
    return parseLocation(url.pathname, url.search);
  }, [href]);

  // An address that does not match its canonical form (unknown area, lens in another area,
  // default lens spelled out) is rewritten in place so back/forward never revisit it.
  const canonical = formatLocation(location);
  useEffect(() => {
    if (!location.malformed && canonical !== `${history.location.pathname}${history.location.search}`) history.replace(canonical, history.location.state);
  }, [canonical, history, href, location.malformed]);

  const navigate = useCallback((patch: Patch, options: NavigateOptions = {}) => {
    const current = history.location;
    const base = parseLocation(current.pathname, current.search);
    const next = { ...base, ...patch };
    const target = formatLocation(next);
    if (target === `${current.pathname}${current.search}`) return;
    if (options.replace) history.replace(target);
    else history.push(target);
  }, [history]);

  const value = useMemo(() => ({ location, navigate, history }), [location, navigate, history]);
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

/** The shell location and its navigate function; null outside a NavigationProvider. */
export function useNavigation(): Navigation | null {
  return useContext(NavigationContext);
}

/**
 * Selection changes: a new object (or revision) is a new history entry; moving inside the
 * same object rewrites the current entry so back does not step through every pin clicked.
 */
export function probeNavigateOptions(previous: ProbeTarget | null, next: ProbeTarget | null): NavigateOptions {
  const sameObject = previous && next && previous.object === next.object && previous.rev === next.rev;
  return { replace: !!sameObject && !sameTarget(previous, next) };
}
