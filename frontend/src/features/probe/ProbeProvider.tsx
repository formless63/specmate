import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { sameTarget, targetKey, type ProbeTarget } from "../navigation/url";
import { RelationRegistry, type RelatedTarget, type RelationContributor } from "./relations";

/**
 * The probe: the one shared selection that tree rows, tables, diagrams and the inspector all
 * read and set. It lives in the URL (see features/navigation), so back/forward and reload
 * restore it. Selecting is navigation only; the server still authorizes every read.
 */
type ProbeContextValue = {
  probe: ProbeTarget | null;
  setProbe: (target: ProbeTarget | null) => void;
  registry: RelationRegistry;
};

const ProbeContext = createContext<ProbeContextValue | null>(null);

export function ProbeProvider({ probe, onProbe, registry: given, children }: {
  probe: ProbeTarget | null;
  onProbe: (target: ProbeTarget | null) => void;
  registry?: RelationRegistry;
  children: ReactNode;
}) {
  const [registry] = useState(() => given ?? new RelationRegistry());
  const value = useMemo(() => ({ probe, setProbe: onProbe, registry }), [probe, onProbe, registry]);
  return <ProbeContext.Provider value={value}>{children}</ProbeContext.Provider>;
}

/** The probe and its setter; null outside a ProbeProvider (a panel rendered on its own). */
export function useProbe(): ProbeContextValue | null {
  return useContext(ProbeContext);
}

/**
 * The selected object for a list that works with or without the shared probe: inside the shell
 * the selection is the probe (and so the URL); a panel rendered alone keeps it locally.
 */
export function useProbeOrLocal(): [string | null, (object: string | null) => void] {
  const shared = useProbe();
  const [local, setLocal] = useState<string | null>(null);
  const setShared = shared?.setProbe;
  const select = useCallback((object: string | null) => {
    if (setShared) setShared(object ? { object, rev: null, path: [] } : null);
    else setLocal(object);
  }, [setShared]);
  return [shared ? shared.probe?.object ?? null : local, select];
}

/** Targets related to the current probe, recomputed when the probe or any contribution changes. */
export function useRelated(): RelatedTarget[] {
  const shared = useProbe();
  const registry = shared?.registry;
  const version = useSyncExternalStore(registry?.subscribe ?? noSubscribe, registry?.getVersion ?? zero);
  const probe = shared?.probe ?? null;
  // The key tracks the selection and the version tracks contributions.
  const key = probe ? targetKey(probe) : null;
  return useMemo(() => (registry && probe ? registry.related(probe) : []), [registry, key, version]);
}

export type ProbeMark = "selected" | "related" | null;

/**
 * How a row or mark for this target should look. With `match: "object"` any revision or path
 * of the same object counts as selected (a library row stands for the whole item).
 */
export function useProbeMark(target: ProbeTarget, match: "exact" | "object" = "exact"): ProbeMark {
  const probe = useProbe()?.probe ?? null;
  return probeMark(probe, useRelated(), target, match);
}

/** The pure form of useProbeMark, for lists that mark many rows from one useRelated() call. */
export function probeMark(probe: ProbeTarget | null, related: RelatedTarget[], target: ProbeTarget, match: "exact" | "object" = "exact"): ProbeMark {
  if (!probe) return null;
  if (match === "object" ? probe.object === target.object : sameTarget(probe, target)) return "selected";
  const key = targetKey(target);
  return related.some((item) => targetKey(item) === key || (match === "object" && item.object === target.object)) ? "related" : null;
}

/** Contribute relations while the calling component is mounted (and replace them when they change). */
export function useRelationContributor(contributor: RelationContributor | null) {
  const registry = useProbe()?.registry;
  useEffect(() => (registry && contributor ? registry.register(contributor) : undefined), [registry, contributor]);
}

const noSubscribe = () => () => {};
const zero = () => 0;
