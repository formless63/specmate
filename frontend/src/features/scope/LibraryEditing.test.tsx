import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import type { ProbeTarget } from "../navigation/url";
import { InterfacePanel } from "../interfaces/InterfacePanel";
import { ProbeProvider } from "../probe";
import { LIBRARY_VIEWS } from "../shell/scope";
import { EditingLens } from "./EditingLens";
import { LibraryView } from "./LibraryView";
import { referenceFromProject } from "./openProbed";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const EDITOR = ["item.create", "design.edit", "design.freeze", "project.edit", "workspace.read"];

function reply(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }

/** The shell's probe, held in state the way the URL holds it. */
function Shell({ initial = null, permissions = EDITOR, children }: { initial?: ProbeTarget | null; permissions?: string[]; children: ReactNode }) {
  const [probe, setProbe] = useState<ProbeTarget | null>(initial);
  const client = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }))[0];
  return <MantineProvider><QueryClientProvider client={client}><PermissionsProvider permissions={permissions}>
    <ProbeProvider probe={probe} onProbe={setProbe}>{children}</ProbeProvider>
  </PermissionsProvider></QueryClientProvider></MantineProvider>;
}

const definitions = [
  { definition_id: "body-1", name: "Synthetic body", kind: "connector_body" },
  { definition_id: "body-2", name: "Second body", kind: "connector_body" },
];
const library = definitions.map((d) => ({ record_id: d.definition_id, family: "definition", kind: d.kind, label: d.name, detail: null, created_at: "2026-01-01T00:00:00Z",
  latest_revision: null, latest_revision_id: null, changed_at: null, referenceable: true, referenced: null, used_in_total: 0, used_in: [] }));

