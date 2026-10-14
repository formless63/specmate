import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SupplierSuggestions } from "./SupplierSuggestions";
import type { SupplierSuggestion } from "./api";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const variant = { variant_id: "source-variant", manufacturer: "Synthetic maker", part_number: "SYN-PAIR", association_basis: "Source catalog assertion" };
const suggestion: SupplierSuggestion = {
  source_variant_id: variant.variant_id, target_variant_id: "target-variant",
  manufacturer: variant.manufacturer, part_number: variant.part_number,
  source_association_basis: variant.association_basis, target_association_basis: "Target catalog assertion",
  target: { revision_id: "target-revision", definition_id: "target-definition", workspace_id: "workspace-1", name: "Suggested exact target", kind: "part", number: 2, sha256: "a".repeat(64) },
  match_basis: "exact_manufacturer_and_part_number", review: "not_reviewed", compatibility: "not_evaluated",
};
async function load() {
  fireEvent.click(screen.getByRole("button", { name: "Load source supplier identities" }));
  await screen.findByRole("option", { name: /Synthetic maker · SYN-PAIR/ });
  fireEvent.change(screen.getByLabelText("Exact source supplier identity"), { target: { value: variant.variant_id } });
  fireEvent.click(screen.getByRole("button", { name: "Suggest exact identifier matches" }));
  await screen.findByText("Suggested exact target · revision 2");
}

test("reading exact suggestions makes no commands; only deliberate use returns the exact target", async () => {
  const use = vi.fn(); const denied = vi.fn();
  const fetch = vi.fn(async (path: string) => {
    if (path.includes("supplier-suggestions")) expect(path).not.toContain("project");
    return reply(path.includes("supplier-suggestions") ? { results: [suggestion], next_after: null, inspection_truncated: false } : { variants: [variant] });
  });
  vi.stubGlobal("fetch", fetch);
  render(<MantineProvider><SupplierSuggestions sourceRevisionId="source-revision" canEdit onUse={use} onDenied={denied} /></MantineProvider>);
  expect(fetch).not.toHaveBeenCalled();
  await load();
  expect(use).not.toHaveBeenCalled();
  expect(screen.getByText(/unreviewed, compatibility not evaluated/)).toBeTruthy();
  expect(screen.getAllByText('target-definition', { selector: 'code' }).length).toBeGreaterThan(0);
  expect(screen.getAllByText('target-revision', { selector: 'code' }).length).toBeGreaterThan(0);
  expect(fetch.mock.calls.every(([path]) => !path.endsWith("operations"))).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Use exact pins in proposal" }));
  expect(use).toHaveBeenCalledExactlyOnceWith(suggestion);
  expect(denied).not.toHaveBeenCalled();
});

test("denied repeated suggestion read clears retained names and pins before any further use", async () => {
  let revoked = false;
  const denied = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (path: string) => path.includes("supplier-suggestions")
    ? revoked ? reply({ error: { message: "Source authority changed." } }, 404) : reply({ results: [suggestion], next_after: null, inspection_truncated: false })
    : reply({ variants: [variant] })));
  render(<MantineProvider><SupplierSuggestions sourceRevisionId="source-revision" canEdit onUse={vi.fn()} onDenied={denied} /></MantineProvider>);
  await load(); revoked = true;
  fireEvent.click(screen.getByRole("button", { name: "Suggest exact identifier matches" }));
  expect(screen.queryByText("Suggested exact target · revision 2")).toBeNull();
  expect(await screen.findByText("Source authority changed.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Use exact pins in proposal" })).toBeNull();
  expect(screen.queryByLabelText("Exact source supplier identity")).toBeNull();
  expect(denied).toHaveBeenCalledTimes(1);
});

test("read-only actor can inspect but cannot use pins; a new source revision discards the old results", async () => {
  const use = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (path: string) => reply(path.includes("supplier-suggestions") ? { results: [suggestion], next_after: null, inspection_truncated: true } : { variants: [variant] })));
  const show = (source: string) => <MantineProvider><SupplierSuggestions sourceRevisionId={source} canEdit={false} onUse={use} onDenied={vi.fn()} /></MantineProvider>;
  const view = render(show("source-revision"));
  await load();
  const button = screen.getByRole("button", { name: "Use exact pins in proposal" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true); fireEvent.click(button); expect(use).not.toHaveBeenCalled();
  expect(screen.getByText(/inspection bound was reached/)).toBeTruthy();
  view.rerender(show("other-revision"));
  await waitFor(() => expect(screen.queryByText("Suggested exact target · revision 2")).toBeNull());
  expect(screen.queryByLabelText("Exact source supplier identity")).toBeNull();
});
