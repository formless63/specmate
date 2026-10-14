import { useEffect, useSyncExternalStore } from "react";

/** Display identity of one exact revision, resolved through the scoped read contract. */
export type RevisionLabelData =
  | { readable: true; revision_id: string; name: string; kind: string; number: number }
  | { readable: false; revision_id: string };

export type LabelKind = "design" | "source";
type Entry = { status: "pending" | "ready" | "error"; data: RevisionLabelData | null; at: number };

/** A label is rechecked after this long so revoked access stops disclosing a name promptly. */
const FRESH_MS = 10_000;
const MAX_BATCH = 50;
const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;
const queue: { design: Set<string>; source: Set<string> } = { design: new Set(), source: new Set() };
let scheduled = false;

const keyOf = (kind: LabelKind, id: string) => `${kind}:${id}`;
const notify = () => { version += 1; listeners.forEach(listener => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Drops every cached label (sign-out, project switch, tests). */
export function clearRevisionLabels() { cache.clear(); notify(); }

function valid(entry: unknown): entry is RevisionLabelData {
  if (!entry || typeof entry !== "object") return false;
  const row = entry as Record<string, unknown>;
  if (typeof row.revision_id !== "string") return false;
  if (row.readable === false) return true;
  return row.readable === true && typeof row.name === "string" && typeof row.kind === "string" && typeof row.number === "number";
}

function settle(kind: LabelKind, ids: string[], rows: unknown, failed: boolean) {
  const list: unknown[] = Array.isArray(rows) ? rows : [];
  const byId = new Map<string, RevisionLabelData>();
  for (const row of list) if (valid(row)) byId.set(row.revision_id, row);
  for (const id of ids) {
    const found = byId.get(id) ?? null;
    cache.set(keyOf(kind, id), { status: failed || !found ? "error" : "ready", data: found, at: Date.now() });
  }
}

async function flush() {
  scheduled = false;
  const design = [...queue.design]; const source = [...queue.source];
  queue.design.clear(); queue.source.clear();
  for (let at = 0; at < Math.max(design.length, source.length); at += MAX_BATCH) {
    const d = design.slice(at, at + MAX_BATCH); const s = source.slice(at, at + MAX_BATCH);
    const params = new URLSearchParams();
    d.forEach(id => params.append("revision_ids", id)); s.forEach(id => params.append("source_revision_ids", id));
    try {
      const response = await fetch(`/api/v0/catalog/revision-labels?${params}`, { credentials: "same-origin" });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message ?? `Request failed (${response.status})`);
      settle("design", d, body?.labels, false); settle("source", s, body?.source_labels, false);
    } catch {
      settle("design", d, [], true); settle("source", s, [], true);
    }
    notify();
  }
}

function request(kind: LabelKind, id: string) {
  const existing = cache.get(keyOf(kind, id));
  if (existing && (existing.status === "pending" || Date.now() - existing.at < FRESH_MS)) return;
  cache.set(keyOf(kind, id), { status: "pending", data: existing?.data ?? null, at: Date.now() });
  queue[kind].add(id);
  if (!scheduled) { scheduled = true; void Promise.resolve().then(() => Promise.resolve()).then(flush); }
}

export type LabelState = { data: RevisionLabelData | null; isPending: boolean; isError: boolean };
const NONE: LabelState = { data: null, isPending: false, isError: false };

function read(kind: LabelKind, id: string | null | undefined, enabled: boolean): LabelState {
  if (!enabled || !id) return NONE;
  const entry = cache.get(keyOf(kind, id));
  if (!entry) return { data: null, isPending: true, isError: false };
  return { data: entry.data, isPending: entry.status === "pending" && !entry.data, isError: entry.status === "error" };
}

/** Subscribes to label changes and requests the given IDs. Works without any provider. */
export function useRevisionLabel(id: string | null | undefined, enabled = true, kind: LabelKind = "design"): LabelState {
  useSyncExternalStore(subscribe, () => version);
  useEffect(() => { if (enabled && id) request(kind, id); }, [enabled, id, kind]);
  return read(kind, id, enabled);
}

export function revisionText(data: RevisionLabelData | null | undefined): string | undefined {
  if (!data) return undefined;
  return data.readable ? `${data.name} r${data.number}` : "Not readable by you";
}

/** Plain-text labels for several exact revisions; IDs not yet resolved are omitted. */
export function useRevisionTexts(ids: readonly string[], kind: LabelKind = "design"): Record<string, string> {
  useSyncExternalStore(subscribe, () => version);
  const unique = [...new Set(ids)].sort();
  const signature = unique.join(",");
  useEffect(() => { unique.forEach(id => request(kind, id)); }, [signature, kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const out: Record<string, string> = {};
  for (const id of unique) { const text = revisionText(read(kind, id, true).data); if (text) out[id] = text; }
  return out;
}

/** Select option text: name first, then revision number. The exact ID stays the option value. */
export function revisionOptionLabel(name: string | null | undefined, number: number, suffix?: string) {
  const base = name?.trim() ? `${name} · r${number}` : `Revision ${number}`;
  return suffix ? `${base} · ${suffix}` : base;
}
