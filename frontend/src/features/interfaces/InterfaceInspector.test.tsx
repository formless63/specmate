import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { InterfaceInspector } from './InterfaceInspector';
beforeEach(()=>vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function wrap(children:React.ReactNode){return <MantineProvider><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}>{children}</QueryClientProvider></MantineProvider>;}
test("trace exposes the exact repeated occurrence and preserves declaration uncertainty", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/trace?") ? {
    external_contact_id: "a", status: "declared", continuity: "not_evaluated", compatibility: "not_evaluated",
    targets: [{ passage_id: "path", assembly_revision_id: "assembly-rev", snapshot_id: "root-snapshot", path: ["right", "board"], revision_id: "board-rev", feature_id: "header.pin3", condition: null, basis: "Synthetic table", feature_status: "not_evaluated" }],
  } : { revision_id: "mapping-rev", interface: { kind: "interface_map", assembly_revision_id: "assembly-rev", external_pinout_revision_id: "pinout-rev", passages: [] }, compatibility: "not_evaluated" }), { status: 200 })));
  render(wrap(<InterfaceInspector revisionId="mapping-rev" />));
  fireEvent.change(await screen.findByLabelText("External contact to trace"), { target: { value: "a" } });
  fireEvent.click(screen.getByText("Trace declared path"));
  expect(await screen.findByText("a → right / board · header.pin3")).toBeTruthy();
  expect(screen.getAllByText("board-rev", { selector: "code" }).length).toBeGreaterThan(0);
  expect(screen.getAllByText("root-snapshot", { selector: "code" }).length).toBeGreaterThan(0);
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
