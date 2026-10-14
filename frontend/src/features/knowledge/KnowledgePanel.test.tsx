import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { KnowledgePanel } from "./KnowledgePanel";
import type { Item, Link } from "./api";
import { PermissionsProvider } from "../../lib/permissions";

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function wrap(child: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <MantineProvider><QueryClientProvider client={client}>{child}</QueryClientProvider></MantineProvider>;
}

async function select(label: string, text: string) {
  const input = screen.getByRole("combobox", { name: label });
  fireEvent.focus(input); fireEvent.keyDown(input, { key: "ArrowDown" });
  const options = screen.getByRole("listbox", { name: label, hidden: true });
  fireEvent.click(await within(options).findByText(text, { exact: true }));
}

const r1 = { kind: "revision" as const, revision_id: "rev-1", feature_id: null };
function link(id: string, label: string, target: Link["target"], status: Link["status"] = "active"): Link {
  return { link_id: id, item_id: "item-1", target, workspace_id: "ws-1", label, linked_at: "2026-01-01T00:00:00Z", status, ...(status === "removed" ? { removed_at: "2026-01-02T00:00:00Z", removal_reason: "Applies to the unit only." } : {}) };
}
function item(overrides: Partial<Item> = {}): Item {
  const attachment = { bundle_revision_id: "src-1", path: "photos/joint.png", label: "Joint", bundle_id: "bundle-1", bundle_name: "Bench photos", revision_number: 1, sha256: "a".repeat(64), size: 33, media_type: "image/png", rights: "synthetic-original", blob_workspace_id: "ws-1" };
  const entry = { entry_id: "entry-1", number: 1, title: "Joint photo", body: "Synthetic bench note.", decision_status: null, author: "user", created_at: "2026-01-01T00:00:00Z", attachments: [attachment] };
  return { item_id: "item-1", workspace_id: "ws-1", project_id: "project-1", kind: "attachment", state: "knowledge-v1", current: entry, history: [entry], links: [link("l-rev", "Synthetic bracket revision 1", r1), link("l-occ", "Synthetic frame / left", { kind: "occurrence", snapshot_id: "snap", path: ["left"], feature_id: null }), link("l-unit", "Unit SYN-001", { kind: "physical_unit", unit_id: "unit-1" })], removed_links: [], relation_to_design_state: "attached_knowledge", ...overrides };
}

type Call = { url: string; body: { operation: string; payload: Record<string, unknown>; expected_state?: string; idempotency_key?: string } };
function server(handlers: { item?: () => Item; post?: (call: Call["body"]) => { status?: number; body: unknown } } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST" && typeof options.body === "string") {
      const body = JSON.parse(options.body); calls.push({ url, body });
      const reply = body.operation === "knowledge.for_target"
        ? { body: { result: { target: { label: "Synthetic bracket revision 1", target: r1 }, items: [{ ...item(), link_id: "l-rev" }], offset: 0, limit: 50, has_more: false } } }
        : handlers.post?.(body) ?? { body: { result: {} } };
      return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
    }
    if (url.includes("knowledge/workspaces/")) return new Response(JSON.stringify({ items: [item()], offset: 0, limit: 50, has_more: false }), { status: 200 });
    if (url.includes("knowledge/items/")) return new Response(JSON.stringify((handlers.item ?? item)()), { status: 200 });
    if (url.includes("/definitions/")) return new Response(JSON.stringify({ definition_id: "def-1", name: "Synthetic bracket", kind: "part", revisions: [{ revision_id: "rev-1", number: 1 }, { revision_id: "rev-2", number: 2 }], drafts: [] }), { status: 200 });
    if (url.includes("/definitions")) return new Response(JSON.stringify([{ definition_id: "def-1", name: "Synthetic bracket", kind: "part" }]), { status: 200 });
    if (url.includes("sources/workspaces/")) return new Response(JSON.stringify({ revisions: [], next_after: null }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  }));
  return calls;
}

