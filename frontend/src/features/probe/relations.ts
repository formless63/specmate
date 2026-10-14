import { targetKey, type ProbeTarget } from "../navigation/url";

/** A target related to the probe, with the relation in plain words ("contains", "same item"). */
export type RelatedTarget = ProbeTarget & { relation: string };

/**
 * A module's knowledge of how its records relate: given the probe, the targets that tree rows,
 * table rows, diagram marks and inspectors should show as related. Contributors only describe
 * relations among records the member has already read; they never fetch or authorize.
 */
export type RelationContributor = {
  id: string;
  related: (probe: ProbeTarget) => Iterable<RelatedTarget>;
};

/**
 * The relation registry modules contribute to. Contributions are keyed by id, so a module that
 * re-registers with fresh data replaces its previous contribution rather than adding to it.
 */
export class RelationRegistry {
  private contributors = new Map<string, RelationContributor>();
  private listeners = new Set<() => void>();
  private version = 0;

  constructor(initial: RelationContributor[] = BUILT_IN) {
    for (const contributor of initial) this.contributors.set(contributor.id, contributor);
  }

  /** Add or replace a contributor; returns its removal. */
  register(contributor: RelationContributor): () => void {
    this.contributors.set(contributor.id, contributor);
    this.changed();
    return () => {
      if (this.contributors.get(contributor.id) !== contributor) return;
      this.contributors.delete(contributor.id);
      this.changed();
    };
  }

  /** Every target related to the probe, deduplicated by target (first relation wins), never the probe itself. */
  related(probe: ProbeTarget): RelatedTarget[] {
    const own = targetKey(probe);
    const seen = new Map<string, RelatedTarget>();
    for (const contributor of this.contributors.values()) {
      for (const target of contributor.related(probe)) {
        const key = targetKey(target);
        if (key !== own && !seen.has(key)) seen.set(key, target);
      }
    }
    return [...seen.values()];
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getVersion = (): number => this.version;

  private changed() {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

/**
 * Structural relations every address has: a path inside an object is contained by each of its
 * ancestors and by the object, and an exact revision belongs to the item that follows the latest.
 */
export const containment: RelationContributor = {
  id: "containment",
  *related(probe) {
    for (let depth = probe.path.length - 1; depth >= 0; depth -= 1) {
      yield { object: probe.object, rev: probe.rev, path: probe.path.slice(0, depth), relation: "contains" };
    }
    if (probe.rev !== null) yield { object: probe.object, rev: null, path: [], relation: "same item" };
  },
};

const BUILT_IN: RelationContributor[] = [containment];
