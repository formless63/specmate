import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import { ConnectorRecordPage } from "./ConnectorRecordPage";
import { MatingList } from "./Mating";
import { CableEndInspector, PortEditor } from "./PortEditor";
import { initialInterface, unknownPortPin, type CableEnd, type Pinout, type Port } from "./api";

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function select(label: string, option: string | RegExp) {
  const field = await screen.findByRole("combobox", { name: label });
  fireEvent.focus(field); fireEvent.keyDown(field, { key: "ArrowDown" });
  fireEvent.click(await within(screen.getByRole("listbox", { name: label, hidden: true })).findByText(option));
}
function wrap(children: React.ReactNode, permissions = ["workspace.read", "item.create", "design.edit", "design.freeze"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <MantineProvider><QueryClientProvider client={client}><PermissionsProvider permissions={permissions}>{children}</PermissionsProvider></QueryClientProvider></MantineProvider>;
}

const sync = { signal_set_revision_id: "s", key: "composite_sync", name: "Composite sync", type: "sync" as const, set_name: "AV", set_revision_number: 1 };
const power = { ...sync, key: "power_9v", name: "+9 V", type: "power" as const };
const red = { ...sync, key: "video_red", name: "Red video", type: "analog_video" as const };
const VARIANT_END: CableEnd = { kind: "pinout", revision_id: "variant-r1", device_label: null, role: "source", variant_label: "Console AV (regional)", standard: null, pinout_revision_id: "variant-r1", body_revision_id: "body-r1", selected_conditions: {}, compatibility: "not_evaluated", rows: [
  { contact_id: "1", number: "1", label: "1", physical_role: "contact", status: "unknown", reason: "Condition Device region is not selected.", condition_key: "region", hazards: ["may_be_power"], alternatives: [{ choice: "a", role: "signal", signal: null, signal_ref: sync }, { choice: "b", role: "power", signal: null, signal_ref: power }], device: null },
  { contact_id: "4", number: "4", label: "4", physical_role: "contact", status: "declared", role: "signal", signal: red, device: null },
] };
const PINOUT: Pinout = { ...(initialInterface("pinout") as Pinout), body_revision_id: "body-r1", variant_label: "Console AV (regional)", role: "source", conditions: [{ key: "region", name: "Device region", choices: [{ key: "a", name: "Region A" }, { key: "b", name: "Region B" }] }] };

function stub() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    let body: unknown = [];
    if (url.endsWith("/end")) body = VARIANT_END;
    else if (url.includes("interfaces/revisions/")) body = { revision_id: "variant-r1", interface: PINOUT, compatibility: "not_evaluated" };
    else if (url.includes("catalog/definitions/")) body = { definition_id: "variant", name: "Regional console", kind: "pinout", drafts: [], revisions: [{ revision_id: "variant-r1", number: 1 }] };
    else body = [{ definition_id: "variant", name: "Regional console", kind: "pinout" }];
    return new Response(JSON.stringify(body));
  }));
}

let latest: Port | null = null;
function Harness() {
  const [value, setValue] = useState<Port>({ ...(initialInterface("port") as Port), device_label: "Console" });
  latest = value;
  return <PortEditor value={value} onChange={setValue} definitions={[{ definition_id: "variant", name: "Regional console", kind: "pinout" }]} />;
}

test("a port picks its variant, selects a condition and states per-contact device facts", async () => {
  stub();
  render(wrap(<Harness />));
  await select("Pinout variant", "Regional console");
  // The latest frozen revision is selected by default once the variant is chosen.
  await waitFor(() => expect((screen.getByRole("combobox", { name: "Pinout variant revision" }) as HTMLInputElement).value).toMatch(/1/));
  const row = (contact: string) => screen.getByRole("combobox", { name: `Device behavior at contact ${contact}` }).closest("tr") as HTMLElement;
  // Unselected condition: unknown, both possibilities named, flagged as possibly power.
  expect(within(await waitRow(row, "1")).getByText("Signal unknown")).toBeTruthy();
  expect(within(row("1")).getByText("Could be Composite sync or +9 V")).toBeTruthy();
  expect(within(row("1")).getByText("may be power")).toBeTruthy();
  await select("Device region", "Region A");
  expect(within(row("1")).getByText("Composite sync")).toBeTruthy();
  expect(within(row("4")).getByText("Red video")).toBeTruthy();
  await select("Device behavior at contact 4", "Drives");
  fireEvent.change(screen.getByLabelText("Basis at contact 4"), { target: { value: "Synthetic" } });
  fireEvent.change(screen.getByLabelText("Level at contact 4 (blank = unknown)"), { target: { value: "0.7" } });
  await select("Level unit at contact 4", "Vpp");
  fireEvent.click(screen.getByLabelText("Must not connect contact 1"));
  fireEvent.change(screen.getByLabelText("Reason contact 1 must not connect"), { target: { value: "Supply on region B" } });
  expect(latest?.selected_conditions).toEqual({ region: "a" });
  expect(latest?.pinout_revision_id).toBe("variant-r1");
  const four = latest?.pins.find((p) => p.contact_id === "4");
  expect(four).toMatchObject({ behavior: "drives", basis: "Synthetic", level: { status: "known", nominal: 0.7, unit: "Vpp", basis: "Synthetic" }, impedance: { status: "unknown", nominal: null } });
  expect(latest?.pins.find((p) => p.contact_id === "1")).toMatchObject({ must_not_connect: true, must_not_connect_reason: "Supply on region B", behavior: "unknown" });
});