test("a reader sees one item's exact links and attachment provenance without edit controls", async () => {
  server({ item: () => item({ removed_links: [link("l-old", "Synthetic bracket revision 2", { kind: "revision", revision_id: "rev-2" }, "removed")] }) });
  render(wrap(<KnowledgePanel workspaceId="ws-1" projectId="project-1" canEdit={false} />));
  fireEvent.click((await screen.findAllByRole("button", { name: "Open Joint photo" }))[0]!);
  const links = await screen.findByRole("table", { name: "Active links" });
  for (const label of ["Synthetic bracket revision 1", "Synthetic frame / left", "Unit SYN-001"]) expect(within(links).getByText(label)).toBeTruthy();
  const attachments = screen.getByRole("table", { name: "Current attachments" });
  expect(within(attachments).getByText("synthetic-original")).toBeTruthy();
  expect(within(attachments).getByText("image/png · 33 bytes")).toBeTruthy();
  expect(within(attachments).getByText("Joint").closest("a")?.getAttribute("href")).toBe("/api/v0/sources/revisions/src-1/file?path=photos%2Fjoint.png");
  expect(within(screen.getByRole("table", { name: "Removed links" })).getByText("Applies to the unit only.")).toBeTruthy();
  expect(screen.queryAllByRole("button", { name: /Unlink/ })).toHaveLength(0);
  expect(screen.queryByText("Record knowledge")).toBeNull();
  expect(screen.queryByText("Revise content")).toBeNull();
});

test("an editor chooses an exact revision, sees linked items and creates a note linked to it", async () => {
  const calls = server({ post: () => ({ body: { result: item({ kind: "note", item_id: "item-2" }) } }) });
  render(wrap(<KnowledgePanel workspaceId="ws-1" projectId="project-1" canEdit />));
  await select("Knowledge definition", "Synthetic bracket (part)");
  await select("Knowledge exact revision", "Revision 1");
  fireEvent.click(screen.getByRole("button", { name: "Show knowledge for this object" }));
  expect(await screen.findByText("Linked to Synthetic bracket revision 1")).toBeTruthy();
  expect(await screen.findAllByRole("button", { name: "Open Joint photo" })).toHaveLength(2);
  const lookupCall = calls.find((c) => c.body.operation === "knowledge.for_target")!;
  expect(lookupCall.body.payload).toMatchObject({ target: r1 });
  expect(lookupCall.body.idempotency_key).toBeUndefined();
  fireEvent.change(screen.getByLabelText("Knowledge title"), { target: { value: "Clearance reminder" } });
  fireEvent.change(screen.getByLabelText("Knowledge text"), { target: { value: "Synthetic note text." } });
  fireEvent.click(screen.getByRole("button", { name: "Create knowledge item" }));
  await waitFor(() => expect(calls.some((c) => c.body.operation === "knowledge.create")).toBe(true));
  const create = calls.find((c) => c.body.operation === "knowledge.create")!;
  expect(create.body.payload).toEqual({ workspace_id: "ws-1", project_id: "project-1", kind: "note", content: { title: "Clearance reminder", body: "Synthetic note text.", decision_status: null, attachments: [] }, links: [r1] });
  expect(create.body.idempotency_key).toBeTruthy();
});

test("unlinking one object records a reason and keeps the item, attachment and other links", async () => {
  let unlinked = false;
  const calls = server({
    item: () => unlinked ? item({ links: item().links.slice(1), removed_links: [{ ...item().links[0]!, status: "removed", removed_at: "2026-01-02T00:00:00Z", removal_reason: "Unit only." }] }) : item(),
    post: (body) => { if (body.operation === "knowledge.unlink") unlinked = true; return { body: { result: {} } }; },
  });
  render(wrap(<KnowledgePanel workspaceId="ws-1" projectId="project-1" canEdit target={r1} />));
  fireEvent.click((await screen.findAllByRole("button", { name: "Open Joint photo" }))[0]!);
  fireEvent.change(await screen.findByLabelText("Unlink reason"), { target: { value: "Unit only." } });
  fireEvent.click(screen.getByRole("button", { name: "Unlink Synthetic bracket revision 1" }));
  await waitFor(() => expect(within(screen.getByRole("table", { name: "Removed links" })).getByText("Unit only.")).toBeTruthy());
  expect(calls.find((c) => c.body.operation === "knowledge.unlink")!.body.payload).toEqual({ link_id: "l-rev", reason: "Unit only." });
  const active = screen.getByRole("table", { name: "Active links" });
  expect(within(active).queryByText("Synthetic bracket revision 1")).toBeNull();
  expect(within(active).getByText("Unit SYN-001")).toBeTruthy();
  expect(within(screen.getByRole("table", { name: "Current attachments" })).getByText("Joint")).toBeTruthy();
  expect(screen.queryByLabelText("Knowledge target kind")).toBeNull();
});

