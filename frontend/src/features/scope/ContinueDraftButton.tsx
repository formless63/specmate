import { Button } from "@mantine/core";

/**
 * The explicit way from a frozen revision's inspection view into the item's draft editor. Open lands
 * on the frozen view; this appears only while a revision is shown, no draft is open and the item has
 * a draft, so a frozen item is never edited by accident. The draft editor stays behind the panel's
 * own permission checks.
 */
export function ContinueDraftButton({ drafts, revisionId, draftId, onOpen }: {
  drafts: { draft_id: string }[] | undefined; revisionId: string | null; draftId: string | null; onOpen: (draftId: string) => void;
}) {
  const newest = drafts?.at(-1);
  if (!newest || !revisionId || draftId) return null;
  return <Button variant="light" onClick={() => onOpen(newest.draft_id)}>Continue draft (edit)</Button>;
}
