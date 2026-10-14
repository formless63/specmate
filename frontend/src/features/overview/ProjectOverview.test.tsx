import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ProjectOverview, START_POINTS } from "./ProjectOverview";

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

type Routes = Partial<Record<"definitions" | "inbox" | "reviews" | "access", () => Response>>;
function serve(routes: Routes = {}) {
  const fetchMock = vi.fn(async (path: string) => {
    if (path.endsWith("/definitions")) return (routes.definitions ?? (() => reply([{ definition_id: "d1", kind: "cable", name: "C1" }, { definition_id: "d2", kind: "cable", name: "C2" }, { definition_id: "d3", kind: "assembly", name: "A1" }])))();
    if (path.includes("/inbox")) return (routes.inbox ?? (() => reply({ results: [], next_after: null })))();
    if (path.includes("/reviews")) return (routes.reviews ?? (() => reply({ results: [], next_after: null })))();
    if (path.startsWith("/api/v0/access/projects/")) return (routes.access ?? (() => reply({ members: [{}, {}, {}] })))();
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
function show(permissions = ["project.read", "design.edit"], extra: { active?: boolean; onAccessLost?: () => Promise<void> } = {}) {
  const onOpenTool = vi.fn();
  const view = (active: boolean) => <MantineProvider><ProjectOverview projectId="p1" projectName="Demo" permissions={permissions}
    active={active} onOpenTool={onOpenTool} onAccessLost={extra.onAccessLost} /></MantineProvider>;
  const rendered = render(view(extra.active ?? true));
  return { onOpenTool, rerender: (active: boolean) => rendered.rerender(view(active)) };
}

test("open work is built from real unread notifications and open reviews, and deep links open the owning tool", async () => {
  serve({
    inbox: () => reply({ results: [{ notification_id: "n1", review_id: "r1", title: "Connector change", action: "request", read_at: null }], next_after: null }),
    reviews: () => reply({ results: [{ review_id: "r1", title: "Connector change", status: "open" }, { review_id: "r2", title: "Old closed review", status: "closed" }], next_after: "r2" }),
  });
  const { onOpenTool } = show();
  const list = await screen.findByRole("group", { name: "Open work" });
  await waitFor(() => expect(within(list).getAllByText("Connector change")).toHaveLength(2));
  expect(within(list).queryByText("Old closed review")).toBeNull();
  expect(screen.getByText("Notification · request · unread")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open notification: Connector change" }));
  expect(onOpenTool).toHaveBeenLastCalledWith("knowledge");
  fireEvent.click(screen.getByRole("button", { name: "Open review: Connector change" }));
  expect(onOpenTool).toHaveBeenCalledTimes(2);
  const summary = screen.getByRole("region", { name: "Project summary" });
  expect(within(summary).getByText("Records").closest("div")?.textContent).toContain("3");
  expect(within(summary).getByText("Open reviews").closest("div")?.textContent).toContain("1+");
});

test("nothing waiting is stated honestly and drafts or builds are not claimed", async () => {
  serve();
  show();
  expect(await screen.findByText("Nothing is waiting on you in this project.")).toBeTruthy();
  expect(screen.getByText(/Drafts and builds are not listed here/)).toBeTruthy();
});

test("start points open the matching tool through the shell tool setter", async () => {
  serve();
  const { onOpenTool } = show();
  await screen.findByText("Nothing is waiting on you in this project.");
  const expected: Record<string, string> = { "Stock record": "wire-stock", "Cable": "cables", "Board": "pcb", "Assembly": "assemblies", "Import source": "sources", "Physical unit": "physical-units" };
  expect(START_POINTS.map((point) => point.title)).toEqual(Object.keys(expected));
  for (const [title, tool] of Object.entries(expected)) {
    fireEvent.click(screen.getByRole("button", { name: `Start: ${title}` }));
    expect(onOpenTool).toHaveBeenLastCalledWith(tool);
  }
  fireEvent.click(screen.getByRole("button", { name: "Members and roles" }));
  expect(onOpenTool).toHaveBeenLastCalledWith("access");
});

test("member count is read only for administrators and is otherwise shown as not reported", async () => {
  const plain = serve();
  show(["project.read", "design.edit"]);
  await screen.findByText("Nothing is waiting on you in this project.");
  expect(plain.mock.calls.some(([path]) => String(path).startsWith("/api/v0/access/"))).toBe(false);
  const members = screen.getByText("Members").closest("div") as HTMLElement;
  expect(members.textContent).toContain("Not reported");
  cleanup();
  const admin = serve();
  show(["project.read", "project.admin"]);
  await waitFor(() => expect((screen.getByText("Members").closest("div") as HTMLElement).textContent).toContain("3"));
  expect(admin).toHaveBeenCalledWith("/api/v0/access/projects/p1", expect.anything());
});

test("read-only access is tagged and states that tools open for inspection", async () => {
  serve();
  show(["project.read"]);
  expect(await screen.findByText("read-only")).toBeTruthy();
  expect(screen.getByText(/do not create records/)).toBeTruthy();
});

test("a failed part shows as unavailable instead of an invented zero", async () => {
  serve({ inbox: () => reply({ error: { message: "Boom" } }, 500) });
  show();
  expect(await screen.findByText("Notifications are unavailable right now.")).toBeTruthy();
  expect((screen.getByText("Unread notifications").closest("div") as HTMLElement).textContent).toContain("Not reported");
});

test("when every read is denied the overview clears and asks the owner to re-read access", async () => {
  const denied = () => reply({ error: { message: "Project not found." } }, 404);
  serve({ definitions: denied, inbox: denied, reviews: denied });
  const lost = vi.fn(async () => {});
  show(["project.read"], { onAccessLost: lost });
  expect(await screen.findByText("This project is no longer available to you.")).toBeTruthy();
  expect(lost).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Open notification: x" })).toBeNull();
});

test("showing the overview again refreshes what is waiting", async () => {
  const fetchMock = serve();
  const { rerender } = show(["project.read"], { active: true });
  await screen.findByText("Nothing is waiting on you in this project.");
  const before = fetchMock.mock.calls.filter(([path]) => String(path).includes("/inbox")).length;
  rerender(false);
  rerender(true);
  await waitFor(() => expect(fetchMock.mock.calls.filter(([path]) => String(path).includes("/inbox")).length).toBe(before + 1));
});
