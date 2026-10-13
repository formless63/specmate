import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { InterfaceInspector, InterfacePanel } from "./InterfacePanel";
import { initialInterface, type Interface } from "./api";

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function wrap(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <MantineProvider><QueryClientProvider client={client}>{children}</QueryClientProvider></MantineProvider>;
}

test("body create, tokened edit and freeze preserve physical roles and unknown orientation", async () => {
  const calls: { operation: string; expected_state?: string; payload: { interface?: Interface } }[] = [];
  let value = initialInterface("connector_body");
  let state = "draft-v1";
  const draft = () => ({ definition_id: "body", draft_id: "draft", state, content: { interface: value } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    let body: unknown;
    if (options?.method === "POST") {
      const command = JSON.parse(String(options.body)); calls.push(command);
      if (command.payload.interface) value = command.payload.interface;
      if (command.operation === "interface.update") state = "draft-v2";
      body = { result: command.operation === "interface.freeze" ? { revision_id: "exact-body" } : draft() };
    } else if (url.includes("interfaces/drafts/")) body = draft();
    else if (url.includes("interfaces/revisions/")) body = { revision_id: "exact-body", interface: value, compatibility: "not_evaluated" };
    else if (url.includes("catalog/definitions/")) body = { definition_id: "body", name: "Synthetic", kind: "connector_body", drafts: [{ draft_id: "draft", state }], revisions: [{ revision_id: "exact-body", number: 1 }] };
    else body = [{ definition_id: "body", name: "Synthetic", kind: "connector_body" }];
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  render(wrap(<InterfacePanel projectId="project" />));
  fireEvent.change(screen.getByLabelText("Definition name"), { target: { value: "Synthetic" } });
  fireEvent.change(screen.getByLabelText("New physical contact ID"), { target: { value: "a" } });
  fireEvent.click(screen.getByText("Add contact"));
  fireEvent.click(screen.getByText("Create interface draft"));
  const heading = await screen.findByText("Edit draft");
  const editor = within(heading.closest(".mantine-Card-root")! as HTMLElement);
  fireEvent.change(editor.getByLabelText("Body family (blank = unknown)"), { target: { value: "Synthetic family" } });
  fireEvent.click(editor.getByText("Save interface draft"));
  await screen.findByText("draft-v2");
  fireEvent.click(screen.getByText("Freeze interface revision"));
  await screen.findByText("Exact revision exact-body");
  expect(calls).toHaveLength(3);
  expect(calls[0]).toMatchObject({ operation: "interface.create", payload: { project_id: "project", interface: { contacts: [{ contact_id: "a", physical_role: "contact", position_mm: null }], drawing_orientation: { viewing_side: "unknown", rotation_degrees: null, datum: null } } } });
  expect(calls[1]).toMatchObject({ operation: "interface.update", expected_state: "draft-v1", payload: { interface: { family: "Synthetic family" } } });
  expect(calls[2]).toMatchObject({ operation: "interface.freeze", expected_state: "draft-v2" });
});

test("trace exposes the exact repeated occurrence and preserves declaration uncertainty", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/trace?") ? {
    external_contact_id: "a", status: "declared", continuity: "not_evaluated", compatibility: "not_evaluated",
    targets: [{ passage_id: "path", assembly_revision_id: "assembly-rev", snapshot_id: "root-snapshot", path: ["right", "board"], revision_id: "board-rev", feature_id: "header.pin3", condition: null, basis: "Synthetic table", feature_status: "not_evaluated" }],
  } : { revision_id: "mapping-rev", interface: { kind: "interface_map", assembly_revision_id: "assembly-rev", external_pinout_revision_id: "pinout-rev", passages: [] }, compatibility: "not_evaluated" }), { status: 200 })));
  render(wrap(<InterfaceInspector revisionId="mapping-rev" />));
  fireEvent.change(await screen.findByLabelText("External contact to trace"), { target: { value: "a" } });
  fireEvent.click(screen.getByText("Trace declared path"));
  expect(await screen.findByText("a → right / board · header.pin3")).toBeTruthy();
  expect(screen.getByText("Revision board-rev · assembly snapshot root-snapshot")).toBeTruthy();
  expect(screen.getByText("Feature status: not_evaluated; condition: unknown")).toBeTruthy();
  expect(screen.getByText("Path: declared. Continuity: not_evaluated.")).toBeTruthy();
});

