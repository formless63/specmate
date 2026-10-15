import type { ConnectorFacePin, PinRing } from "../../../../packages/connector-art/src";
import { unknownElectrical, type Assignment, type Contact, type Electrical, type EndRow, type PinSignal, type Pinout, type PortPin, type Signal, type SignalType } from "../interfaces/api";
import { familyColor, signalFamily } from "./palette";

/** One meaning a pin can carry: a typed signal (by key) or a free-text note. */
export type Meaning = { name: string; type: SignalType | null; key: string | null };

/**
 * One contact of a pin table, the same shape for an unsaved draft and a frozen variant.
 * `unknown` pins have no typed signal; a note alone does not make a pin declared.
 */
export type PinRow = {
  contactId: string;
  number: string | null;
  label: string;
  physicalRole: string;
  status: "declared" | "conditional" | "unknown";
  meaning: Meaning | null;
  note: string | null;
  role: string;
  conditionKey: string | null;
  alternatives: { choice: string; choiceName: string; meaning: Meaning | null; role: string }[];
};

/** The pin role a signal type suggests when the pin role is still unknown; never overrides a declared role. */
export const SUGGESTED_ROLE: Partial<Record<SignalType, string>> = {
  analog_video: "signal", sync: "signal", analog_audio: "signal", digital_audio: "signal", data: "signal", control: "signal",
  power: "power", ground_return: "return", shield: "shield", chassis: "chassis",
};

const pinContacts = <C extends Contact>(contacts: readonly C[]): C[] => contacts.filter((c) => c.physical_role !== "key");

function meaningOf(ref: { key: string } | null | undefined, signals: ReadonlyMap<string, Signal>, note: string | null): Meaning | null {
  if (!ref) return null;
  const signal = signals.get(ref.key);
  return { name: signal?.name ?? note ?? ref.key, type: signal?.type ?? null, key: ref.key };
}

/** Rows of an unsaved pin table; signals are named from the loaded signal set (by key). */
export function rowsFromDraft(pinout: Pinout, contacts: readonly Contact[], signals: ReadonlyMap<string, Signal>): PinRow[] {
  const byContact = new Map((pinout.assignments ?? []).map((a) => [a.contact_id, a]));
  const conditions = pinout.conditions ?? [];
  return pinContacts(contacts).map((c) => {
    const a = byContact.get(c.contact_id);
    const alternatives = a?.alternatives ?? [];
    const condition = conditions.find((x) => x.key === alternatives[0]?.condition_key);
    const meaning = meaningOf(a?.electrical.signal_ref, signals, a?.electrical.signal ?? null);
    return {
      contactId: c.contact_id, number: c.number ?? null, label: c.label, physicalRole: c.physical_role,
      status: alternatives.length ? "conditional" : meaning ? "declared" : "unknown",
      meaning: alternatives.length ? null : meaning, note: a?.electrical.signal ?? null, role: a?.electrical.role ?? "unknown",
      conditionKey: alternatives[0]?.condition_key ?? null,
      alternatives: alternatives.map((alt) => ({ choice: alt.choice, choiceName: condition?.choices.find((x) => x.key === alt.choice)?.name ?? alt.choice, meaning: meaningOf(alt.signal_ref, signals, alt.signal), role: alt.role })),
    };
  });
}

/** Rows of a frozen pin table from its inspection (resolved signals per contact). */
export function rowsFromInspection(contacts: readonly (Contact & { electrical: Electrical | null })[], signals: Record<string, PinSignal>, conditions: Pinout["conditions"] = []): PinRow[] {
  return pinContacts(contacts).map((c) => {
    const row = signals[c.contact_id];
    const condition = (conditions ?? []).find((x) => x.key === row?.alternatives[0]?.condition_key);
    const typed = row?.signal;
    return {
      contactId: c.contact_id, number: c.number ?? null, label: c.label, physicalRole: c.physical_role,
      status: row?.status ?? "unknown",
      meaning: typed ? { name: typed.name, type: typed.type, key: typed.key } : null,
      note: c.electrical?.signal ?? null, role: c.electrical?.role ?? "unknown",
      conditionKey: row?.alternatives[0]?.condition_key ?? null,
      alternatives: (row?.alternatives ?? []).map((alt) => ({
        choice: alt.choice, choiceName: condition?.choices.find((x) => x.key === alt.choice)?.name ?? alt.choice,
        meaning: alt.signal_ref ? { name: alt.signal_ref.name, type: alt.signal_ref.type, key: alt.signal_ref.key } : alt.signal ? { name: alt.signal, type: null, key: null } : null, role: alt.role,
      })),
    };
  });
}

