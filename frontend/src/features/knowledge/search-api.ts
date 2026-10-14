import { sha256Hex } from "../../lib/sha256";
import { request } from "../sources/api";
import type { Attachment, Link } from "./api";

export type SearchRow = { record_id: string; item_id: string; workspace_id: string; project_id: string | null; kind: string; entry_id: string; entry_number: number; current: boolean; title: string; decision_status: string | null; matches: { field: string; text: string }[]; attachments: Attachment[]; links: Link[] };
export type SearchPage = { query: string; results: SearchRow[]; next_after: string | null };
export type SearchInput = { workspace_id: string; project_id?: string; query: string; include_history: boolean; after?: string };
export type PreviewInput = { item_id: string; entry_id: string; bundle_revision_id: string; path: string };
type PreviewBase = { item_id: string; entry_id: string; entry_number: number; attachment: Attachment; qualification: "not_evaluated"; integrity: string; transformation?: string };
export type Preview = PreviewBase & (
  { kind: "text"; text: string; preview_sha256: string; preview_size: number }
  | { kind: "png"; bytes_base64: string; preview_sha256: string; preview_size: number; width: number; height: number }
  | { kind: "zip"; members: { path: string; size: number; directory: boolean }[] }
  | { kind: "download_only"; reason: string }
);
function queryUrl(path: string, input: object) {
  return `knowledge/${path}?${new URLSearchParams(Object.entries(input).map(([key, value]) => [key, String(value)]))}`;
}
export const searchKnowledge = (input: SearchInput, signal: AbortSignal) => request<SearchPage>(queryUrl("search", input), { signal, cache: "no-store" });
export async function previewAttachment(input: PreviewInput, expected: Attachment, signal: AbortSignal) {
  const preview = await request<Preview>(queryUrl("preview", input), { signal, cache: "no-store" });
  if (preview.item_id !== input.item_id || preview.entry_id !== input.entry_id ||
      preview.attachment.bundle_revision_id !== input.bundle_revision_id || preview.attachment.path !== input.path ||
      preview.attachment.sha256 !== expected.sha256 || preview.attachment.size !== expected.size ||
      preview.attachment.rights !== expected.rights || preview.attachment.blob_workspace_id !== expected.blob_workspace_id) {
    throw new Error("Attachment preview identity does not match the selected exact source.");
  }
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  if (preview.kind === "text") bytes = new TextEncoder().encode(preview.text);
  else if (preview.kind === "png") {
    if (preview.bytes_base64.length > 6 * 1024 * 1024) throw new Error("Preview exceeds the supported byte limit.");
    bytes = Uint8Array.from(atob(preview.bytes_base64), value => value.charCodeAt(0));
    if (!(preview.width > 0 && preview.height > 0 && preview.width <= 2048 && preview.height <= 2048 && preview.width * preview.height <= 1024 * 1024) ||
        ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes![index] === value)) throw new Error("Unsupported PNG preview.");
  }
  if (preview.kind === "text" || preview.kind === "png") {
    if (!bytes || bytes.length !== preview.preview_size || bytes.length > (preview.kind === "text" ? 128 * 1024 : 4 * 1024 * 1024) ||
        await sha256Hex(bytes.buffer) !== preview.preview_sha256 ||
        (preview.kind === "text" && preview.preview_sha256 !== expected.sha256)) throw new Error("Preview bytes do not match their integrity receipt.");
  }
  return { preview, bytes };
}
