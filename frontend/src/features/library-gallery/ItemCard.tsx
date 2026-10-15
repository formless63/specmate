import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { SbLed } from "../../components/sb";
import { loadPreview, type AttentionItem, type LibraryPreview } from "./api";
import { countUnknown, ItemThumb } from "./thumbs";
import "./library-gallery.css";

export type CardItem = { record_id: string; kind: string | null; label: string; latest_revision: number | null };
export type CardStatus = { led: SbLed; words: string };

const ATTENTION_LED: Record<AttentionItem["status"], SbLed> = { fail: "failed", unknown: "unknown", review: "review" };

function reviewOf(content: Record<string, unknown> | null): string | null {
  if (!content) return null;
  for (const value of Object.values(content)) {
    const review = value && typeof value === "object" ? (value as Record<string, unknown>).review : undefined;
    if (typeof review === "string") return review;
  }
  return null;
}

/**
 * The card's status LED and its words. Recorded attention (a failing or unknown recorded check,
 * stale evidence, open questions) comes first; otherwise the item's own content speaks: unknown
 * declared values, then its recorded review state. There is no generic OK: without a recorded
 * review the card says so.
 */
export function cardStatus(preview: LibraryPreview | null | undefined, attention?: AttentionItem): CardStatus {
  if (attention) return { led: ATTENTION_LED[attention.status], words: attention.reasons.map((reason) => reason.detail).join(" · ") };
  if (preview === undefined) return { led: "off", words: "reading" };
  if (preview === null) return { led: "off", words: "not readable" };
  const content = preview.content;
  const rows = (content?.interface as { rows?: { question?: unknown }[] } | undefined)?.rows ?? [];
  const questions = rows.filter((row) => row.question).length;
  if (questions) return { led: "review", words: `${questions} open question${questions === 1 ? "" : "s"}` };
  const unknown = countUnknown(content?.interface);
  if (unknown) return { led: "unknown", words: `${unknown} unknown` };
  const review = reviewOf(content);
  if (review === "reviewed") return { led: "info", words: "reviewed" };
  if (review) return { led: "review", words: review.replaceAll("_", " ") };
  return { led: "not-evaluated", words: "no review recorded" };
}

/** Starts reading once the card is near the viewport (immediately where observers are unavailable). */
function useNearViewport<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (near || !ref.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setNear(true); observer.disconnect(); }
    }, { rootMargin: "200px" });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [near]);
  return [ref, near];
}

const GLYPH_ONLY: LibraryPreview = { record_id: "", kind: "", source: "none", revision: null, content: null, truncated: false, stock: null };

export function revisionTag(item: CardItem): string {
  return item.latest_revision !== null ? `r${item.latest_revision}` : "draft";
}

/**
 * One library item as a card: a drawn thumbnail, kind and revision tag (solid when frozen,
 * dashed while only a draft exists), the name and a status LED with words. Selecting the card
 * opens the item. Thumbnails load lazily and in shared batches.
 */
export function ItemCard({ item, principalKey, attention, usedIn, selected, related, onOpen, note, drawn = true, status: given, expectedState }: {
  item: CardItem;
  /** A typed list pins the thumbnail to its selected saved state. */
  expectedState?: { revision: number | null; draftVersion: number | null };
  /** Definitions are drawn from their content; other records show their kind glyph only. */
  drawn?: boolean;
  /** A fixed status for records without content to read (source bundles, stock accounts, …). */
  status?: CardStatus;
  principalKey: string;
  attention?: AttentionItem;
  /** "used in 2 projects" and the like; omitted where not known. */
  usedIn?: string;
  selected?: boolean;
  related?: boolean;
  onOpen: () => void;
  /** Extra line, such as "edited 4 min ago". */
  note?: string;
}) {
  const [ref, near] = useNearViewport<HTMLButtonElement>();
  const preview = useQuery({
    queryKey: ["workspace", "library", "preview", principalKey, item.record_id],
    queryFn: () => loadPreview(item.record_id),
    enabled: near && drawn, staleTime: 60_000, retry: false,
  });
  const loaded = preview.isError ? null : preview.data;
  const mismatch = !!expectedState && !!loaded && (expectedState.revision !== loaded.revision
    || expectedState.revision === null && (loaded.source !== "draft" || expectedState.draftVersion !== loaded.draft_version));
  const shown = mismatch ? null : loaded;
  const status = preview.isError ? { led: "unknown" as const, words: "Not readable" } : mismatch ? { led: "unknown" as const, words: "Saved state changed; refresh the list" } : given ?? cardStatus(loaded, attention);
  const kind = item.kind ?? "item";
  const frozen = item.latest_revision !== null;
  return <button ref={ref} type="button" className="lg-card" data-status={attention?.status} data-selected={selected || undefined}
    data-related={related || undefined} aria-pressed={selected ?? false} onClick={onOpen}
    aria-label={`Open ${item.label}, ${kind.replaceAll("_", " ")} ${revisionTag(item)}, ${status.words}`}>
    <span className="lg-thumb">{!drawn ? <ItemThumb kind={kind} label={item.label} preview={GLYPH_ONLY} recordId={item.record_id} />
      : near ? <ItemThumb kind={kind} label={item.label} preview={shown} recordId={item.record_id} /> : <span className="lg-thumb-loading" aria-hidden="true" />}</span>
    <span className="lg-card-body">
      <span className="lg-card-meta">
        <span className="lg-kind">{kind.replaceAll("_", " ")}</span>
        {(drawn || frozen) && <span className="lg-rev" data-frozen={frozen || undefined} title={frozen ? "Latest frozen revision" : "Never frozen: draft only"}>{revisionTag(item)}</span>}
      </span>
      <span className="lg-name" title={item.label}>{item.label}</span>
      <span className="lg-status"><span className="sb-led" data-state={status.led} aria-hidden="true" /><span>{status.words}</span></span>
      {(usedIn || note) && <span className="lg-used">{[usedIn, note].filter(Boolean).join(" · ")}</span>}
    </span>
  </button>;
}
