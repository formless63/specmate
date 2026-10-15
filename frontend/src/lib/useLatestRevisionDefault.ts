import { useEffect, useRef } from "react";

/**
 * Once per chosen definition, selects its latest frozen revision when nothing is selected yet.
 * Only a complete first page is trusted to contain the latest revision (reads list oldest first).
 * The user may then pick any older revision; it is never re-applied for the same definition.
 */
export function useLatestRevisionDefault(
  definitionId: string | null,
  data: { definition_id?: string; revisions: { revision_id: string; number: number }[] } | undefined,
  complete: boolean,
  value: string,
  onChange: (revisionId: string) => void,
) {
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (!definitionId || applied.current === definitionId || !data || data.definition_id !== definitionId || !complete) return;
    applied.current = definitionId;
    if (value) return;
    const latest = data.revisions.reduce<{ revision_id: string; number: number } | undefined>((best, r) => !best || r.number > best.number ? r : best, undefined);
    if (latest) onChange(latest.revision_id);
  }, [definitionId, data, complete, value, onChange]);
}
