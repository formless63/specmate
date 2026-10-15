import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import { NewIntent } from "./IntentPanel";
import type { IntentRow } from "./api";

beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const wrap = (children: React.ReactNode) => <MantineProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PermissionsProvider permissions={["workspace.read", "item.create", "design.edit", "design.freeze"]}>{children}</PermissionsProvider></QueryClientProvider></MantineProvider>;

const red = { signal_set_revision_id: "set", key: "video_red", name: "Red video", type: "analog_video", set_name: "AV", set_revision_number: 1 };
const ground = { ...red, key: "video_ground", name: "Video ground", type: "ground_return" };
const end = (rows: { contact_id: string; signal: typeof red }[]) => ({ kind: "port", revision_id: "x", device_label: "Device", role: "source", variant_label: "V", standard: null, pinout_revision_id: "p", body_revision_id: "b", selected_conditions: {}, compatibility: "not_evaluated",
  rows: rows.map((r) => ({ ...r, number: r.contact_id, label: r.contact_id, physical_role: "contact", status: "declared", device: null })) });
const base = { signal_ref: null, return_policy: "unknown" as const, conductor: { kind: "unknown" as const, impedance_ohm: null, basis: null }, required_parts: [], basis: null };
const proposed: IntentRow[] = [
  { ...base, row_id: "from-4", requirement: "required", from_contact_id: "4", to_contact_ids: ["15"], pairing: "same_signal", conductor: { kind: "coax", impedance_ohm: 75, basis: "Declared" }, return_policy: "dedicated_screen", question: null },
  { ...base, row_id: "from-3", requirement: "required", from_contact_id: "3", to_contact_ids: [], pairing: "declared", question: { kind: "several_destinations", text: "Video ground is declared on 2 contacts.", options: [{ contact_id: "5", label: "5 · Video ground" }, { contact_id: "17", label: "17 · Video ground" }] } },
];

test("propose, answer the question, then freeze: unanswered questions block freezing", async () => {
  const posts: { operation: string; payload: { interface?: { rows: IntentRow[] } } }[] = [];
  let state = "draft-v1";
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    let data: unknown = {};
    if (options?.method === "POST") {
      const cmd = JSON.parse(String(options.body)); posts.push(cmd);
      if (cmd.operation === "interface.update") state = "draft-v2";
      data = { result: cmd.operation === "interface.freeze" ? { revision_id: "intent-rev" } : { definition_id: "d", draft_id: "x", kind: "cable_intent", state, content: {} } };
    } else if (url.includes("intents/propose")) data = { rows: proposed, open_questions: 1 };
    else if (url.includes("revisions/from-rev/end")) data = end([{ contact_id: "4", signal: red }, { contact_id: "3", signal: ground }]);
    else if (url.includes("revisions/to-rev/end")) data = end([{ contact_id: "15", signal: red }, { contact_id: "5", signal: ground }, { contact_id: "17", signal: ground }]);
    return new Response(JSON.stringify(data), { status: 200 });
  }));
  const frozen = vi.fn();
  render(wrap(<NewIntent projectId={null} definitions={[]} onFrozen={frozen} />));
  fireEvent.change(screen.getByLabelText("Intent name"), { target: { value: "Console to monitor" } });
  for (const [label, id] of [["From end", "from-rev"], ["To end", "to-rev"]] as const) {
    fireEvent.click(screen.getByRole("button", { name: `Advanced: paste exact revision ID for ${label}` }));
    fireEvent.change(await screen.findByLabelText(`${label} exact revision ID`), { target: { value: id } });
  }
  fireEvent.click(screen.getByRole("button", { name: "Propose rows from the two ends" }));
  const table = await screen.findByRole("table", { name: "Intent rows" });
  expect(within(table).getByText("4 · Red video")).toBeTruthy();
  expect(within(table).getByText("15 · Red video")).toBeTruthy();
  expect(within(table).getByText("coax 75 Ω")).toBeTruthy();
  expect(within(table).getByText("Video ground is declared on 2 contacts.")).toBeTruthy();
  expect(screen.getByText("1 open question")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save intent draft" }));
  const freeze = await screen.findByRole("button", { name: "Freeze intent" });
  expect((freeze as HTMLButtonElement).disabled).toBe(true);
  // Answer by choosing both destination contacts.
  const answer = within(table).getByLabelText("Answer for row from-3");
  for (const option of ["5 · Video ground", "17 · Video ground"]) {
    fireEvent.focus(answer); fireEvent.keyDown(answer, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: option, hidden: true }));
  }
  fireEvent.click(within(table).getByRole("button", { name: "Answer" }));
  await waitFor(() => expect(within(table).getByText("5 · Video ground, 17 · Video ground")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(posts.some((p) => p.operation === "interface.update")).toBe(true));
  const saved = posts.find((p) => p.operation === "interface.update")!.payload.interface!.rows.find((r) => r.row_id === "from-3")!;
  expect(saved).toMatchObject({ to_contact_ids: ["5", "17"], question: null, pairing: "answered" });
  await waitFor(() => expect((screen.getByRole("button", { name: "Freeze intent" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Freeze intent" }));
  await waitFor(() => expect(frozen).toHaveBeenCalledWith("intent-rev"));
});