async function waitRow(row: (c: string) => HTMLElement, contact: string) {
  await screen.findByRole("combobox", { name: `Device behavior at contact ${contact}` });
  return row(contact);
}

test("a frozen end hatches every unstated fact and marks must-not-connect pins", async () => {
  const pin = { ...unknownPortPin("4"), behavior: "drives" as const, level: { status: "known" as const, nominal: 0.7, minimum: null, maximum: null, basis: "Synthetic", unit: "Vpp" }, needs_in_cable: [{ conditioning: "series_resistor" as const, value: "470 ohm", basis: "Synthetic" }] };
  const port: CableEnd = { ...VARIANT_END, kind: "port", device_label: "Console AV out", rows: [VARIANT_END.rows[0]!, { ...VARIANT_END.rows[1]!, device: { ...pin, must_not_connect: true, must_not_connect_reason: "Synthetic reason" } }] };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(port))));
  render(wrap(<CableEndInspector revisionId="port-r1" />));
  const four = (await screen.findByText("Red video")).closest("tr") as HTMLElement;
  expect(within(four).getByText("0.7 Vpp")).toBeTruthy();
  expect(within(four).getByText("Impedance unknown")).toBeTruthy();
  expect(within(four).getByText("Coupling unknown")).toBeTruthy();
  expect(within(four).getByText("Series resistor 470 ohm")).toBeTruthy();
  expect(within(four).getByText("Synthetic reason")).toBeTruthy();
  const one = screen.getByText("Signal unknown").closest("tr") as HTMLElement;
  expect(within(one).getByText("Level unknown")).toBeTruthy();
  expect(within(one).getByText("may be power")).toBeTruthy();
  expect(screen.getByText("Console AV out")).toBeTruthy();
});

test("a viewer reads ports but authoring is withheld", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]))));
  render(wrap(<ConnectorRecordPage definitionId={null} revisionNumber={null} draftRequested={false} active principalKey="test" workspaceId="w1" projects={[]} onBack={() => {}} onSelect={() => {}} onCreated={() => {}} onNew={() => {}} onOpen={() => {}} onOpenInProject={() => {}} initial={{ kind: "port" }} />, ["workspace.read"]));
  expect(((await screen.findByText("Save connector")).closest("button") as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Freeze saved connector" }) as HTMLButtonElement).disabled).toBe(true);
});

test("mating lists declared partners, reverse declarations and unreviewed as unknown", () => {
  render(wrap(<MatingList mates={[{ body_revision_id: "s1", name: "Socket", number: 1, mating_role: "receptacle", correspondence: "same_contact_id", pairs: [{ this: "1", other: "1" }], review: "reviewed", basis: "Drawing", status: "reviewed" }]}
    matedBy={[{ body_revision_id: "p2", name: "Other plug", number: 2, declares_revision_id: "x", correspondence: "same_contact_id", review: "unreviewed", status: "unknown" }]} />));
  expect(screen.getByText("Socket r1")).toBeTruthy();
  expect(screen.getByText("reviewed declaration")).toBeTruthy();
  expect(screen.getByText("Other plug r2")).toBeTruthy();
  expect(screen.getByText("unreviewed, unknown")).toBeTruthy();
});

test("without declarations nothing is inferred", () => {
  render(wrap(<MatingList mates={[]} matedBy={[]} />));
  expect(screen.getByText(/Nothing is inferred from the body family/)).toBeTruthy();
});
