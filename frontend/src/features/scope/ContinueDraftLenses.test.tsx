import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import type { ProbeTarget } from "../navigation/url";
import { ProbeProvider } from "../probe";
import { PreparationPanel } from "../preparation/PreparationPanel";
import { emptyProfile } from "../preparation/api";
import { MaterialAccountingPanel } from "../material-accounting/MaterialAccountingPanel";
import { emptyPlan } from "../material-accounting/api";
import { EndPreparationPanel } from "../end-preparation/EndPreparationPanel";
import { emptyProfile as emptyEndProfile } from "../end-preparation/api";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const EDITOR = ["item.create", "design.edit", "design.freeze", "project.edit", "workspace.read"];
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function Shell({ kind, children }: { kind: string; children: ReactNode }) {
  const [probe, setProbe] = useState<ProbeTarget | null>({ object: "item-1", rev: null, path: [] });
  const client = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }))[0];
  void kind;
  return <MantineProvider><QueryClientProvider client={client}><PermissionsProvider permissions={EDITOR}>
    <ProbeProvider probe={probe} onProbe={setProbe}>{children}</ProbeProvider>
  </PermissionsProvider></QueryClientProvider></MantineProvider>;
}

/** One library item of `kind` with one frozen revision and one draft whose content is `content`. */
function serve(kind: string, content: unknown, frozen: Record<string, unknown>, revisions = [{ revision_id: "rev-1", number: 1 }]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("workspace/definitions")) return reply([{ definition_id: "item-1", name: "Synthetic item", kind }]);
    if (url.includes("catalog/definitions/item-1")) return reply({ definition_id: "item-1", name: "Synthetic item", kind, drafts: [{ draft_id: "draft-1", state: "v1" }], revisions });
    if (/drafts\/draft-1/.test(url)) return reply({ definition_id: "item-1", draft_id: "draft-1", state: "v1", content });
    if (/revisions\/rev-1/.test(url)) return Object.keys(frozen).length > 1 ? reply(frozen) : reply({ error: { message: "Synthetic inspection unavailable." } }, 500);
    return reply({});
  }));
}

const button = () => screen.findByRole("button", { name: "Continue draft (edit)" });

test.each([
  ["Preparation", "preparation_profile", <PreparationPanel />, { preparation_profile: emptyProfile() }, "Edit preparation draft",
    { revision_id: "rev-1", sha256: "a", stock_sha256: "b", profile: { stock_revision_id: "s", formulas: [] } }],
  ["Material accounting", "material_plan", <MaterialAccountingPanel />, { material_plan: emptyPlan() }, "Edit material plan", {}],
  ["End preparation", "end_preparation_profile", <EndPreparationPanel />, { end_preparation_profile: emptyEndProfile() }, "Edit end preparation draft", {}],
] as const)("%s: Open lands on the frozen revision; Continue draft selects and loads the newest draft", async (_name, kind, panel, content, heading, frozen) => {
  serve(kind, content, frozen);
  render(<Shell kind={kind}>{panel}</Shell>);
  expect(screen.queryByRole("heading", { name: heading })).toBeNull();
  fireEvent.click(await button());
  expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("button", { name: "Continue draft (edit)" })).toBeNull());
});