const identity = (m: Meaning | null): string | null => (m ? m.key ?? `note:${m.name.trim().toLowerCase()}` : null);

/** What a pin means, as a comparable value; unknown pins compare equal to each other only. */
export function pinIdentity(row: PinRow | undefined): string | null {
  if (!row || row.status === "unknown") return null;
  if (row.status === "conditional") return `if:${row.conditionKey}:${row.alternatives.map((a) => `${a.choice}=${identity(a.meaning) ?? "?"}`).join(",")}`;
  return identity(row.meaning);
}

/** The pin's meaning in words: a signal name, the conditional alternatives, or "unknown". */
export function describe(row: PinRow | undefined): string {
  if (!row || row.status === "unknown") return row?.note ? `unknown (note: ${row.note})` : "unknown";
  if (row.status === "conditional") return row.alternatives.map((a) => `${a.choiceName}: ${a.meaning?.name ?? "unknown"}`).join(" / ");
  return row.meaning?.name ?? "unknown";
}

export const pinName = (row: { number: string | null; contactId: string }) => row.number ?? row.contactId;

export type PinDifference = { contactId: string; pin: string; a: string; b: string };

/** Pins whose meaning differs between two pin tables of the same body (union of contacts). */
export function diffPins(a: readonly PinRow[], b: readonly PinRow[]): PinDifference[] {
  const left = new Map(a.map((r) => [r.contactId, r]));
  const right = new Map(b.map((r) => [r.contactId, r]));
  const ids = [...left.keys(), ...[...right.keys()].filter((id) => !left.has(id))];
  return ids.filter((id) => pinIdentity(left.get(id)) !== pinIdentity(right.get(id))).map((id) => {
    const row = left.get(id) ?? right.get(id)!;
    return { contactId: id, pin: pinName(row), a: describe(left.get(id)), b: describe(right.get(id)) };
  });
}

/** A conditional pin that could carry power when its condition is not selected. */
export function mayBePower(row: PinRow): boolean {
  return row.status === "conditional" && row.alternatives.some((a) => a.role === "power" || a.meaning?.type === "power");
}

const fillOf = (m: Meaning | null) => (m?.type ? familyColor(signalFamily(m.type)) : "var(--sb-text-tertiary)");

/** Face markers for pin rows: family fill, hatched unknowns, split conditionals and outer rings. */
export function facePins(rows: readonly PinRow[], rings: ReadonlyMap<string, readonly PinRing[]> = new Map()): ConnectorFacePin[] {
  return rows.map((row) => {
    const extra = [...(rings.get(row.contactId) ?? [])];
    if (mayBePower(row) && !extra.includes("hazard")) extra.push("hazard");
    const base: ConnectorFacePin = { id: row.contactId, label: describe(row), ...(extra.length ? { rings: extra } : {}) };
    if (row.status === "conditional") {
      const split = row.alternatives.map((a) => fillOf(a.meaning));
      return { ...base, fill: split[0], split };
    }
    if (row.status === "unknown") return row.physicalRole === "contact" ? { ...base, state: "unknown" } : base;
    return { ...base, fill: fillOf(row.meaning) };
  });
}

/** How many contacts of the table carry each signal key. */
export function usesByKey(rows: readonly PinRow[]): Map<string, number> {
  const out = new Map<string, number>();
  const add = (m: Meaning | null) => { if (m?.key) out.set(m.key, (out.get(m.key) ?? 0) + 1); };
  for (const row of rows) { add(row.meaning); row.alternatives.forEach((a) => add(a.meaning)); }
  return out;
}

/* Pure edits of a draft pin table. Assignments stay in the body's contact order. */

function put(pinout: Pinout, contacts: readonly Contact[], contactId: string, next: (a: Assignment) => Assignment | null): Pinout {
  const current = pinout.assignments.find((a) => a.contact_id === contactId) ?? { contact_id: contactId, electrical: unknownElectrical(), alternatives: [] };
  const updated = next(current);
  const rest = pinout.assignments.filter((a) => a.contact_id !== contactId);
  const order = new Map(contacts.map((c, i) => [c.contact_id, i]));
  const assignments = (updated ? [...rest, updated] : rest).sort((x, y) => (order.get(x.contact_id) ?? 1e9) - (order.get(y.contact_id) ?? 1e9));
  return { ...pinout, assignments };
}

/**
 * Puts a typed signal on a contact; with `choice`, on that alternative of a conditional pin.
 * An unknown pin role takes the role the signal type suggests; a declared role is kept.
 */
