import { command, registerBlob } from "../sources/api";
import type { Target } from "../facts/api";
export { read, type Definition, type Identity } from "../identity/api";
export type { RevisionDetail, SourcePage } from "../sources/api";
export type { Target } from "../facts/api";

export type Kind = "note" | "decision" | "attachment";
export type DecisionStatus = "proposed" | "accepted" | "rejected" | "superseded";
export type AttachmentRef = { bundle_revision_id: string; path: string; label: string };
export type Content = { title: string; body: string; decision_status: DecisionStatus | null; attachments: AttachmentRef[] };
export type Attachment = AttachmentRef & {
  bundle_id: string; bundle_name: string; revision_number: number; sha256: string; size: number;
  media_type: string; rights: string; blob_project_id: string;
};
export type Entry = { entry_id: string; number: number; title: string; body: string; decision_status: DecisionStatus | null; author: string; created_at: string; attachments: Attachment[] };
export type Link = {
  link_id: string; item_id: string; target: Target; project_id: string; label: string;
  feature_status?: "not_evaluated"; linked_at: string; status: "active" | "removed";
  removed_at?: string; removal_reason?: string;
};
export type ItemSummary = { item_id: string; project_id: string; kind: Kind; state: string; current: Entry };
export type Item = ItemSummary & { history: Entry[]; links: Link[]; removed_links: Link[]; relation_to_design_state: "attached_knowledge" };
export type ItemPage = { items: (ItemSummary & { link_id?: string })[]; offset: number; limit: number; has_more: boolean };
export type TargetItems = ItemPage & { target: { label: string; target: Target; feature_status?: string } };

export function operate<T>(operation: string, payload: object, expectedState?: string) {
  return command<T>(operation, payload, { expectedState });
}
export function lookup<T>(operation: string, payload: object) {
  return command<T>(operation, payload, { idempotent: false });
}
export function downloadUrl(attachment: Pick<Attachment, "bundle_revision_id" | "path">) {
  return `/api/v0/sources/revisions/${encodeURIComponent(attachment.bundle_revision_id)}/file?path=${encodeURIComponent(attachment.path)}`;
}
/** Preserve bytes through the shared source operations and return an attachment reference. */
export async function preserveAttachment(projectId: string, file: File, rights: string, label: string): Promise<AttachmentRef> {
  const sha256 = await registerBlob(projectId, file);
  const bundle = await command<{ revision_id: string }>("source.create_original_bundle", {
    project_id: projectId, name: file.name, files: [{ path: file.name, sha256, media_type: file.type || "application/octet-stream", rights }],
  });
  return { bundle_revision_id: bundle.revision_id, path: file.name, label };
}
