import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ItemCard } from "./ItemCard";
import { loadPreview } from "./api";
vi.mock("./api", () => ({ loadPreview: vi.fn() }));
afterEach(cleanup);

test.each([{ revision: 1, draftVersion: null }, { revision: null, draftVersion: 1 }])("a thumbnail cannot silently show a different saved state: %j", async expectedState => {
  vi.mocked(loadPreview).mockResolvedValue({ record_id: "a", kind: "connector_body", source: "revision", revision: 2, content: { interface: { kind: "connector_body", family: "New family", contacts: [] } }, truncated: false, stock: null });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={cache}><ItemCard item={{ record_id: "a", kind: "connector_body", label: "Synthetic", latest_revision: expectedState.revision }} expectedState={expectedState} principalKey="p" onOpen={vi.fn()} /></QueryClientProvider>);
  expect(await screen.findByText("Saved state changed; refresh the list")).toBeTruthy();
  expect(screen.queryByText("New family")).toBeNull();
});

test("preview denial withdraws retained thumbnail content", async () => {
  vi.mocked(loadPreview).mockResolvedValue({ record_id: "s", kind: "signal_set", source: "revision", revision: 1, content: { interface: { signals: [{ key: "s", name: "Synthetic retained signal" }] } }, truncated: false, stock: null });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={cache}><ItemCard item={{ record_id: "s", kind: "signal_set", label: "Synthetic", latest_revision: 1 }} principalKey="p" onOpen={vi.fn()} /></QueryClientProvider>);
  expect(await screen.findByText("Synthetic retained signal")).toBeTruthy();
  vi.mocked(loadPreview).mockRejectedValue(new Error("Denied"));
  await cache.invalidateQueries({ queryKey: ["workspace", "library", "preview"] });
  expect(await screen.findByText("Not readable")).toBeTruthy();
  expect(screen.queryByText("Synthetic retained signal")).toBeNull();
});
