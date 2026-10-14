import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DiscoveryPanel } from "./DiscoveryPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

test("searches the library, pages matches, and lists pins and referencing projects", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    calls.push(path);
    if (path.startsWith("/api/v0/catalog/search?")) {
      const params = new URL(path, "http://test.local").searchParams;
      expect(params.get("query")).toBe("bracket");
      expect(params.has("project_id")).toBe(false);
      return params.has("after")
        ? reply({ kind: "definition", query: "bracket", project_id: null, results: [{ record_id: "def-2", workspace_id: "w", label: "Bracket two" }], next_after: null })
        : reply({ kind: "definition", query: "bracket", project_id: null, results: [{ record_id: "def-1", workspace_id: "w", label: "Bracket one" }], next_after: "def-1" });
    }
    if (path === "/api/v0/catalog/definitions/def-1?offset=0&limit=50") {
      return reply({ definition_id: "def-1", name: "Bracket one", revisions: [{ revision_id: "rev-1", number: 2 }] });
    }
    if (path.startsWith("/api/v0/catalog/where-used?")) {
      const params = new URL(path, "http://test.local").searchParams;
      expect(params.get("revision_id")).toBe("rev-1");
      expect(params.has("project_id")).toBe(false);
      return reply({ revision_id: "rev-1", workspace_id: "w", project_id: null, results: [{ record_id: "snap-1", snapshot_id: "snap-1", workspace_id: "w", definition_id: "parent-1", label: "Parent bracket", relation: "exact_revision_pin" }], next_after: null,
        project_references: [{ reference_id: "ref-1", project_id: "p-9", project_name: "Bench nine", archived: false, kind: "definition", relation: "project_reference_floating", role: "candidate", in_project: false }], project_references_truncated: false });
    }
    throw new Error(`Unexpected request ${path}`);
  }));
  render(<MantineProvider><DiscoveryPanel /></MantineProvider>);
  expect(screen.queryByLabelText("Search order")).toBeNull();
  fireEvent.change(screen.getByLabelText("Search terms"), { target: { value: " bracket " } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(await screen.findByText("Bracket one")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "More results" }));
  expect(await screen.findByText("Bracket two")).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: "Inspect uses" })[0]!);
  fireEvent.click(await screen.findByRole("button", { name: "Inspect revision 2" }));
  expect(await screen.findByText("Parent bracket")).toBeTruthy();
  expect(screen.getAllByText('snap-1', { selector: 'code' }).length).toBeGreaterThan(0);
  expect(screen.getAllByText('parent-1', { selector: 'code' }).length).toBeGreaterThan(0);
  expect(screen.getByText(/Bench nine · candidate · floating definition/)).toBeTruthy();
  expect(calls.some((path) => path.includes("after=def-1"))).toBe(true);
});

test("project scope lists the project's items first, can show the whole library, and shows failures", async () => {
  const scopes: (string | null)[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    scopes.push(new URL(path, "http://test.local").searchParams.get("project_id"));
    return scopes.length === 1
      ? reply({ kind: "definition", query: "source", project_id: "p-1", results: [{ record_id: "d", workspace_id: "w", label: "Referenced source", in_project: true }], next_after: null })
      : reply({ error: { message: "Access changed." } }, 404);
  }));
  render(<MantineProvider><DiscoveryPanel projectId="p-1" /></MantineProvider>);
  fireEvent.change(screen.getByLabelText("Search terms"), { target: { value: "source" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(await screen.findByText("In this project")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search order"), { target: { value: "all" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await waitFor(() => expect(screen.getByText("Access changed.")).toBeTruthy());
  expect(scopes).toEqual(["p-1", null]);
});

test("denied repeat pin inspection removes the previously disclosed consumer", async () => {
  let denied = false;
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (path.includes("catalog/search?")) return reply({ results: [{ record_id: "def", workspace_id: "w", label: "Bracket" }], next_after: null });
    if (path.includes("catalog/definitions/")) return reply({ definition_id: "def", name: "Bracket", revisions: [{ revision_id: "rev", number: 1 }] });
    if (path.includes("catalog/where-used?")) return denied
      ? reply({ error: { message: "Pin unavailable." } }, 404)
      : reply({ revision_id: "rev", results: [{ snapshot_id: "snap", label: "Formerly visible consumer", workspace_id: "w", definition_id: "parent" }], next_after: null, project_references: [], project_references_truncated: false });
    throw new Error(`Unexpected request ${path}`);
  }));
  render(<MantineProvider><DiscoveryPanel projectId="p" /></MantineProvider>);
  fireEvent.change(screen.getByLabelText("Search terms"), { target: { value: "bracket" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  fireEvent.click(await screen.findByRole("button", { name: "Inspect uses" }));
  fireEvent.click(await screen.findByRole("button", { name: "Inspect revision 1" }));
  expect(await screen.findByText("Formerly visible consumer")).toBeTruthy();
  denied = true;
  fireEvent.click(screen.getByRole("button", { name: "Inspect revision 1" }));
  expect(await screen.findByText("Pin unavailable.")).toBeTruthy();
  expect(screen.queryByText("Formerly visible consumer")).toBeNull();
});