test("relinking reports no duplicate and a stale revision shows the conflict", async () => {
  const calls = server({ post: (body) => body.operation === "knowledge.link"
    ? { body: { result: { ...item().links[0], created: false } } }
    : { status: 409, body: { error: { code: "conflict", message: "Knowledge item changed. Nothing was overwritten; review the current entry." } } } });
  render(wrap(<KnowledgePanel workspaceId="ws-1" projectId="project-1" canEdit target={r1} />));
  fireEvent.click((await screen.findAllByRole("button", { name: "Open Joint photo" }))[0]!);
  fireEvent.click(await screen.findByRole("button", { name: "Link to the chosen object" }));
  expect(await screen.findByText("Already linked to Synthetic bracket revision 1; no duplicate link was created.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Revise content" }));
  const titles = screen.getAllByLabelText("Knowledge title");
  fireEvent.change(titles[titles.length - 1]!, { target: { value: "Joint photo, retaken" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Save new entry" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Save new entry" }));
  expect(await screen.findByText("Knowledge item changed. Nothing was overwritten; review the current entry.")).toBeTruthy();
  const revise = calls.find((c) => c.body.operation === "knowledge.revise")!;
  expect(revise.body.expected_state).toBe("knowledge-v1");
  expect(revise.body.payload).toMatchObject({ item_id: "item-1", content: { title: "Joint photo, retaken", attachments: [{ bundle_revision_id: "src-1", path: "photos/joint.png", label: "Joint" }] } });
});

test("a new attachment is preserved through source operations before it is referenced", async () => {
  const calls = server({ post: (body) => body.operation === "source.create_original_bundle" ? { body: { result: { revision_id: "src-9" } } } : { body: { result: item({ item_id: "item-9" }) } } });
  const uploads: string[] = [];
  const base = globalThis.fetch as unknown as (url: string, options?: RequestInit) => Promise<Response>;
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.body instanceof FormData) { uploads.push(url); return new Response(JSON.stringify({ result: {} }), { status: 200 }); }
    return base(url, options);
  }));
  render(wrap(<KnowledgePanel workspaceId="ws-1" projectId="project-1" canEdit />));
  await select("Knowledge kind", "Attachment reference");
  fireEvent.change(screen.getByLabelText("Knowledge title"), { target: { value: "Datasheet" } });
  expect(screen.getByRole("button", { name: "Create knowledge item" }).hasAttribute("disabled")).toBe(true);
  const file = new File(["%PDF-1.4 synthetic"], "sheet.pdf", { type: "application/pdf" });
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
  fireEvent.change(screen.getByLabelText(/Declared rights/), { target: { value: "synthetic-original" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Preserve and attach" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Preserve and attach" }));
  expect(await screen.findByText("sheet.pdf · sheet.pdf")).toBeTruthy();
  expect(uploads).toEqual(["/api/v0/workspaces/ws-1/blobs"]);
  const bundle = calls.find((c) => c.body.operation === "source.create_original_bundle")!;
  expect(bundle.body.payload).toMatchObject({ workspace_id: "ws-1", files: [{ path: "sheet.pdf", media_type: "application/pdf", rights: "synthetic-original" }] });
  fireEvent.click(screen.getByRole("button", { name: "Create knowledge item" }));
  await waitFor(() => expect(calls.some((c) => c.body.operation === "knowledge.create")).toBe(true));
  expect(calls.find((c) => c.body.operation === "knowledge.create")!.body.payload).toMatchObject({ kind: "attachment", content: { attachments: [{ bundle_revision_id: "src-9", path: "sheet.pdf", label: "" }] }, links: [] });
});

