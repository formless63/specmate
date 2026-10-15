import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import { initialInterface, type Body, type Pinout, type Signal } from "../interfaces/api";
import { PinoutWorkbench } from "./PinoutWorkbench";

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const unknown = { status: "unknown", nominal: null, minimum: null, maximum: null, basis: null } as const;
const signal = (key: string, name: string, type: Signal["type"]): Signal => ({ key, name, type, return_for: [], differential_with: null, level: { ...unknown, unit: "unknown" }, impedance: { ...unknown, unit: "ohm" }, notes: null, basis: null });
const SET = { kind: "signal_set", description: null, signals: [signal("sync", "Composite sync", "sync"), signal("luma", "Luma (Y)", "analog_video"), signal("p9", "+9 V", "power"), signal("gnd", "Video ground", "ground_return")] };
const CONTACTS = Array.from({ length: 10 }, (_, i) => ({ contact_id: String(i + 1), number: String(i + 1), label: String(i + 1), physical_role: "contact" as const, position_mm: null }));
const BODY: Body = { kind: "connector_body", family: "10-pin round DIN", mating_role: "receptacle", geometry_key: "mini-din-10", contacts: CONTACTS, drawing_orientation: { viewing_side: "unknown", rotation_degrees: null, datum: null } };
const resolved = (key: string, name: string, type: Signal["type"]) => ({ status: "declared", signal: { signal_set_revision_id: "set-r1", key, name, type, set_name: "AV", set_revision_number: 1 }, alternatives: [] });
const VARIANT_B = {
  revision_id: "var-b", definition_id: "other", compatibility: "not_evaluated",
  interface: { ...(initialInterface("pinout") as Pinout), body_revision_id: "body-r1", variant_label: "Variant B" },
  contacts: CONTACTS.map((c) => ({ ...c, electrical: null })),
  signals: { "1": resolved("luma", "Luma (Y)", "analog_video") },
  ports: [{ definition_id: "pb", name: "Device B out", revision_id: "pb-r1", number: 1, device_label: "Device B", role: "source", pinout_revision_id: "var-b", same_pinout_revision: true, must_not_connect: [{ contact_id: "8", reason: "Accessory supply" }] }],
};

function stub() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    let body: unknown = [];
    if (url.includes("interfaces/revisions/body-r1")) body = { revision_id: "body-r1", compatibility: "not_evaluated", interface: BODY, pinout_variants: [{ definition_id: "other", name: "Variant B pinout", revision_id: "var-b", number: 1, variant_label: "Variant B", role: "source", standard: null, body_revision_id: "body-r1", same_body_revision: true }] };
    else if (url.includes("interfaces/revisions/set-r1")) body = { revision_id: "set-r1", compatibility: "not_evaluated", interface: SET };
    else if (url.includes("interfaces/revisions/var-b")) body = VARIANT_B;
    else if (url.includes("interfaces/revisions/self-r1")) body = { ...VARIANT_B, revision_id: "self-r1", definition_id: "self", ports: [{ ...VARIANT_B.ports[0], device_label: "Device A", must_not_connect: [{ contact_id: "9", reason: "Supply out" }] }] };
    else if (url.includes("catalog/definitions/self")) body = { definition_id: "self", name: "Variant A pinout", kind: "pinout", drafts: [], revisions: [{ revision_id: "self-r1", number: 1 }] };
    return new Response(JSON.stringify(body));
  }));
}

const START: Pinout = { ...(initialInterface("pinout") as Pinout), body_revision_id: "body-r1", variant_label: "Variant A", assignments: [{ contact_id: "1", electrical: { polarity: "unknown", polarity_basis: null, conditional_ratings: [], signal: null, role: "signal", direction: "unknown", voltage_min_v: null, voltage_max_v: null, current_max_a: null, protocol: null, condition: null, basis: null, signal_ref: { signal_set_revision_id: "set-r1", key: "sync" } } }] };
let latest: Pinout = START;
function Harness() {
  const [value, setValue] = useState<Pinout>(START);
  latest = value;
  return <PinoutWorkbench value={value} onChange={setValue} mode="draft" definitions={[]} definitionId="self" />;
}
function wrap(children: React.ReactNode, permissions = ["workspace.read", "item.create", "design.edit", "design.freeze"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <MantineProvider><QueryClientProvider client={client}><PermissionsProvider permissions={permissions}>{children}</PermissionsProvider></QueryClientProvider></MantineProvider>;
}
const facePin = (n: string) => screen.getByRole("button", { name: new RegExp(`^Pin ${n}, `) });

test("pick a pin on the face (keyboard), then a signal chip from the palette", async () => {
  stub();
  const { container } = render(wrap(<Harness />));
  await waitFor(() => expect(container.querySelector('[data-pin="4"]')).not.toBeNull());
  expect(container.querySelector('[data-pin="4"]')!.getAttribute("data-state")).toBe("unknown");
  fireEvent.keyDown(facePin("4"), { key: "Enter" });
  expect(await screen.findByText("Pin 4")).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "Assign Luma (Y)" }));
  expect(latest.assignments.map((a) => [a.contact_id, a.electrical.signal_ref?.key, a.electrical.role])).toEqual([["1", "sync", "signal"], ["4", "luma", "signal"]]);
  await waitFor(() => expect(container.querySelector('[data-pin="4"]')!.getAttribute("data-state")).toBe("selected"));
  expect(screen.getByRole("button", { name: "Pin 4: Luma (Y)" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear pin" }));
  expect(latest.assignments.map((a) => a.contact_id)).toEqual(["1"]);
});

test("ports ring must-not-connect pins; compare rings and lists pins that differ from another variant", async () => {
  stub();
  const { container } = render(wrap(<Harness />));
  await waitFor(() => expect(container.querySelector('[data-pin="9"] [data-ring="must-not-connect"]')).not.toBeNull());
  fireEvent.click(screen.getByRole("switch", { name: "Compare" }));
  const banner = await screen.findByRole("status");
  expect(banner.textContent).toMatch(/1 pin differs from Variant B/);
  expect(banner.textContent).toContain("Composite sync → Luma (Y)");
  expect(container.querySelector('[data-pin="1"] [data-ring="differs"]')).not.toBeNull();
  expect(container.querySelector('[data-pin="2"] [data-ring="differs"]')).toBeNull();
  // Another variant's tab is shown read-only with its own ports' hazards.
  fireEvent.click(screen.getByRole("tab", { name: /Variant B/ }));
  expect(await screen.findByText(/Viewing frozen variant Variant B/)).toBeTruthy();
  await waitFor(() => expect(container.querySelector('[data-pin="8"] [data-ring="must-not-connect"]')).not.toBeNull());
  fireEvent.click(facePin("8"));
  expect(await screen.findByText("Must not connect on Device B: Accessory supply")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Assign / })).toBeNull();
});

test("a viewer inspects pins but gets no palette or edits", async () => {
  stub();
  const { container } = render(wrap(<Harness />, ["workspace.read"]));
  await waitFor(() => expect(container.querySelector('[data-pin="1"]')).not.toBeNull());
  fireEvent.click(facePin("1"));
  expect(await within(screen.getByRole("complementary", { name: "Pin inspector" })).findByText("Composite sync")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Assign / })).toBeNull();
  expect(screen.queryByRole("button", { name: "Clear pin" })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "Table" }));
  expect(await screen.findByRole("button", { name: "Select pin 1" })).toBeTruthy();
});
