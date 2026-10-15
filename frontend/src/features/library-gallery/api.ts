import { runOperation } from "../workspace/api";

/** Why an item needs attention; counts come from existing records, nothing is re-evaluated. */
export type AttentionReason = {
  kind: "failing_check" | "unknown_check" | "open_questions" | "stale_evidence" | "unknown_values";
  count: number;
  detail: string;
};
export type HomeItem = {
  record_id: string;
  kind: string;
  label: string;
  created_at: string;
  latest_revision: number | null;
  latest_revision_id: string | null;
  changed_at: string | null;
};
export type AttentionItem = HomeItem & { status: "fail" | "unknown" | "review"; reasons: AttentionReason[] };
export type RecentItem = HomeItem & { activity: "edited" | "frozen"; at: string };
export type LibraryHome = {
  workspace_id: string;
  attention: AttentionItem[];
  attention_total: number;
  recent: RecentItem[];
  totals: { failing_checks: number; unknown_checks: number; open_questions: number; stale_evidence: number; unknown_values: number };
  kinds: { kind: string; count: number }[];
  definitions_total: number;
  scan_limit_reached: boolean;
};
export type LibraryPreview = {
  record_id: string;
  kind: string;
  source: "revision" | "draft" | "none";
  revision: number | null;
  content: Record<string, unknown> | null;
  truncated: boolean;
  stock: Record<string, unknown> | null;
};

export async function readLibraryHome(limit = 12): Promise<LibraryHome> {
  return (await runOperation<LibraryHome>("library.home", { limit })).result;
}

const BATCH = 50;
const WAIT_MS = 16;
type Waiter = { resolve: (preview: LibraryPreview | null) => void; reject: (reason: unknown) => void };
let pending = new Map<string, Waiter[]>();
let timer: ReturnType<typeof setTimeout> | null = null;

async function flush() {
  const batch = pending;
  pending = new Map();
  timer = null;
  const ids = [...batch.keys()];
  for (let start = 0; start < ids.length; start += BATCH) {
    const chunk = ids.slice(start, start + BATCH);
    try {
      const { result } = await runOperation<{ previews: LibraryPreview[] }>("library.previews", { definition_ids: chunk });
      const found = new Map(result.previews.map((preview) => [preview.record_id, preview]));
      // An id the server leaves out is not readable here; the card draws nothing for it.
      for (const id of chunk) for (const waiter of batch.get(id) ?? []) waiter.resolve(found.get(id) ?? null);
    } catch (reason) {
      for (const id of chunk) for (const waiter of batch.get(id) ?? []) waiter.reject(reason);
    }
  }
}

/**
 * One card's preview. Cards that come into view within a frame share one request of at most 50
 * ids, so a page of thumbnails costs one or two reads instead of one per card.
 */
export function loadPreview(recordId: string): Promise<LibraryPreview | null> {
  return new Promise((resolve, reject) => {
    const waiters = pending.get(recordId) ?? [];
    waiters.push({ resolve, reject });
    pending.set(recordId, waiters);
    if (timer === null) timer = setTimeout(() => void flush(), WAIT_MS);
  });
}
