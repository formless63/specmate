import { expect, test } from "vitest";
import { initialInterface, unknownElectrical, unknownPortPin, type Contact, type EndRow, type Pinout, type Signal } from "../interfaces/api";
import { assignSignal, clearPin, diffPins, facePins, makeConditional, portFacePins, portRow, rowsFromDraft, rowsFromInspection, usesByKey } from "./model";

const unknown = { status: "unknown", nominal: null, minimum: null, maximum: null, basis: null } as const;
const signal = (key: string, name: string, type: Signal["type"]): Signal => ({ key, name, type, return_for: [], differential_with: null, level: { ...unknown, unit: "unknown" }, impedance: { ...unknown, unit: "ohm" }, notes: null, basis: null });
const SIGNALS = new Map([signal("sync", "Composite sync", "sync"), signal("p9", "+9 V", "power"), signal("luma", "Luma (Y)", "analog_video")].map((s) => [s.key, s]));
const CONTACTS: Contact[] = ["1", "2", "3"].map((id) => ({ contact_id: id, number: id, label: id, physical_role: "contact", position_mm: null }));
const base: Pinout = { ...(initialInterface("pinout") as Pinout), body_revision_id: "body", conditions: [{ key: "region", name: "Device region", choices: [{ key: "a", name: "Region A" }, { key: "b", name: "Region B" }] }] };

test("assigning a signal keeps contact order and suggests a role only when it is unknown", () => {
  let p = assignSignal(base, CONTACTS, "2", SIGNALS.get("p9")!, "set-r1");
  p = assignSignal(p, CONTACTS, "1", SIGNALS.get("sync")!, "set-r1");
  expect(p.assignments.map((a) => a.contact_id)).toEqual(["1", "2"]);
  expect(p.assignments[1]!.electrical).toMatchObject({ role: "power", signal_ref: { signal_set_revision_id: "set-r1", key: "p9" } });
  const declared = { ...p, assignments: p.assignments.map((a) => (a.contact_id === "1" ? { ...a, electrical: { ...a.electrical, role: "unused" } } : a)) };
  expect(assignSignal(declared, CONTACTS, "1", SIGNALS.get("luma")!, "set-r1").assignments[0]!.electrical.role).toBe("unused");
  expect(clearPin(p, CONTACTS, "2").assignments.map((a) => a.contact_id)).toEqual(["1"]);
});

test("draft rows: typed pins are declared, notes alone stay unknown, conditionals list their choices", () => {
  let p = assignSignal(base, CONTACTS, "1", SIGNALS.get("sync")!, "set-r1");
  p = { ...p, assignments: [...p.assignments, { contact_id: "3", electrical: { ...unknownElectrical(), signal: "spare" } }] };
  p = makeConditional(p, CONTACTS, "2", "region");
  p = assignSignal(p, CONTACTS, "2", SIGNALS.get("p9")!, "set-r1", "b");
  const rows = rowsFromDraft(p, CONTACTS, SIGNALS);
  expect(rows.map((r) => r.status)).toEqual(["declared", "conditional", "unknown"]);
  expect(rows[1]!.alternatives.map((a) => [a.choiceName, a.meaning?.name ?? null])).toEqual([["Region A", null], ["Region B", "+9 V"]]);
  expect(rows[2]!.note).toBe("spare");
  const pins = facePins(rows, new Map([["3", ["must-not-connect"]]]));
  expect(pins[0]).toMatchObject({ id: "1", fill: "var(--sb-signal-sync)" });
  expect(pins[0]!.state).toBeUndefined();
  // A conditional pin that may be power is split and carries a hazard ring.
  expect(pins[1]).toMatchObject({ split: ["var(--sb-text-tertiary)", "var(--sb-signal-power)"], rings: ["hazard"] });
  expect(pins[2]).toMatchObject({ state: "unknown", rings: ["must-not-connect"] });
  expect(usesByKey(rows).get("p9")).toBe(1);
});

test("variants compare by signal; unknown equals unknown, never a declared signal", () => {
  const a = rowsFromDraft(assignSignal(assignSignal(base, CONTACTS, "1", SIGNALS.get("sync")!, "s1"), CONTACTS, "2", SIGNALS.get("p9")!, "s1"), CONTACTS, SIGNALS);
  const b = rowsFromInspection(CONTACTS.map((c) => ({ ...c, electrical: null })), {
    "1": { status: "declared", signal: { signal_set_revision_id: "s2", key: "luma", name: "Luma (Y)", type: "analog_video", set_name: "AV", set_revision_number: 2 }, alternatives: [] },
    "2": { status: "declared", signal: { signal_set_revision_id: "s2", key: "p9", name: "+9 V", type: "power", set_name: "AV", set_revision_number: 2 }, alternatives: [] },
  });
  expect(diffPins(a, b)).toEqual([{ contactId: "1", pin: "1", a: "Composite sync", b: "Luma (Y)" }]);
  const withThird = rowsFromDraft(assignSignal(base, CONTACTS, "3", SIGNALS.get("luma")!, "s1"), CONTACTS, SIGNALS);
  expect(diffPins(rowsFromDraft(base, CONTACTS, SIGNALS), withThird).map((d) => [d.pin, d.a, d.b])).toEqual([["3", "unknown", "Luma (Y)"]]);
});

test("port faces ring must-not-connect pins and resolve the port's selected condition", () => {
  const sync = { signal_set_revision_id: "s", key: "sync", name: "Composite sync", type: "sync" as const, set_name: "AV", set_revision_number: 1 };
  const power = { ...sync, key: "p9", name: "+9 V", type: "power" as const };
  const rows: EndRow[] = [
    { contact_id: "1", number: "1", label: "1", physical_role: "contact", status: "unknown", condition_key: "region", hazards: ["may_be_power"], alternatives: [{ choice: "a", role: "signal", signal: null, signal_ref: sync }, { choice: "b", role: "power", signal: null, signal_ref: power }], device: null },
    { contact_id: "2", number: "2", label: "2", physical_role: "contact", status: "unknown", device: null },
  ];
  const pins = portFacePins(rows, [{ ...unknownPortPin("2"), must_not_connect: true, must_not_connect_reason: "Supply" }]);
  expect(pins[0]).toMatchObject({ rings: ["hazard"], split: ["var(--sb-signal-sync)", "var(--sb-signal-power)"] });
  expect(pins[1]).toMatchObject({ state: "unknown", rings: ["must-not-connect"] });
  const chosen = portFacePins(rows.map((r) => portRow(r, { region: "b" })), []);
  expect(chosen[0]).toMatchObject({ fill: "var(--sb-signal-power)", label: "+9 V" });
  expect(chosen[0]!.rings).toBeUndefined();
});