test("inaccessible frozen reference displays no pin or path data", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Project not found." } }), { status: 404 })));
  render(wrap(<InterfaceInspector revisionId="restricted" />));
  expect(await screen.findByText("Project not found.")).toBeTruthy();
  expect(screen.queryByText("Trace declared path")).toBeNull();
  await waitFor(() => expect(screen.queryByRole("table")).toBeNull());
});

test("mapping form pins the selected repeated occurrence and its exact revision", async () => {
  const calls: { operation: string; payload: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    let body: unknown;
    if (options?.method === "POST") {
      calls.push(JSON.parse(String(options.body)));
      return new Response(JSON.stringify({ error: { message: "Stop after captured command" } }), { status: 409 });
    }
    if (url.includes("interfaces/revisions/pinout-rev")) body = { interface: { kind: "pinout" }, contacts: [{ contact_id: "a", physical_role: "contact" }] };
    else if (url.includes("revisions/assembly-rev")) body = { snapshot_id: "root-snapshot" };
    else if (url.includes("assemblies/snapshots/")) body = { occurrences: ["left", "right"].map((side) => ({ address: { path: [side, "board"] }, revision_id: "board-rev", name: "Synthetic board", display_ref: "B1" })) };
    else body = [];
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  render(wrap(<InterfacePanel projectId="project" />));
  fireEvent.change(screen.getByLabelText("Definition name"), { target: { value: "Synthetic boundary" } });
  const kind = screen.getByRole("combobox", { name: "Interface definition kind" });
  fireEvent.focus(kind); fireEvent.keyDown(kind, { key: "ArrowDown" });
  fireEvent.click(await within(screen.getByRole("listbox", { name: "Interface definition kind", hidden: true })).findByText("External / internal mapping"));
  fireEvent.change(screen.getByLabelText("Assembly exact revision ID"), { target: { value: "assembly-rev" } });
  fireEvent.change(screen.getByLabelText("External pinout exact revision ID"), { target: { value: "pinout-rev" } });
  const contact = screen.getByRole("combobox", { name: "External contact" });
  fireEvent.focus(contact); fireEvent.keyDown(contact, { key: "ArrowDown" });
  fireEvent.click(await within(screen.getByRole("listbox", { name: "External contact", hidden: true })).findByText("a"));
  const occurrence = screen.getByRole("combobox", { name: "Exact internal occurrence" });
  fireEvent.focus(occurrence); fireEvent.keyDown(occurrence, { key: "ArrowDown" });
  fireEvent.click(await within(screen.getByRole("listbox", { name: "Exact internal occurrence", hidden: true })).findByText("right / board · Synthetic board (B1)"));
  fireEvent.change(screen.getByLabelText("Passage stable ID"), { target: { value: "path-a" } });
  fireEvent.change(screen.getByLabelText("Internal terminal feature ID"), { target: { value: "header.pin3" } });
  fireEvent.change(screen.getByLabelText("Passage declaration basis"), { target: { value: "Synthetic connection table" } });
  fireEvent.click(screen.getByText("Add declared passage"));
  expect(screen.getByText("a → right / board · header.pin3")).toBeTruthy();
  fireEvent.click(screen.getByText("Create interface draft"));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toMatchObject({ operation: "interface.create", payload: { project_id: "project", interface: { kind: "interface_map", assembly_revision_id: "assembly-rev", external_pinout_revision_id: "pinout-rev", passages: [{ local_id: "path-a", external_contact_id: "a", internal: { path: ["right", "board"], revision_id: "board-rev", feature_id: "header.pin3" }, condition: null, basis: "Synthetic connection table", kind: "declared_passage" }] } } });
});
