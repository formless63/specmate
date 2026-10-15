import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useState } from "react";
import { NavigationProvider, useNavigation } from "../../features/navigation";
import { ProbeProvider } from "../../features/probe";
import { record, reply } from "../../test/workspaceServer";
import { FrozenRootDocuments } from "./FrozenRootDocuments";

vi.mock("./Documents", () => ({ RootDocuments: ({ snapshot, active }: { snapshot: { revisionId: string }; active: boolean }) => <section hidden={!active} aria-label="Frozen root document session"><p>Exact document {snapshot.revisionId}</p><input aria-label="Prepared document note" /></section> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
test("direct historical Documents uses its exact revision page, lazily mounts Build and retains both buffers through view and rail changes", async () => {
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { requests.push(url); return reply({ revisions: [{ number: 51, revision_id: "h-r51" }, { number: 52, revision_id: "h-r52" }], drafts: [] }); }));
  const history = createMemoryHistory({ initialEntries: ["/designs/h1@51/~/opaque?view=documents"] });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Build() { const [value, setValue] = useState(""); return <input aria-label="Legacy working buffer" value={value} onChange={event => setValue(event.currentTarget.value)} />; }
  function Routed() {
    const nav = useNavigation()!;
    return <ProbeProvider probe={nav.location.probe} onProbe={probe => nav.navigate({ probe })}><FrozenRootDocuments kind="harness" record={nav.location.probe ? record("h1", "Synthetic harness", { kind: "harness", latest_revision: 52 }) : undefined} workspaceId="w1" principalKey="owner:w1" active={!!nav.location.probe}><Build /></FrozenRootDocuments></ProbeProvider>;
  }
  render(<MantineProvider><QueryClientProvider client={cache}><NavigationProvider history={history}><Routed /></NavigationProvider></QueryClientProvider></MantineProvider>);
  await screen.findByText("Exact document h-r51"); expect(requests).toEqual(["/api/v0/catalog/definitions/h1?offset=50"]);
  expect(screen.queryByLabelText("Legacy working buffer")).toBeNull();
  fireEvent.change(screen.getByLabelText("Prepared document note"), { target: { value: "Retained instructions" } });
  fireEvent.click(screen.getByRole("button", { name: "Build" })); fireEvent.change(screen.getByLabelText("Legacy working buffer"), { target: { value: "Unsaved legacy draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Documents" })); expect((screen.getByLabelText("Prepared document note") as HTMLInputElement).value).toBe("Retained instructions");
  act(() => history.push("/library")); act(() => history.push("/designs/h1@51/~/opaque?view=documents")); await screen.findByText("Exact document h-r51");
  fireEvent.click(screen.getByRole("button", { name: "Build" })); expect((screen.getByLabelText("Legacy working buffer") as HTMLInputElement).value).toBe("Unsaved legacy draft");
});
