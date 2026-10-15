import { useQueryClient } from "@tanstack/react-query";
import { Suspense, useCallback, useEffect, useRef, type ReactNode } from "react";
import { Text } from "@mantine/core";

/** What a library list can ask of the editor below it. */
export type EditorActions = {
  /** Brings the editor into view; with `startNew`, focuses its first field for a new item. */
  reveal: (startNew: boolean) => void;
};

const FIELD = "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([disabled]), textarea:not([disabled])";

function reducedMotion(): boolean {
  try { return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false; } catch { return false; }
}

/**
 * A lens whose collection is edited here: the dense library list on top and the lens's editor
 * below it, at Library scope and at project scope alike. Selecting a row sets the shared probe and
 * the editor opens that item; "New" brings the editor's creation fields into view. Successful edits
 * anywhere refresh the list, so a created or renamed item shows up without a reload.
 */
export function EditingLens({ title, list, editor }: { title: string; list: (actions: EditorActions) => ReactNode; editor: ReactNode }) {
  const cache = useQueryClient();
  const section = useRef<HTMLElement>(null);
  useEffect(() => cache.getMutationCache().subscribe((event) => {
    if (event.type === "updated" && event.action.type === "success") void cache.invalidateQueries({ queryKey: ["workspace", "library"] });
  }), [cache]);
  const reveal = useCallback((startNew: boolean) => {
    const target = section.current;
    if (!target) return;
    target.scrollIntoView?.({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
    if (startNew) target.querySelector<HTMLElement>(FIELD)?.focus({ preventScroll: true });
  }, []);
  return <>
    {list({ reveal })}
    {/* The list stays usable while the editor's code loads. */}
    <section ref={section} className="sb-lens-editor" aria-label={`${title} editor`}><Suspense fallback={<Text role="status" className="sb-dash-note">Loading editor…</Text>}>{editor}</Suspense></section>
  </>;
}
