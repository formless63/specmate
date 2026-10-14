import { createContext, useContext } from "react";
import type { LibraryRecord } from "../workspace/api";

/**
 * A library item chosen in one scope and opened in a project's lens. Panels may read it to
 * preselect the item; it is a navigation hint only and never grants or limits access.
 */
export type RecordFocus = { projectId: string; toolId: string; record: LibraryRecord };

export const RecordFocusContext = createContext<RecordFocus | null>(null);

/** The focused item for this lens in the current project, if any. */
export function useRecordFocus(toolId: string): LibraryRecord | null {
  const focus = useContext(RecordFocusContext);
  return focus && focus.toolId === toolId ? focus.record : null;
}
