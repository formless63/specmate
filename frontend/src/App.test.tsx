import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MantineProvider>
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

test("shows backend status from the health endpoint", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ status: "ok", version: "0.0.0" }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  renderApp();
  expect(await screen.findByText(/ok · v0\.0\.0/)).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith("/api/health", expect.anything());
});

test("reports an unreachable backend instead of a healthy state", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));
  renderApp();
  expect(await screen.findByText("unreachable")).toBeTruthy();
});
