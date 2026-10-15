import { useQueryClient } from "@tanstack/react-query";
import { Suspense, useCallback, useEffect, useRef, useState, Fragment, type ReactNode } from "react";
import { Text } from "@mantine/core";
import { useProbe } from "../probe";

/** What a library list can ask of the editor below it. */
export type EditorActions = {
  /** Brings the editor into view; with `startNew`, resets it to a blank new-item form titled "New <noun>" and focuses its name field. */
  reveal: (startNew: boolean, noun?: string) => void;
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
  // A fresh token remounts the editor, which drops any open item and unsaved state: a blank new-item form.
  const [fresh, setFresh] = useState<{ token: number; noun: string } | null>(null);
  const counter = useRef(0);
  const selected = useProbe()?.probe?.object ?? null;
  useEffect(() => { if (selected) setFresh(null); }, [selected]);
  const scroll = useCallback(() => section.current?.scrollIntoView?.({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" }), []);
  const reveal = useCallback((startNew: boolean, noun?: string) => {
    if (startNew) { counter.current += 1; setFresh({ token: counter.current, noun: noun ?? "item" }); } else setFresh(null);
    scroll();
  }, [scroll]);
  useEffect(() => {
    if (!fresh) return;
    scroll();
    // The editor may still be loading; look for its name field for about two seconds.
    let tries = 0;
    const find = () => {
      const fields = [...(section.current?.querySelectorAll<HTMLElement>(FIELD) ?? [])];
      const named = fields.find((field) => /name/i.test(field.getAttribute("aria-label") ?? field.closest("div")?.querySelector("label")?.textContent ?? ""));
      const target = named ?? fields[0];
      if (target) { target.focus({ preventScroll: true }); return true; }
      return false;
    };
    if (find()) return;
    const timer = setInterval(() => { if (find() || ++tries > 20) clearInterval(timer); }, 100);
    return () => clearInterval(timer);
  }, [fresh, scroll]);
  return <>
    {list({ reveal })}
    {/* The list stays usable while the editor's code loads. */}
    <section ref={section} className="sb-lens-editor" aria-label={`${title} editor`}>
      {fresh && <Text component="h3" className="sb-dash-row-title" data-new-item>New {fresh.noun}</Text>}
      <Suspense fallback={<Text role="status" className="sb-dash-note">Loading editor…</Text>}><Fragment key={fresh?.token ?? 0}>{editor}</Fragment></Suspense></section>
  </>;
}
