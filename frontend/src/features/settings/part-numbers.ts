// Adapted from WireHub cbf919edf30a9d906a791971d3a40e22cb78b67e; see NOTICE.
/** Pure prefix and declarative format checks. Suggestions are examples only;
 * workspace numbering stays off until an admin explicitly saves a scheme.
 */

import { declarativePartNumberScheme, isDeclarativeSchemeConfig, parseDeclarativeSchemeConfig } from './pn-declarative';

/** The catalog kinds a PN is checked or suggested for. */
export type PnKind = string;
export const PN_KINDS: readonly PnKind[] = ['part', 'connector_body', 'pinout', 'wire_stock', 'board', 'hardware', 'material', 'kit', 'cable', 'harness', 'assembly'];
export const validPnKind = (kind: unknown): kind is PnKind => typeof kind === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(kind);

export type PnIssueCode = 'pn-malformed' | 'pn-wrong-kind' | 'pn-unknown-prefix' | (string & {});
export interface PnIssue { code: PnIssueCode; severity: 'warning'; message: string; }

/** A number that already exists somewhere (a catalog record, a design). */
export interface KnownPartNumber {
  pn: string;
  kind?: PnKind;
  label?: string;
  /** where it was found: a retained record or external register */
  source: string;
}

/** What a number is being suggested for. */
export interface PnSubject {
  kind: PnKind;
  label: string;
  /** the record or design id */
  id?: string;
  /** a number this part is a variant of (a declarative scheme proposes its next variant) */
  variantOf?: string;
}

export interface PnSuggestion {
  pn: string;
  /** the scheme rule that produced it (`next-free`) */
  rule: string;
  /** one sentence a person can check */
  explanation: string;
  /** true when no specific rule applied and the scheme fell back to the next free number */
  fallback?: boolean;
}

/** A numbering scheme. Implementations must be pure. */
export interface PartNumberScheme {
  /** kebab id: `prefix` (the built-in), or a module's own */
  id: string;
  label: string;
  /** the canonical spelling of `pn` when it is one of this scheme's numbers, else `undefined` */
  parse(pn: string): string | undefined;
  /** findings for one number; `kind` narrows the checks when the caller knows what it numbers */
  check(pn: string, kind?: PnKind): PnIssue[];
  /** a proposal for `subject`, given every number already in use; `undefined` when the scheme does not number that kind */
  suggest(subject: PnSubject, known: readonly KnownPartNumber[]): PnSuggestion | undefined;
  /** the layout of a number in words (`<level><type>-NNNNNN-VV`), for messages and forms */
  shape?: string;
  /** existing numbers never change: a saved number cannot be edited into another one */
  immutable?: boolean;
}

/* ------------------------------------------------------------------ *
 * The built-in prefix scheme: `<PREFIX>-<NNNNN>`
 * ------------------------------------------------------------------ */

/** Prefix settings stored in the workspace numbering policy. */
export interface PrefixSchemeConfig {
  id?: string;
  label?: string;
  /** prefix per kind; a kind with no prefix is not numbered by the scheme */
  prefixes: Partial<Record<PnKind, string>>;
  /** zero-padded digits after the separator (default 5) */
  digits?: number;
  /** between prefix and digits (default `-`) */
  separator?: string;
  /** optional revision suffix, e.g. `-A` — read and kept, never suggested */
  allowRevisionSuffix?: boolean;
  src?: string;
}

export const DEFAULT_PREFIX_SCHEME_CONFIG: PrefixSchemeConfig = {
  id: 'prefix',
  label: 'Prefix + sequence (CON-00001)',
  prefixes: { cable: 'CBL', harness: 'HRN', assembly: 'ASM', part: 'PRT' },
  digits: 5,
  separator: '-',
  allowRevisionSuffix: true,
  src: 'synthetic example: the base default scheme',
};

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parse a `PrefixSchemeConfig` from untrusted JSON; throws with a message naming the bad field. */
export function parsePrefixSchemeConfig(json: unknown): PrefixSchemeConfig {
  if (typeof json !== 'object' || json === null) throw new Error('Numbering scheme must be an object');
  const o = json as Record<string, unknown>;
  const prefixes = o['prefixes'];
  if (typeof prefixes !== 'object' || prefixes === null) throw new Error('Numbering scheme: prefixes must be an object');
  const out: Partial<Record<PnKind, string>> = {};
  for (const [k, v] of Object.entries(prefixes as Record<string, unknown>)) {
    if (!validPnKind(k)) throw new Error(`Numbering scheme: '${k}' is not a part-number kind`);
    if (typeof v !== 'string' || !/^[A-Z0-9]{1,8}$/.test(v)) throw new Error(`Numbering scheme: prefix for '${k}' must be 1–8 capitals/digits`);
    out[k as PnKind] = v;
  }
  const digits = o['digits'];
  if (digits !== undefined && (typeof digits !== 'number' || !Number.isInteger(digits) || digits < 1 || digits > 12)) {
    throw new Error('Numbering scheme: digits must be an integer 1–12');
  }
  const separator = o['separator'];
  if (separator !== undefined && (typeof separator !== 'string' || separator.length > 2)) throw new Error('Numbering scheme: separator must be a short string');
  return {
    ...(typeof o['id'] === 'string' ? { id: o['id'] } : {}),
    ...(typeof o['label'] === 'string' ? { label: o['label'] } : {}),
    prefixes: out,
    ...(digits === undefined ? {} : { digits: digits as number }),
    ...(separator === undefined ? {} : { separator: separator as string }),
    ...(o['allowRevisionSuffix'] === undefined ? {} : { allowRevisionSuffix: o['allowRevisionSuffix'] === true }),
    ...(typeof o['src'] === 'string' ? { src: o['src'] } : {}),
  };
}