test("a denied current target refresh removes previously cached labels and linked rows", async () => {
  server();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={client}><KnowledgePanel workspaceId="ws-1" projectId="project-1" canEdit={false} target={r1} /></QueryClientProvider></MantineProvider>);
  expect(await screen.findByText("Linked to Synthetic bracket revision 1")).toBeTruthy();
  const previous = globalThis.fetch as typeof fetch;
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST") return new Response(JSON.stringify({ error: { code: "not_found", message: "Project not found." } }), { status: 404 });
    return previous(url, options);
  }));
  await client.invalidateQueries({ queryKey: ["knowledge-target"] });
  expect(await screen.findByText("Project not found.")).toBeTruthy();
  expect(screen.queryByText("Linked to Synthetic bracket revision 1")).toBeNull();
});

test("a revision keeps its opened CAS token when current knowledge refreshes", async () => {
  let current = item();
  const calls = server({ item: () => current, post: () => ({ status: 409, body: { error: { message: "Stale edit preserved." } } }) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={client}><KnowledgePanel workspaceId="ws-1" projectId="project-1" canEdit target={r1} /></QueryClientProvider></MantineProvider>);
  fireEvent.click((await screen.findAllByRole("button", { name: "Open Joint photo" }))[0]!);
  fireEvent.click(await screen.findByRole("button", { name: "Revise content" }));
  const titles = screen.getAllByLabelText("Knowledge title");
  fireEvent.change(titles[titles.length - 1]!, { target: { value: "Unsaved original edit" } });
  current = item({ state: "knowledge-v2", current: { ...item().current, number: 2, title: "Concurrent edit" } });
  await client.invalidateQueries({ queryKey: ["knowledge-item"] });
  expect(await screen.findByRole("heading", { name: "Concurrent edit" })).toBeTruthy();
  await waitFor(() => expect(screen.getByRole("button", { name: "Save new entry" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Save new entry" }));
  await waitFor(() => expect(calls.some(call => call.body.operation === "knowledge.revise")).toBe(true));
  expect(calls.find(call => call.body.operation === "knowledge.revise")!.body.expected_state).toBe("knowledge-v1");
});

test("source denial and recovery preserve staged content rights attachments and original CAS", async () => {
  let denied = false;
  let current = item();
  const calls = server({ item: () => current, post: () => ({ status: 409, body: { error: { message: "Original edit is stale." } } }) });
  const base = globalThis.fetch as typeof fetch;
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (denied && (url.includes("knowledge/items/") || url.includes("sources/"))) return new Response(JSON.stringify({ error: { message: "Source unavailable." } }), { status: 404 });
    return base(url, options);
  }));
  const lost = vi.fn();
  render(wrap(<KnowledgePanel workspaceId="ws-1" projectId="project-1" principalKey="owner" canEdit target={r1} onAccessLost={lost} />));
  fireEvent.click((await screen.findAllByRole("button", { name: "Open Joint photo" }))[0]!);
  fireEvent.click(await screen.findByRole("button", { name: "Revise content" }));
  fireEvent.change(screen.getAllByLabelText("Knowledge title").at(-1)!, { target: { value: "Own staged title" } });
  fireEvent.change(screen.getAllByLabelText("Knowledge text").at(-1)!, { target: { value: "Own staged body" } });
  fireEvent.change(screen.getAllByLabelText(/Declared rights/).at(-1)!, { target: { value: "own-staged-rights" } });
  denied = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh current knowledge authority" }));
  await waitFor(() => expect(lost).toHaveBeenCalled());
  expect(screen.queryByRole("table", { name: "Current attachments" })).toBeNull();
  expect(screen.queryByRole("table", { name: "Active links" })).toBeNull();
  expect(screen.getByDisplayValue("Own staged title")).toBeTruthy();
  expect(screen.getByDisplayValue("Own staged body")).toBeTruthy();
  expect(screen.getByDisplayValue("own-staged-rights")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save new entry" }).hasAttribute("disabled")).toBe(true);
  denied = false;
  current = item({ state: "knowledge-v2", current: { ...item().current, number: 2, title: "Current separately revised title" } });
  fireEvent.click(screen.getByRole("button", { name: "Refresh current knowledge authority" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save new entry" }).hasAttribute("disabled")).toBe(false));
  expect(screen.getByDisplayValue("Own staged title")).toBeTruthy();
  expect(screen.getByDisplayValue("own-staged-rights")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save new entry" }));
  await waitFor(() => expect(calls.some(call => call.body.operation === "knowledge.revise")).toBe(true));
  const saved = calls.find(call => call.body.operation === "knowledge.revise")!.body;
  expect(saved.expected_state).toBe("knowledge-v1");
  expect(saved.payload).toMatchObject({ content: { title: "Own staged title", body: "Own staged body", attachments: [{ bundle_revision_id: "src-1", path: "photos/joint.png", label: "Joint" }] } });
});

test("a held current authority refresh hides results while preserving inert staged inputs", async () => {
  server();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={client}><KnowledgePanel workspaceId="ws-1" projectId="project-1" canEdit target={r1} /></QueryClientProvider></MantineProvider>);
  fireEvent.click((await screen.findAllByRole("button", { name: "Open Joint photo" }))[0]!);
  fireEvent.click(await screen.findByRole("button", { name: "Revise content" }));
  fireEvent.change(screen.getAllByLabelText("Knowledge title").at(-1)!, { target: { value: "Held own edit" } });
  const base = globalThis.fetch as typeof fetch;
  let finish!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => url.includes("knowledge/items/") ? new Promise<Response>(resolve => { finish = resolve; }) : base(url, options)));
  void client.invalidateQueries({ queryKey: ["knowledge-item"] });
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  await waitFor(() => expect(screen.queryByRole("table", { name: "Active links" })).toBeNull());
  expect(screen.queryByText("Linked to Synthetic bracket revision 1")).toBeNull();
  expect(screen.getByDisplayValue("Held own edit")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save new entry" }).hasAttribute("disabled")).toBe(true);
  finish(new Response(JSON.stringify(item()), { status: 200 }));
  expect(await screen.findByRole("table", { name: "Active links" })).toBeTruthy();
});

test.each(["principal", "project"])("late old %s query data cannot populate the new reader scope", async scopeChange => {
  server();
  const base = globalThis.fetch as typeof fetch;
  let principal = "owner";
  let workspace = "ws-1";
  let pending = true;
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (url.includes("knowledge/workspaces/")) return pending ? new Promise<Response>(resolve => { finish = resolve; }) : new Response(JSON.stringify({ items: [], offset: 0, limit: 50, has_more: false }), { status: 200 });
    return base(url, options);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<MantineProvider><QueryClientProvider client={client}><KnowledgePanel workspaceId={workspace} canEdit={false} principalKey={principal} /></QueryClientProvider></MantineProvider>);
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  pending = false;
  if (scopeChange === "principal") principal = "reader"; else workspace = "ws-2";
  view.rerender(<MantineProvider><QueryClientProvider client={client}><KnowledgePanel workspaceId={workspace} canEdit={false} principalKey={principal} /></QueryClientProvider></MantineProvider>);
  expect(await screen.findByText("No knowledge items yet.")).toBeTruthy();
  finish(new Response(JSON.stringify({ items: [item()], offset: 0, limit: 50, has_more: false }), { status: 200 }));
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(screen.queryByRole("button", { name: "Open Joint photo" })).toBeNull();
  expect(JSON.stringify(client.getQueryCache().getAll().map(query => query.state.data))).not.toContain("Joint photo");
});

test("late upload cannot create a source bundle or attach into a changed principal", async () => {
  const calls = server();
  const base = globalThis.fetch as typeof fetch;
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => options?.body instanceof FormData ? new Promise<Response>(resolve => { finish = resolve; }) : base(url, options)));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<MantineProvider><QueryClientProvider client={client}><KnowledgePanel workspaceId="ws-1" projectId="project-1" canEdit principalKey="owner" /></QueryClientProvider></MantineProvider>);
  await screen.findByRole("button", { name: "Open Joint photo" });
  fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(["own synthetic bytes"], "own.pdf", { type: "application/pdf" })] } });
  fireEvent.change(screen.getByLabelText(/Declared rights/), { target: { value: "own-rights" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Preserve and attach" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Preserve and attach" }));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  view.rerender(<MantineProvider><QueryClientProvider client={client}><KnowledgePanel workspaceId="ws-1" projectId="project-1" canEdit={false} principalKey="reader" /></QueryClientProvider></MantineProvider>);
  finish(new Response(JSON.stringify({ result: {} }), { status: 200 }));
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(calls.filter(call => call.body.operation === "source.create_original_bundle")).toHaveLength(0);
  expect(screen.queryByDisplayValue("own-rights")).toBeNull();
  expect(screen.queryByRole("button", { name: "Preserve and attach" })).toBeNull();
});

