import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PermissionsProvider } from '../../lib/permissions';
import type { Catalog } from '../identity/api';
import { PartAssociations } from './PartAssociations';
const definitionId = '00000000-0000-0000-0000-000000000001';
const revisionId = '00000000-0000-0000-0000-000000000002';
const library = { results: [], next_after: null };
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount(permissions = ['workspace.read', 'item.create']) {
 const cache = new QueryClient({defaultOptions:{queries:{retry:false}}});
 return render(<MantineProvider><QueryClientProvider client={cache}><PermissionsProvider permissions={permissions}><PartAssociations active principalKey="owner" workspaceId="workspace" revisionId={revisionId} catalog={repCatalog} refresh={vi.fn()} onFailure={vi.fn()} /></PermissionsProvider></QueryClientProvider></MantineProvider>);
}
async function pick(name: string, option: string) {
 const input = await screen.findByRole('combobox', {name}); fireEvent.focus(input); fireEvent.keyDown(input, {key:'ArrowDown'});
 fireEvent.click(await within(screen.getByRole('listbox', {name, hidden:true})).findByText(option));
}
const bundleId = "00000000-0000-0000-0000-000000000009";
const repCatalog: Catalog = {
  revision_id: revisionId, variants: [], lots: [],
  representations: [{ representation_id: "r1", kind: "datasheet", label: "Datasheet", revision_id: revisionId, revision_number: 1, definition_id: definitionId, definition_name: "Synthetic part", definition_kind: "part", source_bundle_revision_id: bundleId, source_path: "docs/sheet.pdf", sha256: "ab".repeat(32), media_type: "application/pdf", rights: "vendor note", rights_status: "unknown" }],
  source_identifiers: [{ source_identifier_id: "s1", revision_id: revisionId, revision_number: 1, definition_name: "Synthetic part", scheme: "library-id", identifier: "Synthetic:Part", label: "Library symbol", rights: "CC0-1.0", rights_status: "restricted" }],
};

test("shows the exact model revision, flags unknown rights and registers a linked file and identifier", async () => {
  const calls: { operation: string; payload: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    let body: unknown;
    if (options?.method === "POST") { const command = JSON.parse(String(options.body)); calls.push(command); body = { result: {} }; }
    else if (url.includes("sources/workspaces/")) body = { revisions: [{ revision_id: bundleId, bundle_id: "b", name: "Vendor docs", role: "original", number: 1, manifest_sha256: "m", derived_from: null }], next_after: null };
    else if (url.includes("sources/revisions/")) body = { revision_id: bundleId, manifest: { ancestry: [], files: [{ path: "docs/sheet.pdf", sha256: "cd".repeat(32), bytes: 3, media_type: "application/pdf", rights: "unknown" }] } };
    else if (url.includes("/definitions/")) body = { definition_id: definitionId, name: "Synthetic part", kind: "part", drafts: [], revisions: [{ revision_id: revisionId, number: 1 }] };
    else if (url.includes("/revisions/")) body = repCatalog;
    else body = library;
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  mount();
  expect(await screen.findByText("not cleared · vendor note")).toBeTruthy();
  expect(screen.getByText("restricted · CC0-1.0")).toBeTruthy();
  expect(screen.getAllByText("Revision 1").length).toBeGreaterThan(0);
  expect(screen.getByText(/not an orderable part or a physical lot/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Representation label"), { target: { value: "Sheet" } });
  await pick("Source bundle revision", "Vendor docs · revision 1 (original)");
  await pick("Source file", "docs/sheet.pdf");
  const registerRep = screen.getByRole("button", { name: "Register representation" }) as HTMLButtonElement;
  expect(registerRep.disabled).toBe(true);
  await pick("Rights status", "Unknown (not cleared)");
  fireEvent.click(registerRep);
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]).toMatchObject({ operation: "catalog.register_representation", payload: { revision_id: revisionId, kind: "datasheet", source_bundle_revision_id: bundleId, source_path: "docs/sheet.pdf", rights_status: "unknown" } });
  const register = screen.getByRole("button", { name: "Register source identifier" }) as HTMLButtonElement;
  expect(register.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Identifier scheme"), { target: { value: "url" } });
  fireEvent.change(screen.getByLabelText("Source identifier"), { target: { value: "https://example.invalid/p" } });
  fireEvent.change(screen.getByLabelText("Source identifier label"), { target: { value: "Page" } });
  expect(register.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText(/Rights note/), { target: { value: "n/a" } });
  expect(register.disabled).toBe(true);
  await pick("Source identifier rights status", "Restricted");
  fireEvent.click(register);
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1]).toMatchObject({ operation: "catalog.register_source_identifier", payload: { scheme: "url", identifier: "https://example.invalid/p", label: "Page", rights_status: "restricted", rights: "n/a" } });
});


test('lot identity is registered against the selected exact revision and remains separate from inventory', async () => {
 const calls: unknown[] = [];
 vi.stubGlobal('fetch', vi.fn(async (_url: string, options?: RequestInit) => { if(options?.method === 'POST') calls.push(JSON.parse(String(options.body))); return new Response(JSON.stringify({result:{}})); }));
 mount(); fireEvent.change(screen.getByLabelText('Lot label'), {target:{value:'Synthetic batch'}}); fireEvent.click(screen.getByRole('button',{name:'Register lot identity'}));
 await screen.findByText('Catalog association registered.'); expect(calls).toEqual([expect.objectContaining({operation:'catalog.register_lot',payload:{revision_id:revisionId,label:'Synthetic batch',variant_id:null}})]);
});
test('association denial is reported without a success notice and viewer cannot register', async () => {
 vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({error:{message:'Missing permission item.create.'}}),{status:403})));
 const view=mount(); fireEvent.change(screen.getByLabelText('Lot label'),{target:{value:'Synthetic batch'}}); fireEvent.click(screen.getByRole('button',{name:'Register lot identity'}));
 await screen.findAllByText('Missing permission item.create.'); expect(screen.queryByText('Catalog association registered.')).toBeNull(); view.unmount(); mount(['workspace.read']); expect(screen.queryByRole('button',{name:'Register lot identity'})).toBeNull();
});