/** The built-in scheme: one prefix per kind, then a zero-padded sequence. */
export function prefixPartNumberScheme(config: PrefixSchemeConfig = DEFAULT_PREFIX_SCHEME_CONFIG): PartNumberScheme {
  const digits = config.digits ?? 5;
  const sep = config.separator ?? '-';
  const byPrefix = new Map<string, PnKind>();
  for (const [kind, prefix] of Object.entries(config.prefixes) as [PnKind, string][]) byPrefix.set(prefix, kind);
  const suffix = config.allowRevisionSuffix ? `(${escapeRe(sep)}[A-Za-z0-9]{1,3})?` : '()';
  const re = new RegExp(`^\\s*([A-Za-z0-9]{1,8})${escapeRe(sep)}(\\d{${digits}})${suffix}\\s*$`);

  function split(pn: string): { prefix: string; number: string; suffix: string } | undefined {
    const m = re.exec(pn);
    if (m === null) return undefined;
    return { prefix: (m[1] as string).toUpperCase(), number: m[2] as string, suffix: (m[3] ?? '').toUpperCase() };
  }

  return {
    id: config.id ?? 'prefix',
    label: config.label ?? 'Prefix + sequence',
    parse(pn) {
      const p = split(pn);
      return p === undefined ? undefined : `${p.prefix}${sep}${p.number}${p.suffix}`;
    },
    check(pn, kind) {
      const p = split(pn);
      if (p === undefined) {
        return [{ code: 'pn-malformed', severity: 'warning', message: `'${pn}' is not <PREFIX>${sep}${'N'.repeat(digits)}` }];
      }
      const owner = byPrefix.get(p.prefix);
      if (owner === undefined) return [{ code: 'pn-unknown-prefix', severity: 'warning', message: `prefix '${p.prefix}' is not in the scheme` }];
      if (kind !== undefined && owner !== kind) {
        return [{ code: 'pn-wrong-kind', severity: 'warning', message: `'${p.prefix}' numbers ${owner}, not ${kind}` }];
      }
      return [];
    },
    suggest(subject, known) {
      // a variant of a number this scheme reads: the next free two-digit suffix on its base (`CON-00012-01`)
      const of = subject.variantOf === undefined ? undefined : split(subject.variantOf);
      if (of !== undefined && config.allowRevisionSuffix === true) {
        const base = `${of.prefix}${sep}${of.number}`;
        let top = /^\d+$/.test(of.suffix.slice(sep.length)) ? Number(of.suffix.slice(sep.length)) : 0;
        for (const k of known) {
          const p = split(k.pn);
          const n = p === undefined ? '' : p.suffix.slice(sep.length);
          if (p !== undefined && p.prefix === of.prefix && p.number === of.number && /^\d+$/.test(n)) top = Math.max(top, Number(n));
        }
        if (top < 99) {
          return { pn: `${base}${sep}${String(top + 1).padStart(2, '0')}`, rule: 'next-variant', explanation: `the next free variant of ${base}${top === 0 ? '' : ` after ${base}${sep}${String(top).padStart(2, '0')}`}` };
        }
      }
      const prefix = config.prefixes[subject.kind];
      if (prefix === undefined) return undefined;
      let max = 0;
      for (const k of known) {
        const p = split(k.pn);
        if (p !== undefined && p.prefix === prefix) max = Math.max(max, Number(p.number));
      }
      const next = String(max + 1).padStart(digits, '0');
      return {
        pn: `${prefix}${sep}${next}`,
        rule: 'next-free',
        explanation: `the next free ${prefix} number after ${max === 0 ? 'none in use' : `${prefix}${sep}${String(max).padStart(digits, '0')}`}`,
        fallback: true,
      };
    },
  };
}

/**
 * The scheme a `Numbering scheme` describes: a declarative definition
 * (`pn-declarative.ts`, `"type": "declarative"`) or the prefix scheme's
 * configuration. Throws, naming the problem, on a bad one.
 */
export function schemeFromConfig(json: unknown): PartNumberScheme {
  return isDeclarativeSchemeConfig(json) ? declarativePartNumberScheme(parseDeclarativeSchemeConfig(json)) : prefixPartNumberScheme(parsePrefixSchemeConfig(json));
}
