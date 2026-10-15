import { useEffect, useRef, useState } from "react";
import { useNewRequest } from "../library-gallery/newRequest";
import { LIBRARY_VIEWS } from "../shell/scope";

/** A Library New request reaches the panel's actual creation form after it becomes active. */
export function useNewFormRequest(toolId: string, enabled: boolean, onNew?: () => void) {
  const form = useRef<HTMLDivElement>(null);
  const [requested, setRequested] = useState(0);
  useNewRequest(LIBRARY_VIEWS[toolId]!, enabled, () => { onNew?.(); setRequested(value => value + 1); });
  useEffect(() => {
    if (!requested || !enabled) return;
    const field = form.current?.querySelector<HTMLElement>('input:not([disabled]):not([readonly]), select:not([disabled])');
    field?.scrollIntoView?.({ block: 'center' });
    field?.focus();
  }, [requested, enabled]);
  return form;
}
