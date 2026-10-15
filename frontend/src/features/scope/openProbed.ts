import { useCallback, useEffect, useRef } from "react";
import { useProbe } from "../probe";
import { addProjectReference } from "../identity/api";

/**
 * Opens the probed library item in a lens's editor. The Library list, a deep link or any other
 * view sets the probe; an editor calls this with a test for the records it can open (null while its
 * list is still loading) and the action that opens one. Each probed object is opened once, so
 * choosing another item in the editor afterwards is never undone. Without a probe nothing happens.
 */
export function useOpenProbed(canOpen: ((object: string) => boolean) | null, open: (object: string) => void) {
  const object = useProbe()?.probe?.object ?? null;
  const applied = useRef<string | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (!object) { applied.current = null; return; }
    if (applied.current === object || !canOpen || !canOpen(object)) return;
    applied.current = object;
    openRef.current(object);
  }, [object, canOpen]);
}

/** Test for useOpenProbed over a definition list: a listed definition of one of `kinds` (any kind when empty). */
export function definitionIn(definitions: { definition_id: string; kind: string }[] | undefined, kinds: string[]): ((object: string) => boolean) | null {
  if (!definitions) return null;
  return (object) => definitions.some((item) => item.definition_id === object && (kinds.length === 0 || kinds.includes(item.kind)));
}

/**
 * After creating an item with a project as context, adds that project's reference to it. The item
 * already lives in the workspace library; a failure here only means the project does not list it yet.
 */
export async function referenceFromProject(projectId: string | null | undefined, definitionId: string, role: string) {
  if (!projectId) return;
  try { await addProjectReference(projectId, "definition", definitionId, role); }
  catch (reason) {
    throw new Error(`Saved in the library, but not added to this project: ${reason instanceof Error ? reason.message : String(reason)}`);
  }
}

/**
 * Once an opened definition's identity loads, opens its newest draft for editing, or its latest
 * frozen revision when it has no draft. Returns the function that arms this for one definition.
 * Picking a draft or revision in the editor afterwards is never undone.
 */
export function useOpenNewest(
  identity: { definition_id: string; drafts: { draft_id: string }[]; revisions: { revision_id: string }[] } | undefined,
  openDraft: (draftId: string) => void,
  openRevision?: (revisionId: string) => void,
): (definitionId: string) => void {
  const pending = useRef<string | null>(null);
  const handlers = useRef({ openDraft, openRevision });
  handlers.current = { openDraft, openRevision };
  useEffect(() => {
    if (!identity || pending.current !== identity.definition_id) return;
    pending.current = null;
    const draft = identity.drafts.at(-1);
    if (draft) { handlers.current.openDraft(draft.draft_id); return; }
    // A full page may have later revisions on the next one; leave that choice to the member.
    const revision = identity.revisions.length < 50 ? identity.revisions.at(-1) : undefined;
    if (revision) handlers.current.openRevision?.(revision.revision_id);
  }, [identity]);
  return useCallback((definitionId: string) => { pending.current = definitionId; }, []);
}
