import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import { record as libraryRecord, reply } from "../../test/workspaceServer";
import { NavigationProvider, useNavigation } from "../navigation";
import { ProbeProvider } from "../probe";
import { CableRecordHost } from "./CableRecordEditor";
import type { Cable, Draft } from "./api";
import { cable } from "../cable-workbench/fixtures";

// The session uses real queries/commands, workbench, history and navigation. Stock/end authoring
// is independently covered by CablePanel tests; these fields isolate session/CAS transitions.
vi.mock("./CablePanel", async () => {
  const { boardEnd, inlineEnd, stock } = await import("../cable-workbench/fixtures");
  return {
    useBodies: () => [],
    useCableSources: () => ({ denied: false, stock: { data: stock() }, resolved: [{ data: boardEnd() }, { data: inlineEnd() }], choices: [], family: {} }),
    CableFields: ({ value, onChange }: { value: Cable; onChange: (c: Cable) => void }) => <input aria-label="Working basis" value={value.review_basis ?? ""} onChange={event => onChange({ ...value, review_basis: event.currentTarget.value })} />,
    EndCard: () => <div>End authoring</div>,
  };
});
vi.mock("../knowledge/KnowledgePanel", () => ({ KnowledgePanel: () => <textarea aria-label="Attached cable note" /> }));
beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function server() {
  let saved = cable(); let state = "v1"; let conflict = false; let deny = false; let failFreeze = false;
  const commands: { operation: string; expected_state?: string; idempotency_key: string; payload: { cable?: Cable } }[] = [];
  const revisions = [{ revision_id: "r1", number: 1 }, { revision_id: "r2", number: 2 }];
  const draft = (): Draft => ({ definition_id: "c1", draft_id: "draft", state, content: { cable: saved } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("catalog/definitions/")) return deny ? reply({ error: { message: "Access withdrawn" } }, 403) : reply({ drafts: [{ draft_id: "draft" }], revisions });
    if (url.includes("cables/drafts/draft")) return reply(draft());
    if (url.includes("cables/revisions/")) return reply({ revision_id: url.includes("r1") ? "r1" : "r2", cable: { ...cable(), review_basis: url.includes("r1") ? "Frozen one" : "Frozen two" }, conductors: [], endpoints: [] });
    if (url.endsWith("/operations")) {
      const command = JSON.parse(String(init?.body)); commands.push(command);
      if (command.operation === "cable.update") {
        if (conflict) return reply({ error: { message: "Saved draft changed elsewhere" } }, 409);
        saved = JSON.parse(JSON.stringify(command.payload.cable, (_key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value)); state = "v2"; return reply({ result: draft() });
      }
      if (command.operation === "cable.freeze") {
        if (failFreeze) return reply({ error: { message: "Response unavailable" } }, 503);
        revisions.push({ revision_id: "r3", number: 3 }); state = "v3";
        return reply({ result: { revision_id: "r3", number: 3, draft: draft() } });
      }
    }
    return reply([]);
  }));
  return { commands, conflict: (value: boolean) => { conflict = value; }, deny: (value: boolean) => { deny = value; }, failFreeze: (value: boolean) => { failFreeze = value; } };
}
function mount(path = "/designs/c1", permissions = ["workspace.read", "design.edit", "design.freeze", "item.create"]) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Routed() {
    const nav = useNavigation()!;
    return <ProbeProvider probe={nav.location.probe} onProbe={probe => nav.navigate({ probe })}>
      <CableRecordHost record={nav.location.probe ? libraryRecord(nav.location.probe.object, "Synthetic cable", { latest_revision: 2 }) : undefined} workspaceId="w1" principalKey="user:w1" active={!!nav.location.probe} />
    </ProbeProvider>;
  }
  render(<MantineProvider><QueryClientProvider client={cache}><PermissionsProvider permissions={permissions}><NavigationProvider history={history}><Routed /></NavigationProvider></PermissionsProvider></QueryClientProvider></MantineProvider>);
  return { history, cache };
}
const tab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));
async function edit() {
  fireEvent.click(await screen.findByRole("button", { name: "Cable versions" }));
  fireEvent.click(await screen.findByRole("button", { name: "Edit current draft" }));
  fireEvent.click(screen.getByRole("button", { name: "Close cable versions" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Cable versions" }).textContent).toContain("draft"));
  tab("Recipe"); return await screen.findByLabelText("Working basis") as HTMLInputElement;
}

test("direct record is drawing first with Issues default and exact revision; view/rail/record changes retain the draft buffer", async () => {
  server(); const { history } = mount("/designs/c1@1");
  expect(await screen.findByRole("group", { name: /^Cable drawing/ })).toBeTruthy();
  expect(screen.getByRole("tab", { name: /^Issues/ }).getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByLabelText("Cable definition")).toBeNull();
  const field = await edit(); fireEvent.change(field, { target: { value: "Unsaved retained" } });
  fireEvent.click(screen.getByRole("radio", { name: "Documents" }));
  expect(screen.getByText("No document viewer is available for this cable.")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Build" }));
  expect((screen.getByLabelText("Working basis") as HTMLInputElement).value).toBe("Unsaved retained");
  act(() => history.push("/library")); act(() => history.push("/designs/c2@1"));
  await screen.findByRole("button", { name: "Cable versions" });
  act(() => history.push("/designs/c1"));
  await waitFor(() => expect((screen.getByLabelText("Working basis") as HTMLInputElement).value).toBe("Unsaved retained"));
});

test("CAS conflict retains working changes and token; successful retry saves with the same deliberate intent key", async () => {
  const api = server(); mount(); const field = await edit();
  fireEvent.change(field, { target: { value: "Keep my changes" } }); api.conflict(true);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("alert"); expect((screen.getByLabelText("Working basis") as HTMLInputElement).value).toBe("Keep my changes");
  expect(api.commands[0]).toMatchObject({ operation: "cable.update", expected_state: "v1", payload: { cable: { review_basis: "Keep my changes" } } });
  api.conflict(false); fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true));
  expect(api.commands[1]!.idempotency_key).toBe(api.commands[0]!.idempotency_key);
});

test("Freeze saves the reviewed working content then freezes exactly the returned CAS state; failed retry keeps its intent", async () => {
  const api = server(); const { history } = mount(); const field = await edit();
  fireEvent.change(field, { target: { value: "Working edit" } });
  fireEvent.click(screen.getByRole("button", { name: "Cable versions" }));
  fireEvent.change(screen.getByLabelText("Freeze review basis"), { target: { value: "Review basis" } });
  api.failFreeze(true); fireEvent.click(screen.getByRole("button", { name: "Freeze next revision" }));
  await screen.findByText("Response unavailable");
  expect(api.commands.map(c => [c.operation, c.expected_state])).toEqual([["cable.update", "v1"], ["cable.freeze", "v2"]]);
  api.failFreeze(false); fireEvent.click(screen.getByRole("button", { name: "Freeze next revision" }));
  await waitFor(() => expect(history.location.pathname).toBe("/designs/c1@3"));
  expect(api.commands[2]).toMatchObject({ operation: "cable.freeze", expected_state: "v2", idempotency_key: api.commands[1]!.idempotency_key });
});

test("current authority failure withdraws the drawing and open Versions metadata; recovery preserves working edits", async () => {
  const api = server(); const { cache } = mount(); const field = await edit();
  fireEvent.change(field, { target: { value: "Private retained buffer" } });
  fireEvent.click(screen.getByRole("button", { name: "Cable versions" }));
  expect(screen.getByRole("button", { name: "Open r1" })).toBeTruthy(); api.deny(true);
  await act(async () => { await cache.invalidateQueries({ queryKey: ["cable-identity"] }); });
  await screen.findByText("Current access must be confirmed before versions can be shown.");
  expect(screen.queryByRole("button", { name: "Open r1" })).toBeNull();
  expect(screen.queryByRole("group", { name: /^Cable drawing/ })).toBeNull();
  api.deny(false); await act(async () => { await cache.invalidateQueries({ queryKey: ["cable-identity"] }); });
  fireEvent.click(screen.getByRole("button", { name: "Close cable versions" })); tab("Recipe");
  expect((screen.getByLabelText("Working basis") as HTMLInputElement).value).toBe("Private retained buffer");
});

test("viewer inspects exact frozen Recipe with no landing handles or draft edit action", async () => {
  server(); mount("/designs/c1@1", ["workspace.read"]);
  await screen.findByRole("group", { name: /^Cable drawing/ }); tab("Recipe");
  expect(screen.getByText("Frozen recipe · exact r1")).toBeTruthy();
  expect(screen.queryByLabelText("Working basis")).toBeNull();
  expect(screen.queryByRole("button", { name: /^Move .* landing/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cable versions" }));
  expect((await screen.findByRole("button", { name: "Edit current draft" }) as HTMLButtonElement).disabled).toBe(true);
});


test("same-record exact Back and Forward keep viewed revision identity separate from the working draft", async () => {
  server(); const { history } = mount("/designs/c1@1");
  await screen.findByRole("group", { name: /^Cable drawing/ }); tab("Recipe");
  expect(screen.getByText("Frozen one")).toBeTruthy();
  const viewed = async (label: string) => { await screen.findByRole("group", { name: /^Cable drawing/ }); tab("Recipe"); await screen.findByText(label); };
  act(() => history.push("/designs/c1@2")); await viewed("Frozen two");
  act(() => history.back()); await viewed("Frozen one");
  act(() => history.forward()); await viewed("Frozen two");
  expect(screen.queryByLabelText("Working basis")).toBeNull();
});


test("phone inspector portal follows the active record and hides on a rail or record change", async () => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })));
  server(); const { history } = mount("/designs/c1@1");
  await screen.findByRole("group", { name: /^Cable drawing/ });
  fireEvent.click(screen.getByRole("button", { name: /^Inspector · Issues/ }));
  await screen.findByRole("dialog", { name: "Cable inspector" });
  act(() => history.push("/library"));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Cable inspector" })).toBeNull());
  act(() => history.push("/designs/c2@1"));
  await screen.findByRole("group", { name: /^Cable drawing/ });
  expect(screen.queryByRole("dialog", { name: "Cable inspector" })).toBeNull();
});
