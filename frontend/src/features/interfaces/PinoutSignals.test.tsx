import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PinSignalCell, PinoutSignalsEditor, PinoutVariantList } from "./PinoutSignals";
import { initialInterface, unknownElectrical, type Contact, type Pinout, type SignalSet } from "./api";

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function select(label: string, option: string | RegExp) {
  const field = await screen.findByRole("combobox", { name: label });
  fireEvent.focus(field); fireEvent.keyDown(field, { key: "ArrowDown" });
  fireEvent.click(await within(screen.getByRole("listbox", { name: label, hidden: true })).findByText(option));
}
function wrap(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <MantineProvider><QueryClientProvider client={client}>{children}</QueryClientProvider></MantineProvider>;
}

const unknown = { status: "unknown", nominal: null, minimum: null, maximum: null, basis: null } as const;
const signal = (key: string, name: string, type: SignalSet["signals"][number]["type"]) => ({ key, name, type, return_for: [], differential_with: null, level: { ...unknown, unit: "unknown" }, impedance: { ...unknown, unit: "ohm" }, notes: null, basis: null });
const SET: SignalSet = { kind: "signal_set", description: null, signals: [signal("composite_sync", "Composite sync", "sync"), signal("power_9v", "+9 V", "power"), signal("video_ground", "Video ground", "ground_return")] };
const CONTACTS: Contact[] = [
  { contact_id: "1", number: "1", label: "1", physical_role: "contact", position_mm: null },
  { contact_id: "2", number: "2", label: "2", physical_role: "contact", position_mm: null },
  { contact_id: "shell", number: null, label: "Shell", physical_role: "shell", position_mm: null },
];

let latest: Pinout | null = null;
function Harness({ start }: { start: Pinout }) {
  const [value, setValue] = useState(start);
  latest = value;
  return <PinoutSignalsEditor value={value} onChange={setValue} contacts={CONTACTS} definitions={[{ definition_id: "set", name: "Workshop AV signals", kind: "signal_set" }]} />;
}

function stubSet() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("catalog/definitions/")
    ? { definition_id: "set", name: "Workshop AV signals", kind: "signal_set", drafts: [], revisions: [{ revision_id: "set-r1", number: 1 }] }
    : { revision_id: "set-r1", interface: SET, compatibility: "not_evaluated" }))));
}

test("signals are picked by name, show their type and suggest a pin role only when it is unknown", async () => {
  stubSet();
  const start = { ...(initialInterface("pinout") as Pinout), body_revision_id: "body-r1", assignments: [{ contact_id: "2", electrical: { ...unknownElectrical(), role: "power" } }] };
  render(wrap(<Harness start={start} />));
  await select("Signal set", "Workshop AV signals");
  await select("Signal set revision", /r1/);
  const row = (contact: string) => screen.getByRole("combobox", { name: `Signal on contact ${contact}` }).closest("tr") as HTMLElement;
  expect(within(row("1")).getByText("Type unknown")).toBeTruthy();
  await select("Signal on contact 1", "Composite sync");
  expect(within(row("1")).getByText("Sync")).toBeTruthy();
  expect(within(row("1")).getByText("signal")).toBeTruthy();
  // A declared role is never overridden by the suggestion; the server checks the fit.
  await select("Signal on contact 2", "Video ground");
  expect(within(row("2")).getByText("power")).toBeTruthy();
  expect(latest?.assignments.map((a) => [a.contact_id, a.electrical.signal_ref, a.electrical.role])).toEqual([
    ["1", { signal_set_revision_id: "set-r1", key: "composite_sync" }, "signal"],
    ["2", { signal_set_revision_id: "set-r1", key: "video_ground" }, "power"],
  ]);
});

test("a conditional pin lists one signal per choice and no unconditional signal", async () => {
  stubSet();
  const start = { ...(initialInterface("pinout") as Pinout), body_revision_id: "body-r1", review_basis: "Synthetic table" };
  render(wrap(<Harness start={start} />));
  await select("Signal set", "Workshop AV signals");
  await select("Signal set revision", /r1/);
  fireEvent.change(screen.getByLabelText("New condition"), { target: { value: "Device region" } });
  fireEvent.change(screen.getByLabelText("Choices (comma separated)"), { target: { value: "Region A, Region B" } });
  fireEvent.click(screen.getByText("Add condition"));
  fireEvent.click(within(screen.getByRole("combobox", { name: "Signal on contact 1" }).closest("tr") as HTMLElement).getByText("Conditional"));
  await select("Signal when region_a", "Composite sync");
  await select("Signal when region_b", "+9 V");
  expect(latest?.conditions).toEqual([{ key: "device_region", name: "Device region", choices: [{ key: "region_a", name: "Region A" }, { key: "region_b", name: "Region B" }] }]);
  expect(latest?.assignments[0]).toMatchObject({ contact_id: "1", electrical: { signal_ref: null }, alternatives: [
    { condition_key: "device_region", choice: "region_a", signal_ref: { key: "composite_sync" }, role: "signal", basis: "Synthetic table" },
    { condition_key: "device_region", choice: "region_b", signal_ref: { key: "power_9v" }, role: "power", basis: "Synthetic table" },
  ] });
});

test("frozen pin cells show name and type, conditional choices, or unknown", () => {
  render(wrap(<>
    <PinSignalCell row={{ status: "declared", signal: { signal_set_revision_id: "s", key: "composite_sync", name: "Composite sync", type: "sync", set_name: "Workshop AV signals", set_revision_number: 1 }, alternatives: [] }} />
    <PinSignalCell row={{ status: "conditional", signal: null, alternatives: [{ condition_key: "region", choice: "b", role: "power", signal: null, signal_ref: { signal_set_revision_id: "s", key: "power_9v", name: "+9 V", type: "power", set_name: "x", set_revision_number: 1 } }] }} />
    <PinSignalCell row={undefined} />
  </>));
  expect(screen.getByText("Composite sync")).toBeTruthy();
  expect(screen.getByText("Workshop AV signals r1")).toBeTruthy();
  expect(screen.getByText("Depends on a condition; unknown until one is selected")).toBeTruthy();
  expect(screen.getByText("region=b")).toBeTruthy();
  expect(screen.getByText("Signal unknown")).toBeTruthy();
});

test("variants of one body are listed together by name with role and standard", () => {
  render(wrap(<PinoutVariantList title="Pinout variants" currentBody="body-r2" variants={[
    { definition_id: "a", name: "Socket Console A AV", revision_id: "a1", number: 1, variant_label: "Console A AV", role: "source", standard: "Synthetic console AV", body_revision_id: "body-r2", same_body_revision: true },
    { definition_id: "b", name: "Socket Console B AV", revision_id: "b1", number: 2, variant_label: "Console B AV", role: "source", standard: null, body_revision_id: "body-r1", same_body_revision: false },
  ]} />));
  expect(screen.getByText("Console A AV")).toBeTruthy();
  expect(screen.getByText("Console B AV")).toBeTruthy();
  expect(screen.getByText("source · standard not stated")).toBeTruthy();
  expect(screen.getByText("Socket Console B AV r2 · pins an earlier body revision")).toBeTruthy();
  expect(screen.getByText(/not electrically interchangeable/)).toBeTruthy();
});
