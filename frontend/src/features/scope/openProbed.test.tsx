import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useEffect, useState } from "react";
import { ProbeProvider } from "../probe";
import { useOpenNewest } from "./openProbed";
import { ExactRevisionNotice } from "./exactRevision";
import type { ProbeTarget } from "../navigation/url";

const firstPage = { definition_id: "item", drafts: [{ draft_id: "draft" }], revisions: Array.from({ length: 50 }, (_, i) => ({ revision_id: `r${i + 1}`, number: i + 1 })) };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function show(rev: number | null, { missing = false } = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    const offset = Number(new URL(url, "http://test").searchParams.get("offset"));
    return new Response(JSON.stringify({ definition_id: "item", revisions: missing ? [] : Array.from({ length: 50 }, (_, i) => ({ revision_id: `r${offset + i + 1}`, number: offset + i + 1 })) }));
  });
  vi.stubGlobal("fetch", fetchMock);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Editor() {
    const [draft, setDraft] = useState<string | null>(null);
    const [revision, setRevision] = useState<string | null>("previous");
    const open = useOpenNewest(firstPage, setDraft, setRevision);
    useEffect(() => { open("item"); }, [open]);
    return <><span data-testid="draft">{draft ?? "none"}</span><span data-testid="revision">{revision ?? "none"}</span><button onClick={() => setRevision("user-chosen")}>Choose another revision</button></>;
  }
  function Harness() {
    const [probe, setProbe] = useState<ProbeTarget | null>({ object: "item", rev, path: [] });
    return <ProbeProvider probe={probe} onProbe={setProbe}><ExactRevisionNotice /><Editor /><button onClick={() => setProbe({ object: "item", rev: 2, path: [] })}>Go r2</button></ProbeProvider>;
  }
  render(<MantineProvider env="test"><QueryClientProvider client={cache}><Harness /></QueryClientProvider></MantineProvider>);
  return { cache, fetchMock };
}

test("exact historical selection resolves beyond the first catalog page", async () => {
  const { fetchMock } = show(75);
  await waitFor(() => expect(screen.getByTestId("revision").textContent).toBe("r75"));
  expect(fetchMock.mock.calls.every(([url]) => url.includes("offset=50&limit=50"))).toBe(true);
  expect(screen.getByTestId("draft").textContent).toBe("none");
  fireEvent.click(screen.getByText("Go r2"));
  await waitFor(() => expect(screen.getByTestId("revision").textContent).toBe("r2"));
});

test("a missing historical revision is explicit and never falls forward", async () => {
  show(75, { missing: true });
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByText(/A newer revision has not been substituted/)).toBeTruthy();
  expect(screen.getByTestId("revision").textContent).toBe("none");
  expect(screen.getByTestId("draft").textContent).toBe("none");
});

test("floating newest default stays intact and later explicit editor choices survive refetch", async () => {
  // A normal short identity retains the original newest-frozen behavior.
  function Editor() {
    const [revision, setRevision] = useState<string | null>(null);
    const identity = { definition_id: "item", drafts: [{ draft_id: "draft" }], revisions: [{ revision_id: "r1", number: 1 }, { revision_id: "r2", number: 2 }] };
    const open = useOpenNewest(identity, vi.fn(), setRevision);
    useEffect(() => { open("item"); }, [open]);
    return <><span data-testid="revision">{revision}</span><button onClick={() => setRevision("r1")}>Choose r1</button></>;
  }
  render(<QueryClientProvider client={new QueryClient()}><ProbeProvider probe={{ object: "item", rev: null, path: [] }} onProbe={vi.fn()}><Editor /></ProbeProvider></QueryClientProvider>);
  await waitFor(() => expect(screen.getByTestId("revision").textContent).toBe("r2"));
  fireEvent.click(screen.getByText("Choose r1"));
  expect(screen.getByTestId("revision").textContent).toBe("r1");
});

test("an authority refresh failure withdraws the resolved historic state", async () => {
  const { cache, fetchMock } = show(75);
  await waitFor(() => expect(screen.getByTestId("revision").textContent).toBe("r75"));
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: "Access denied" } }), { status: 403 }));
  await cache.invalidateQueries({ queryKey: ["library-exact-revision"] });
  expect(await screen.findByRole("alert")).toBeTruthy();
  await waitFor(() => expect(screen.getByTestId("revision").textContent).toBe("none"));
});