export function assignSignal(pinout: Pinout, contacts: readonly Contact[], contactId: string, signal: Signal, setRevisionId: string, choice: string | null = null): Pinout {
  const ref = { signal_set_revision_id: setRevisionId, key: signal.key };
  return put(pinout, contacts, contactId, (a) => {
    const alternatives = a.alternatives ?? [];
    if (choice !== null && alternatives.length) {
      return { ...a, alternatives: alternatives.map((alt) => (alt.choice === choice ? { ...alt, signal_ref: ref, role: SUGGESTED_ROLE[signal.type] ?? "unknown" } : alt)) };
    }
    const role = a.electrical.role === "unknown" ? SUGGESTED_ROLE[signal.type] ?? "unknown" : a.electrical.role;
    return { ...a, alternatives: [], electrical: { ...a.electrical, role, signal_ref: ref } };
  });
}

/** Removes a contact's assignment: the pin becomes unknown again. */
export function clearPin(pinout: Pinout, contacts: readonly Contact[], contactId: string): Pinout {
  return put(pinout, contacts, contactId, () => null);
}

/** Turns a contact into a conditional pin with one unknown alternative per choice of the condition. */
export function makeConditional(pinout: Pinout, contacts: readonly Contact[], contactId: string, conditionKey: string): Pinout {
  const condition = (pinout.conditions ?? []).find((c) => c.key === conditionKey);
  if (!condition) return pinout;
  return put(pinout, contacts, contactId, (a) => ({
    ...a, electrical: { ...a.electrical, signal_ref: null },
    alternatives: condition.choices.map((choice) => ({ condition_key: condition.key, choice: choice.key, signal_ref: null, signal: null, role: "unknown", basis: pinout.review_basis ?? "" })),
  }));
}

/** Drops a pin's alternatives; it keeps no signal until one is picked. */
export function makeUnconditional(pinout: Pinout, contacts: readonly Contact[], contactId: string): Pinout {
  return put(pinout, contacts, contactId, (a) => ({ ...a, alternatives: [] }));
}

/** Patches one contact's electrical declaration (creating the assignment when needed). */
export function patchElectrical(pinout: Pinout, contacts: readonly Contact[], contactId: string, patch: Partial<Electrical>): Pinout {
  return put(pinout, contacts, contactId, (a) => ({ ...a, electrical: { ...a.electrical, ...patch } }));
}

/* Ports */

/** A cable-end row as the port sees it: the port's selected condition resolves a conditional pin. */
export function portRow(row: EndRow, selections: Record<string, string>): EndRow {
  if (!row.condition_key || !row.alternatives) return row;
  const chosen = row.alternatives.find((a) => a.choice === selections[row.condition_key!]);
  return chosen ? { ...row, status: "declared", signal: chosen.signal_ref, role: chosen.role, hazards: [], reason: undefined } : row;
}

/** Face markers for a port: signals from its variant, its device's must-not-connect pins ringed. */
export function portFacePins(rows: readonly EndRow[], pins: readonly PortPin[]): ConnectorFacePin[] {
  const byContact = new Map(pins.map((p) => [p.contact_id, p]));
  return rows.map((row) => {
    const rings: PinRing[] = [];
    if (byContact.get(row.contact_id)?.must_not_connect) rings.push("must-not-connect");
    if (row.hazards?.includes("may_be_power")) rings.push("hazard");
    const base: ConnectorFacePin = { id: row.contact_id, label: row.signal?.name ?? row.note ?? (row.alternatives ? `could be ${row.alternatives.map((a) => a.signal_ref?.name ?? a.signal ?? a.role).join(" or ")}` : "unknown"), ...(rings.length ? { rings } : {}) };
    if (row.status === "declared" && row.signal) return { ...base, fill: familyColor(signalFamily(row.signal.type)) };
    if (row.alternatives?.length) {
      const split = row.alternatives.map((a) => (a.signal_ref ? familyColor(signalFamily(a.signal_ref.type)) : "var(--sb-text-tertiary)"));
      return { ...base, fill: split[0], split };
    }
    if (row.status === "declared") return base;
    return row.physical_role === "contact" ? { ...base, state: "unknown" } : base;
  });
}

/** How many device facts a port pin states (unknown facts do not count). */
export function statedFacts(pin: PortPin | undefined): number {
  if (!pin) return 0;
  return [pin.behavior !== "unknown", pin.level.status === "known", pin.impedance.status === "known", pin.coupling !== "unknown", pin.termination !== "unknown", pin.needs_in_cable.length > 0, pin.must_not_connect].filter(Boolean).length;
}
