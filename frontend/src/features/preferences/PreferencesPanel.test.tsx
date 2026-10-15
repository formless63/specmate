import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { PermissionsProvider } from "../../lib/permissions";
import { PreferencesPanel } from "./PreferencesPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const prefs = (over: Record<string, unknown> = {}) => ({
  workspace_id: "w1", kind: "preference", engineering_fact: false, note: "n",
  workspace: { values: { wire_colours: ["red"], default_length_unit: "mm" }, state_token: "preferences-v1" },
  user: { values: {}, state_token: "preferences-v0" },
  effective: {
    preferred_suppliers: { value: null, source: "none" }, wire_colours: { value: ["red"], source: "workspace" },
    connector_families: { value: null, source: "none" }, default_length_unit: { value: "mm", source: "workspace" },
    default_wire_gauge_system: { value: null, source: "none" },
  },
  ...over,
});

function view(permissions?: string[]) {
  return render(<MantineProvider><PermissionsProvider permissions={permissions}><PreferencesPanel workspaceId="w1" /></PermissionsProvider></MantineProvider>);
}

test("labels effective defaults as preferences and shows unset ones as unknown", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => reply(prefs())));
  view();
  expect((await screen.findAllByText("preference \u00b7 workspace")).length).toBe(2);
  expect(screen.getAllByText(/unknown/).length).toBeGreaterThan(0);
  expect(screen.getAllByText("unset").length).toBe(3);
});

test("saves the member override with the layer's state token and clears empty fields", async () => {
  const posts: { payload: { scope: string; values: Record<string, unknown> }; expected_state: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return reply({ operation: "preferences.set", request_id: "r", status: "completed", replayed: false, result: prefs({ user: { values: { default_length_unit: "in" }, state_token: "preferences-v1" } }) });
    }
    return reply(prefs());
  }));
  view(["workspace.read"]);
  await screen.findByRole("form", { name: "My override" });
  fireEvent.change(screen.getByLabelText("Default length unit (My override)"), { target: { value: "in" } });
  fireEvent.click(screen.getByRole("button", { name: "Save my override" }));
  await waitFor(() => expect(posts.length).toBe(1));
  expect(posts[0]?.expected_state).toBe("preferences-v0");
  expect(posts[0]?.payload.scope).toBe("user");
  expect(posts[0]?.payload.values).toMatchObject({ default_length_unit: "in", wire_colours: null, preferred_suppliers: null });
});

test("workspace defaults are read-only without design.edit, with a visible reason", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => reply(prefs())));
  view(["workspace.read"]);
  await screen.findByRole("form", { name: "Workspace defaults" });
  expect((screen.getByRole("button", { name: "Save workspace defaults" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("note").textContent).toMatch(/editors and administrators/);
  expect((screen.getByLabelText("Wire colors (Workspace defaults)") as HTMLInputElement).readOnly).toBe(true);
  expect((screen.getByRole("button", { name: "Save my override" }) as HTMLButtonElement).disabled).toBe(false);
});

test("shows a conflict message from a stale save", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_p: string, init?: RequestInit) => init?.method === "POST" ? reply({ error: { message: "Preferences changed since they were read." } }, 409) : reply(prefs())));
  view();
  await screen.findByRole("form", { name: "My override" });
  fireEvent.click(screen.getByRole("button", { name: "Save my override" }));
  expect(await screen.findByText(/changed since they were read/)).toBeTruthy();
});
