import type { CableEnd, EndRow, ResolvedSignal } from "../interfaces/api";
import type { IntentRow, RequiredPart } from "./api";
import { familyColor, signalFamily, type SignalFamily } from "./signal-palette";

/** Height of one pin row on either rail; the wiring drawing between the rails shares it. */
export const ROW = 24;

export type RailPin = { contactId: string; number: string; label: string; signal: ResolvedSignal | null; family: SignalFamily; mustNotConnect: boolean; y: number };
export type Line = { key: string; rowId: string; from: number; to: number; family: SignalFamily; color: string; optional: boolean; parts: RequiredPart[]; name: string };
export type Stub = { key: string; rowId: string; side: "from" | "to"; y: number; kind: "must_not_connect" | "unconnected" };
export type Callout = { rowId: string; anchor: number; top: number; height: number; options: { contactId: string; label: string; y: number | null }[]; family: SignalFamily; color: string };
export type Wiring = {
  a: RailPin[]; b: RailPin[]; height: number; lines: Line[]; stubs: Stub[]; callouts: Callout[];
  open: number; mustNotConnect: number; signals: number; returns: number;
};

const RETURNS = new Set(["ground_return", "shield", "chassis"]);

function rail(end: CableEnd | undefined): RailPin[] {
  return (end?.rows ?? []).filter((r) => r.physical_role !== "key").map((r, i) => pin(r, i));
}

function pin(r: EndRow, i: number): RailPin {
  const signal = r.signal ?? null;
  return {
    contactId: r.contact_id, number: r.number ?? r.contact_id, label: signal?.name ?? (r.label && r.label !== r.contact_id ? r.label : ""),
    signal, family: signalFamily(signal?.type), mustNotConnect: !!r.device?.must_not_connect, y: i * ROW + ROW / 2,
  };
}

/** The signal a row carries: the source contact's, else the first destination's. */
export function rowSignal(row: IntentRow, a: Map<string, RailPin>, b: Map<string, RailPin>): ResolvedSignal | null {
  return (row.from_contact_id ? a.get(row.from_contact_id)?.signal : null) ?? (row.to_contact_ids[0] ? b.get(row.to_contact_ids[0])?.signal : null) ?? null;
}

/** Estimated callout height: kind line, two lines of question text, then rows of answer buttons. */
export function calloutHeight(options: number): number {
  const buttons = options === 0 ? 1 : options + (options > 1 ? 1 : 0);
  return 58 + Math.ceil(buttons / 3) * 26;
}

/**
 * Lays the intent out between two pin rails: a line per matched destination, red crossed stubs
 * for must-not-connect, and a callout per open question placed beside its source pin without
 * overlapping the previous one. Nothing is inferred: a row without a destination stays open.
 */
export function layoutWiring(rows: IntentRow[], from: CableEnd | undefined, to: CableEnd | undefined): Wiring {
  const a = rail(from);
  const b = rail(to);
  const byA = new Map(a.map((p) => [p.contactId, p]));
  const byB = new Map(b.map((p) => [p.contactId, p]));
  const lines: Line[] = [];
  const stubs: Stub[] = [];
  const pending: Omit<Callout, "top">[] = [];
  let signals = 0, returns = 0, mustNotConnect = 0;
  for (const row of rows) {
    const signal = rowSignal(row, byA, byB);
    const family = signalFamily(signal?.type);
    const source = row.from_contact_id ? byA.get(row.from_contact_id) : undefined;
    if (row.requirement === "must_not_connect") {
      mustNotConnect += 1;
      if (source) stubs.push({ key: `${row.row_id}:from`, rowId: row.row_id, side: "from", y: source.y, kind: "must_not_connect" });
      for (const id of row.to_contact_ids) { const p = byB.get(id); if (p) stubs.push({ key: `${row.row_id}:to:${id}`, rowId: row.row_id, side: "to", y: p.y, kind: "must_not_connect" }); }
      continue;
    }
    if (signal && RETURNS.has(signal.type)) returns += 1; else signals += 1;
    if (row.question) {
      const anchor = source?.y ?? (byB.get(row.question.options[0]?.contact_id ?? "")?.y ?? 0);
      pending.push({ rowId: row.row_id, anchor, height: calloutHeight(row.question.options.length), family, color: familyColor(family),
        options: row.question.options.map((o) => ({ contactId: o.contact_id, label: o.label, y: byB.get(o.contact_id)?.y ?? null })) });
      continue;
    }
    const targets = row.to_contact_ids.map((id) => byB.get(id)).filter((p): p is RailPin => !!p);
    if (source && targets.length) {
      for (const t of targets) lines.push({ key: `${row.row_id}:${t.contactId}`, rowId: row.row_id, from: source.y, to: t.y, family, color: familyColor(family), optional: row.requirement === "optional", parts: row.required_parts, name: signal?.name ?? `${source.number} to ${t.number}` });
    } else if (source) {
      stubs.push({ key: `${row.row_id}:from`, rowId: row.row_id, side: "from", y: source.y, kind: "unconnected" });
    } else {
      for (const t of targets) stubs.push({ key: `${row.row_id}:to:${t.contactId}`, rowId: row.row_id, side: "to", y: t.y, kind: "unconnected" });
    }
  }
  pending.sort((x, y) => x.anchor - y.anchor);
  const callouts: Callout[] = [];
  let bottom = -Infinity;
  for (const c of pending) {
    const top = Math.max(0, c.anchor - 14, bottom + 8);
    callouts.push({ ...c, top });
    bottom = top + c.height;
  }
  const height = Math.max(a.length * ROW, b.length * ROW, callouts.length ? bottom : 0, ROW);
  return { a, b, height, lines, stubs, callouts, open: pending.length, mustNotConnect, signals, returns };
}
