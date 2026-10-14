import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { KnowledgeSearchPanel } from "./KnowledgeSearchPanel";
import type { Preview, SearchPage, SearchRow } from "./search-api";

const text = '<script>window.bad=true</script>\nOriginal permitted attachment';
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const attachment = { bundle_revision_id: "source", bundle_id: "bundle", bundle_name: "Original source", revision_number: 1, path: "note.txt", label: "Bench attachment", sha256: sha(text), size: new TextEncoder().encode(text).length, media_type: "text/plain", rights: "synthetic-original", blob_project_id: "project" };
const row: SearchRow = { record_id: "entry", item_id: "item", project_id: "project", entry_id: "entry", entry_number: 2, current: false, title: "Permitted historic note", kind: "note", decision_status: null, matches: [{ field: "body", text: "Independent calibration needle" }], attachments: [attachment], links: [{ link_id: "link", item_id: "item", target: { kind: "revision", revision_id: "exact-revision" }, project_id: "project", label: "Exact bracket revision 2", linked_at: "", status: "active" }] };
const page: SearchPage = { query: "needle", results: [row], next_after: null };
const preview: Preview = { kind: "text", item_id: "item", entry_id: "entry", entry_number: 2, attachment, qualification: "not_evaluated", integrity: "original_sha256_and_size_verified", text, preview_sha256: sha(text), preview_size: attachment.size };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function panel(projectId = "project", principalKey = "owner", active = true) { return <MantineProvider env="test"><KnowledgeSearchPanel {...{ projectId, principalKey, active }} /></MantineProvider>; }
function fixture() {
  let held: Promise<Response> | undefined;
  let denied = false;
  let nextPreview: Preview = preview;
  let nextPage = page;
  const fetch = vi.fn(async () => held ? (await held).clone() : denied ? response({ error: { message: "Reference unavailable" } }, 404) : response(nextPage));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("knowledge/preview") ? held ? (await held).clone() : denied ? response({ error: { message: "Reference unavailable" } }, 404) : response(nextPreview) : fetch()));
  return { hold: (p?: Promise<Response>) => { held = p; }, deny: (value: boolean) => { denied = value; }, preview: (value: Preview) => { nextPreview = value; }, page: (value: SearchPage) => { nextPage = value; }, fetch };
}
async function search() {
  fireEvent.change(screen.getByLabelText("Knowledge search text"), { target: { value: "needle" } });
  fireEvent.click(screen.getByRole("button", { name: "Search permitted knowledge" }));
  await screen.findByRole("heading", { name: "Permitted historic note" });
}
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  URL.createObjectURL = vi.fn(() => "blob:normalized-preview"); URL.revokeObjectURL = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("permitted search keeps exact historical entry/target and renders attachment text inertly with hashes and rights", async () => {
  fixture(); const view = render(panel()); await search();
  expect(screen.getByText("note · entry 2 · historical")).toBeTruthy();
  expect(screen.getByText(/Exact bracket revision 2.*exact-revision/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Inspect note.txt" }));
  await screen.findByRole("heading", { name: "Exact attachment inspection" });
  expect(view.container.querySelector("pre")?.textContent).toBe(text);
  expect(view.container.querySelector("script, iframe, object")).toBeNull();
  expect(screen.getByText(/rights synthetic-original/)).toBeTruthy();
  expect(screen.getByText(new RegExp(`Preview SHA-256 ${sha(text)}`))).toBeTruthy();
  expect(screen.getByRole("link", { name: "Download original inert bytes" }).getAttribute("href")).toBe("/api/v0/sources/revisions/source/file?path=note.txt");
});

test("pending then denied fresh search hides prior titles and preview; restoration retains query only", async () => {
  const f = fixture(); render(panel()); await search();
  let release!: (r: Response) => void; f.hold(new Promise(resolve => { release = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh search authority" }));
  expect(screen.queryByText("Permitted historic note")).toBeNull();
  release(response({ error: { message: "Reference unavailable" } }, 404));
  await screen.findByText("Reference unavailable");
  expect(screen.queryByText("Independent calibration needle")).toBeNull();
  f.hold(); fireEvent.click(screen.getByRole("button", { name: "Refresh search authority" }));
  await screen.findByRole("heading", { name: "Permitted historic note" });
  expect((screen.getByLabelText("Knowledge search text") as HTMLInputElement).value).toBe("needle");
});

test("denied preview clears previous search metadata and never emits old attachment text", async () => {
  const f = fixture(); render(panel()); await search(); f.deny(true);
  fireEvent.click(screen.getByRole("button", { name: "Inspect note.txt" }));
  await screen.findByText("Reference unavailable");
  expect(screen.queryByText("Permitted historic note")).toBeNull();
  expect(screen.queryByRole("heading", { name: "Exact attachment inspection" })).toBeNull();
});

test.each(["hash", "identity"])("%s mismatch prevents cached attachment bytes or metadata display", async problem => {
  const f = fixture(); render(panel()); await search();
  f.preview(problem === "hash" ? { ...preview, text: "Changed bytes" } : { ...preview, item_id: "other-item" });
  fireEvent.click(screen.getByRole("button", { name: "Inspect note.txt" }));
  await screen.findByText(problem === "hash" ? "Preview bytes do not match their integrity receipt." : "Attachment preview identity does not match the selected exact source.");
  expect(screen.queryByRole("heading", { name: "Exact attachment inspection" })).toBeNull();
});

test("inactive return and actual window blur/focus require new authority and preserve typed search", async () => {
  const f = fixture(); const view = render(panel()); await search();
  view.rerender(panel("project", "owner", false));
  expect(screen.queryByText("Permitted historic note")).toBeNull();
  f.deny(true); view.rerender(panel()); await screen.findByText("Reference unavailable");
  f.deny(false); fireEvent(window, new Event("focus")); await screen.findByRole("heading", { name: "Permitted historic note" });
  fireEvent(window, new Event("blur")); expect(screen.queryByText("Permitted historic note")).toBeNull();
  fireEvent(window, new Event("focus")); await screen.findByRole("heading", { name: "Permitted historic note" });
  expect((screen.getByLabelText("Knowledge search text") as HTMLInputElement).value).toBe("needle");
});

test.each(["project", "principal"])("%s change discards old late search response and typed state", async changed => {
  const f = fixture(); const view = render(panel());
  let release!: (r: Response) => void; f.hold(new Promise(resolve => { release = resolve; }));
  fireEvent.change(screen.getByLabelText("Knowledge search text"), { target: { value: "needle" } });
  fireEvent.click(screen.getByRole("button", { name: "Search permitted knowledge" }));
  view.rerender(changed === "project" ? panel("other-project") : panel("project", "viewer"));
  release(response(page));
  await waitFor(() => expect((screen.getByLabelText("Knowledge search text") as HTMLInputElement).value).toBe(""));
  expect(screen.queryByText("Permitted historic note")).toBeNull();
});

test("PNG preview independently hashes normalized bytes and releases its URL on focus fencing", async () => {
  const f = fixture();
  const raw = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
  const imageAttachment = { ...attachment, path: "pixels.png", media_type: "image/png", sha256: sha(raw), size: raw.length };
  f.page({ ...page, results: [{ ...row, attachments: [imageAttachment] }] });
  render(panel()); await search();
  f.preview({ ...preview, attachment: imageAttachment, kind: "png", width: 1, height: 1, bytes_base64: raw.toString("base64"), preview_sha256: sha(raw), preview_size: raw.length });
  fireEvent.click(screen.getByRole("button", { name: "Inspect pixels.png" }));
  await screen.findByRole("img", { name: "Inert normalized attachment preview" });
  fireEvent(window, new Event("blur"));
  expect(screen.queryByRole("img")).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:normalized-preview");
});

test("unsupported attachment remains explicit download-only without active embeds", async () => {
  const f = fixture(); const view = render(panel()); await search();
  f.preview({ ...preview, kind: "download_only", reason: "Unsupported active document." });
  fireEvent.click(screen.getByRole("button", { name: "Inspect note.txt" }));
  await screen.findByText("Download only: Unsupported active document.");
  expect(view.container.querySelector("img, iframe, object, embed, pre")).toBeNull();
  expect(screen.getByRole("link", { name: "Download original inert bytes" })).toBeTruthy();
});


test("history and permitted pagination use explicit submitted scope; a new search drops the old cursor", async () => {
  const f = fixture(); f.page({ ...page, next_after: "entry" }); render(panel());
  fireEvent.click(screen.getByLabelText("Include historical knowledge entries"));
  await search();
  expect(new URL(vi.mocked(fetch).mock.calls.at(-1)![0] as string, "http://localhost").searchParams.get("include_history")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Next permitted matches" }));
  await screen.findByRole("heading", { name: "Permitted historic note" });
  expect(new URL(vi.mocked(fetch).mock.calls.at(-1)![0] as string, "http://localhost").searchParams.get("after")).toBe("entry");
  fireEvent.click(screen.getByRole("button", { name: "Search permitted knowledge" }));
  await screen.findByRole("heading", { name: "Permitted historic note" });
  expect(new URL(vi.mocked(fetch).mock.calls.at(-1)![0] as string, "http://localhost").searchParams.has("after")).toBe(false);
});