function serve(calls: { operation: string; payload: Record<string, unknown> }[] = [], revisions: { revision_id: string; number: number }[] = []) {
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      const command = JSON.parse(String(options.body)); calls.push(command);
      if (command.operation === "interface.create") return reply({ result: { definition_id: "body-new", draft_id: "draft-new", state: "v1", content: { interface: command.payload.interface } } });
      return reply({ result: {} });
    }
    if (url.startsWith("/api/v0/workspace/library?")) return reply({ workspace_id: "w1", family: "definition", project_id: null, results: library, next_after: null });
    if (url.includes("workspace/definitions")) return reply(definitions);
    if (url.includes("access/projects/")) return reply({ project_id: "p1", state: "p-v1" });
    const identity = url.match(/catalog\/definitions\/([^?]+)/);
    if (identity) return reply({ definition_id: identity[1], name: identity[1], kind: "connector_body", drafts: [{ draft_id: `${identity[1]}-draft`, state: "v1" }], revisions });
    if (url.includes("interfaces/revisions/")) return reply({ error: { message: "not served in this test" } }, 404);
    const draft = url.match(/interfaces\/drafts\/([^?]+)/);
    if (draft) return reply({ definition_id: "body-1", draft_id: draft[1], state: "v1", content: { interface: { kind: "connector_body", family: null, mating_role: "unknown", drawing_orientation: { viewing_side: "unknown", rotation_degrees: null, datum: null }, contacts: [] } } });
    return reply({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The visible value of a Mantine Select (its hidden form input shares the label). */
const selected = (label: string) => screen.getAllByLabelText(label).filter((input) => input instanceof HTMLInputElement && input.type === "text").map((input) => (input as HTMLInputElement).value)[0] ?? "";

test("a probed library item (a row click or deep link) opens in the editor with its newest draft", async () => {
  serve();
  render(<Shell initial={{ object: "body-2", rev: null, path: [] }}><InterfacePanel /></Shell>);
  await waitFor(() => expect(selected("Existing interface definition")).toBe("Second body (connector_body)"));
  await waitFor(() => expect(selected("Edit interface draft")).toBe("body-2-draft · v1"));
  expect(await screen.findByRole("heading", { name: "Edit draft" })).toBeTruthy();
});

test("Open on a frozen item shows its latest frozen revision first; Continue draft is the explicit way into the editor", async () => {
  serve([], [{ revision_id: "rev-1", number: 1 }, { revision_id: "rev-2", number: 2 }]);
  render(<Shell initial={{ object: "body-2", rev: null, path: [] }}><InterfacePanel /></Shell>);
  await waitFor(() => expect(selected("Inspect frozen interface")).toMatch(/2/));
  expect(selected("Edit interface draft")).toBe("");
  expect(screen.queryByRole("heading", { name: "Edit draft" })).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Continue draft (edit)" }));
  await waitFor(() => expect(selected("Edit interface draft")).toBe("body-2-draft · v1"));
  expect(await screen.findByRole("heading", { name: "Edit draft" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Continue draft (edit)" })).toBeNull();
});

test("at Library scope the list sits above the editor: New focuses creation, Open opens a row's item", async () => {
  serve();
  const view = LIBRARY_VIEWS.interfaces!;
  render(<Shell><EditingLens title={view.title} editor={<InterfacePanel projectId={null} />}
    list={(editor) => <LibraryView view={view} toolLabel="Interfaces" projectId={null} project={null} projects={[]} principalKey="k" onOpenInProject={() => {}} editor={editor} />} /></Shell>);
  expect(await screen.findByRole("heading", { name: "Interfaces in the library" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Interfaces editor" })).toBeTruthy();
  expect(await screen.findByRole("heading", { name: "Bodies, pinouts and boundary mappings" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "New interface record" }));
  expect(screen.getByRole("heading", { name: "New interface record" })).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Definition name" })));
  fireEvent.click(await screen.findByRole("button", { name: "Open Synthetic body in the editor" }));
  await waitFor(() => expect(selected("Existing interface definition")).toBe("Synthetic body (connector_body)"));
  expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
});

test("New is withheld from members who cannot create items", async () => {
  serve();
  const view = LIBRARY_VIEWS.interfaces!;
  render(<Shell permissions={["workspace.read"]}><EditingLens title={view.title} editor={<div />}
    list={(editor) => <LibraryView view={view} toolLabel="Interfaces" projectId={null} project={null} projects={[]} principalKey="k" onOpenInProject={() => {}} editor={editor} />} /></Shell>);
  const button = await screen.findByRole("button", { name: "New interface record" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
});

test("creating with a project as context stores the item in the library and adds that project's reference", async () => {
  const calls: { operation: string; payload: Record<string, unknown> }[] = [];
  serve(calls);
  render(<Shell><InterfacePanel projectId="p1" /></Shell>);
  fireEvent.change(await screen.findByRole("textbox", { name: "Definition name" }), { target: { value: "New body" } });
  fireEvent.click(screen.getByRole("button", { name: "Create interface draft" }));
  await waitFor(() => expect(calls.map((call) => call.operation)).toEqual(["interface.create", "project.add_reference"]));
  expect(calls[0]!.payload).not.toHaveProperty("project_id");
  expect(calls[1]!.payload).toMatchObject({ project_id: "p1", kind: "definition", target_id: "body-new" });
});

test("creating at Library scope adds no project reference", async () => {
  const calls: { operation: string; payload: Record<string, unknown> }[] = [];
  serve(calls);
  render(<Shell><InterfacePanel /></Shell>);
  fireEvent.change(await screen.findByRole("textbox", { name: "Definition name" }), { target: { value: "New body" } });
  fireEvent.click(screen.getByRole("button", { name: "Create interface draft" }));
  await waitFor(() => expect(calls.map((call) => call.operation)).toEqual(["interface.create"]));
});

test("a failed project reference says the item was still saved in the library", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => reply({ error: { message: "Project is archived" } }, 409)));
  await expect(referenceFromProject("p1", "d1", "interface")).rejects.toThrow("Saved in the library, but not added to this project");
  await expect(referenceFromProject(null, "d1", "interface")).resolves.toBeUndefined();
});

test("every library lens names the permission its New action needs", () => {
  for (const view of Object.values(LIBRARY_VIEWS)) expect(view.create).toBeTruthy();
  expect(LIBRARY_VIEWS.sources!.create).toBe("source.register");
  expect(LIBRARY_VIEWS.inventory!.create).toBe("inventory.manage");
});
