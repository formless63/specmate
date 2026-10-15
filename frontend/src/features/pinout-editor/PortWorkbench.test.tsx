import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import { initialInterface, unknownPortPin, type Body, type CableEnd, type Port } from "../interfaces/api";
import { GeometryPicker, geometryChoices } from "./GeometryPicker";
import { PortWorkbench } from "./PortWorkbench";

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function wrap(children: React.ReactNode, permissions = ["workspace.read", "item.create", "design.edit"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <MantineProvider><QueryClientProvider client={client}><PermissionsProvider permissions={permissions}>{children}</PermissionsProvider></QueryClientProvider></MantineProvider>;
}

const CONTACTS = Array.from({ length: 10 }, (_, i) => ({ contact_id: String(i + 1), number: String(i + 1), label: String(i + 1), physical_role: "contact" as const, position_mm: null }));
const BODY: Body = { kind: "connector_body", family: "10-pin round DIN", mating_role: "receptacle", geometry_key: "mini-din-10", contacts: CONTACTS, drawing_orientation: { viewing_side: "unknown", rotation_degrees: null, datum: null } };
const power = { signal_set_revision_id: "s", key: "p9", name: "+9 V", type: "power" as const, set_name: "AV", set_revision_number: 1 };
const END: CableEnd = { kind: "pinout", revision_id: "v1", device_label: null, role: "source", variant_label: "Variant A", standard: null, pinout_revision_id: "v1", body_revision_id: "body-r1", selected_conditions: {}, compatibility: "not_evaluated",
  rows: CONTACTS.map((c) => ({ ...c, status: c.contact_id === "8" ? "declared" as const : "unknown" as const, ...(c.contact_id === "8" ? { role: "power", signal: power } : {}), device: null })) };

let latest: Port | null = null;
function Harness({ start }: { start: Port }) {
  const [value, setValue] = useState(start);
  latest = value;
  return <PortWorkbench value={value} onChange={setValue} mode="draft" table={<p>table</p>} />;
}

test("a port draws its variant on the body face; per-pin device facts are edited in the inspector", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/end") ? END : { revision_id: "body-r1", interface: BODY, compatibility: "not_evaluated" }))));
  const start: Port = { ...(initialInterface("port") as Port), device_label: "Device A", pinout_revision_id: "v1", pins: [{ ...unknownPortPin("8"), must_not_connect: true, must_not_connect_reason: "Accessory supply" }] };
  const { container } = render(wrap(<Harness start={start} />));
  await waitFor(() => expect(container.querySelector('[data-pin="8"] [data-ring="must-not-connect"]')).not.toBeNull());
  expect(container.querySelector('[data-pin="8"]')!.getAttribute("data-state")).toBe("none");
  expect(container.querySelector('[data-pin="3"]')!.getAttribute("data-state")).toBe("unknown");
  fireEvent.click(screen.getByRole("button", { name: /^Pin 4, / }));
  const inspector = within(screen.getByRole("complementary", { name: "Pin inspector" }));
  fireEvent.click(inspector.getByRole("radio", { name: "Accepts" }));
  fireEvent.change(inspector.getByLabelText("Impedance, ohm (blank = unknown)"), { target: { value: "75" } });
  fireEvent.click(inspector.getByRole("radio", { name: "AC" }));
  expect(latest!.pins.map((p) => p.contact_id)).toEqual(["4", "8"]);
  expect(latest!.pins[0]).toMatchObject({ behavior: "accepts", coupling: "ac", impedance: { status: "known", nominal: 75, unit: "ohm" }, level: { status: "unknown" } });
  fireEvent.click(screen.getByRole("radio", { name: "Table" }));
  expect(screen.getByText("table")).toBeTruthy();
});

test("a frozen port shows facts read-only in the inspector", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/end") ? END : { revision_id: "body-r1", interface: BODY, compatibility: "not_evaluated" }))));
  const port: Port = { ...(initialInterface("port") as Port), device_label: "Device A", pinout_revision_id: "v1", pins: [{ ...unknownPortPin("8"), must_not_connect: true, must_not_connect_reason: "Accessory supply" }] };
  render(wrap(<PortWorkbench value={port} mode="frozen" table={null} />));
  fireEvent.click(await screen.findByRole("button", { name: /^Pin 8, / }));
  const inspector = within(screen.getByRole("complementary", { name: "Pin inspector" }));
  expect(inspector.getByText("Must not connect: Accessory supply")).toBeTruthy();
  expect(inspector.getByText("Impedance unknown")).toBeTruthy();
  expect(inspector.queryByRole("radio")).toBeNull();
});

test("the face picker offers only faces with the body's contact count and sets the draft key", () => {
  const keys = geometryChoices(10, "receptacle").map((c) => c.key);
  expect(keys).toContain("mini-din-10");
  expect(keys).not.toContain("de-9");
  expect(geometryChoices(9, "plug").map((c) => c.key)).toContain("de-9");
  const onChange = vi.fn();
  render(wrap(<GeometryPicker body={{ ...BODY, geometry_key: null }} onChange={onChange} />));
  fireEvent.click(screen.getByRole("button", { name: /^Draw as Mini-DIN 10/ }));
  expect(onChange.mock.calls[0]![0]).toMatchObject({ geometry_key: "mini-din-10", contacts: CONTACTS });
});

test("a body without contacts can take a picked face's positions as contacts", () => {
  const onChange = vi.fn();
  render(wrap(<GeometryPicker body={{ ...BODY, contacts: [], geometry_key: "mini-din-4" }} onChange={onChange} />));
  fireEvent.click(screen.getByRole("button", { name: "Add its 4 positions as contacts" }));
  expect(onChange.mock.calls[0]![0].contacts.map((c: { contact_id: string; physical_role: string }) => `${c.contact_id}:${c.physical_role}`)).toEqual(["1:contact", "2:contact", "3:contact", "4:contact", "shell:shell"]);
});