test("an uncertain revision retries the same original payload key and CAS after v2 refresh", async () => {
  let first = true;
  let current = item();
  const calls = server({ item: () => current, post: body => {
    if (body.operation === "knowledge.revise" && first) { first = false; current = item({ state: "knowledge-v2", current: { ...item().current, number: 2 } }); throw new TypeError("Injected lost response after synthetic commit"); }
    return { body: { result: current } };
  } });
  render(wrap(<KnowledgePanel workspaceId="ws-1" projectId="project-1" canEdit target={r1} />));
  fireEvent.click((await screen.findAllByRole("button", { name: "Open Joint photo" }))[0]!);
  fireEvent.click(await screen.findByRole("button", { name: "Revise content" }));
  fireEvent.change(screen.getAllByLabelText("Knowledge title").at(-1)!, { target: { value: "Same prepared revision" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Save new entry" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Save new entry" }));
  expect(await screen.findByText("Injected lost response after synthetic commit")).toBeTruthy();
  await waitFor(() => expect(screen.getByRole("button", { name: "Save new entry" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Save new entry" }));
  await waitFor(() => expect(calls.filter(call => call.body.operation === "knowledge.revise")).toHaveLength(2));
  const [one, two] = calls.filter(call => call.body.operation === "knowledge.revise").map(call => call.body);
  expect(two!.payload).toEqual(one!.payload);
  expect(two!.expected_state).toBe(one!.expected_state);
  expect(two!.expected_state).toBe("knowledge-v1");
  expect(two!.idempotency_key).toBe(one!.idempotency_key);
});

test("late lookup from a previous exact fixed target cannot replace the selected target", async () => {
  server();
  const base = globalThis.fetch as typeof fetch;
  let finish!: (response: Response) => void;
  const second = { kind: "revision" as const, revision_id: "rev-2", feature_id: null };
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "POST" && JSON.parse(options.body as string).operation === "knowledge.for_target") {
      const target = JSON.parse(options.body as string).payload.target;
      return target.revision_id === "rev-1" ? new Promise<Response>(resolve => { finish = resolve; }) : new Response(JSON.stringify({ result: { target: { target, label: "Selected second revision" }, items: [], offset: 0, limit: 50, has_more: false } }), { status: 200 });
    }
    return base(url, options);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<MantineProvider><QueryClientProvider client={client}><KnowledgePanel workspaceId="ws-1" projectId="project-1" canEdit={false} target={r1} /></QueryClientProvider></MantineProvider>);
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  view.rerender(<MantineProvider><QueryClientProvider client={client}><KnowledgePanel workspaceId="ws-1" projectId="project-1" canEdit={false} target={second} /></QueryClientProvider></MantineProvider>);
  expect(await screen.findByText("Linked to Selected second revision")).toBeTruthy();
  finish(new Response(JSON.stringify({ result: { target: { target: r1, label: "Forbidden previous result" }, items: [], offset: 0, limit: 50, has_more: false } }), { status: 200 }));
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(screen.queryByText("Linked to Forbidden previous result")).toBeNull();
});

test("an uncertain create retries one prepared knowledge identity", async () => {
  let first = true;
  const calls = server({ post: body => {
    if (body.operation === "knowledge.create" && first) { first = false; throw new TypeError("Injected create response loss"); }
    return { body: { result: item() } };
  } });
  render(wrap(<KnowledgePanel workspaceId="ws-1" projectId="project-1" canEdit />));
  await screen.findByRole("button", { name: "Open Joint photo" });
  fireEvent.change(screen.getByLabelText("Knowledge title"), { target: { value: "Prepared own note" } });
  fireEvent.change(screen.getByLabelText("Knowledge text"), { target: { value: "Synthetic own content." } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Create knowledge item" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Create knowledge item" }));
  expect(await screen.findByText("Injected create response loss")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Create knowledge item" }));
  await waitFor(() => expect(calls.filter(call => call.body.operation === "knowledge.create")).toHaveLength(2));
  const [one, two] = calls.filter(call => call.body.operation === "knowledge.create").map(call => call.body);
  expect(two!.payload).toEqual(one!.payload);
  expect(two!.idempotency_key).toBe(one!.idempotency_key);
});

test("a readable linked item held by another workspace remains read only in an editable target workspace", async () => {
  server();
  const base = globalThis.fetch as typeof fetch;
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => url.includes("knowledge/workspaces/ws-2/") ? new Response(JSON.stringify({ items: [], offset: 0, limit: 50, has_more: false }), { status: 200 }) : base(url, options)));
  render(wrap(<KnowledgePanel workspaceId="ws-2" canEdit target={r1} />));
  fireEvent.click(await screen.findByRole("button", { name: "Open Joint photo" }));
  expect(await screen.findByRole("table", { name: "Current attachments" })).toBeTruthy();
  expect(screen.queryAllByRole("button", { name: /Unlink/ })).toHaveLength(0);
  expect(screen.queryByRole("button", { name: "Revise content" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Link to the chosen object" })).toBeNull();
});

test("strict lifecycle replay still refreshes current authority and hides denied data", async () => {
  server();
  const { StrictMode } = await import("react");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<StrictMode><MantineProvider><QueryClientProvider client={client}><KnowledgePanel workspaceId="ws-1" projectId="project-1" canEdit={false} target={r1} /></QueryClientProvider></MantineProvider></StrictMode>);
  expect(await screen.findByText("Linked to Synthetic bracket revision 1")).toBeTruthy();
  const base = globalThis.fetch as typeof fetch;
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => options?.method === "POST" ? new Response(JSON.stringify({ error: { message: "Current target denied." } }), { status: 404 }) : base(url, options)));
  fireEvent.click(screen.getByRole("button", { name: "Refresh current knowledge authority" }));
  expect(await screen.findByText("Current target denied.")).toBeTruthy();
  expect(screen.queryByText("Linked to Synthetic bracket revision 1")).toBeNull();
});

test.each([
  ["editor without source registration", ["project.read", "item.create", "design.edit"], true],
  ["editor with source registration", ["project.read", "item.create", "design.edit", "source.register"], false],
] as const)("%s: attachment upload follows the source registration permission", async (_name, permissions, off) => {
  server();
  render(wrap(<PermissionsProvider permissions={[...permissions]}><KnowledgePanel workspaceId="ws-1" projectId="project-1" canEdit /></PermissionsProvider>));
  await select("Knowledge kind", "Attachment reference");
  const file = new File(["%PDF-1.4 synthetic"], "sheet.pdf", { type: "application/pdf" });
  fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
  fireEvent.change(screen.getByLabelText(/Declared rights/), { target: { value: "synthetic-original" } });
  const upload = screen.getByRole("button", { name: "Preserve and attach" }) as HTMLButtonElement;
  expect(upload.hasAttribute("data-readonly-reason")).toBe(off);
  if (off) expect(upload.disabled).toBe(true);
  else await waitFor(() => expect((screen.getByRole("button", { name: "Preserve and attach" }) as HTMLButtonElement).disabled).toBe(false));
  expect(upload.title).toBe(off ? "Read-only access: requires Source registration" : "");
});
