import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "../../App";
import { record, reply, workspaceServer } from "../../test/workspaceServer";
import type { LibraryRecord } from "../workspace/api";

// These small editors expose working state so this integration test can detect an App remount.
// Discipline content and exact frozen views have their own renderer tests.
vi.mock("../cables/CablePanel", async () => {
  const { useState } = await import("react");
  return { CablePanel: () => {
    const [name, setName] = useState("");
    return <input aria-label="Working cable name" value={name} onChange={event => setName(event.currentTarget.value)} />;
  } };
});
vi.mock("../cable-views/SelectedDefinitionViews", () => ({ SelectedDefinitionViews: () => <div>Selected frozen drawing</div> }));
vi.mock("../designs/DesignList", () => ({ DesignList: ({ onOpen, onCreate }: { onOpen: (item: LibraryRecord) => void; onCreate: (kind: "cable") => void }) => <>
  <button onClick={() => onOpen(record("c1", "Synthetic lead", { kind: "cable" }))}>Open existing cable</button>
  <button onClick={() => onCreate("cable")}>New cable</button>
</> }));

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  workspaceServer({}, path => path === "/api/v0/workspace/library/c1" ? reply(record("c1", "Synthetic lead", { kind: "cable" })) : undefined);
  window.history.replaceState(null, "", "/designs");
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function start() {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MantineProvider><QueryClientProvider client={cache}><App /></QueryClientProvider></MantineProvider>);
}
const name = () => screen.getByRole("textbox", { name: "Working cable name" }) as HTMLInputElement;
const designs = () => fireEvent.click(screen.getByRole("button", { name: /^Designs$/ }));

test("new design uses a separate retained form and cannot overwrite open record edits", async () => {
  start(); fireEvent.click(await screen.findByRole("button", { name: "Open existing cable" }));
  await screen.findByText("Selected frozen drawing");
  fireEvent.change(name(), { target: { value: "Existing unsaved edits" } });
  designs(); fireEvent.click(screen.getByRole("button", { name: "New cable" }));
  await waitFor(() => expect(window.location.pathname).toBe("/designs/new"));
  expect(name().value).toBe(""); fireEvent.change(name(), { target: { value: "New form edits" } });
  designs(); fireEvent.click(screen.getByRole("button", { name: "New cable" }));
  fireEvent.click(await screen.findByRole("button", { name: "Keep existing form" }));
  expect(name().value).toBe("New form edits");
  designs(); fireEvent.click(screen.getByRole("button", { name: "Open existing cable" }));
  await screen.findByText("Selected frozen drawing"); expect(name().value).toBe("Existing unsaved edits");
});

test("replacing a retained creation form requires the explicit Start new action", async () => {
  start(); fireEvent.click(await screen.findByRole("button", { name: "New cable" }));
  await waitFor(() => expect(window.location.pathname).toBe("/designs/new"));
  fireEvent.change(name(), { target: { value: "Pending edits" } });
  designs(); fireEvent.click(screen.getByRole("button", { name: "New cable" }));
  await screen.findByRole("dialog", { name: "Start another design?" });
  fireEvent.click(screen.getByRole("button", { name: "Start new" }));
  await waitFor(() => expect(name().value).toBe(""));
});
