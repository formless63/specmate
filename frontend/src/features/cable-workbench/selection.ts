import type { ProbeTarget } from "../navigation/url";

const workbenchKey = (value: string) => /^(?:w|t|p|r|q|e|s):.+/.test(value);

/** A cable feature uses the same final # segment as the shared scene probe. */
export function cableSelection(target: ProbeTarget): string | null {
  const feature = target.path.at(-1);
  return feature?.startsWith("#") && workbenchKey(feature.slice(1)) ? feature.slice(1) : null;
}

/** Preserve the record, exact revision and every unknown/occurrence prefix segment. */
export function withCableSelection(target: ProbeTarget, key: string | null): ProbeTarget {
  const prefix = cableSelection(target) ? target.path.slice(0, -1) : target.path;
  return { ...target, path: key ? [...prefix, `#${key}`] : [...prefix] };
}
