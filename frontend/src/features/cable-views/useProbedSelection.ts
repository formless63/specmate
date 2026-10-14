import { useEffect, useRef } from 'react';
import { useProbe } from '../probe';

/**
 * Lets a tool's own pickers follow the shared probe: selecting a definition of `kind` elsewhere
 * (the Library, a URL) selects it here, and a probe revision number selects that exact frozen
 * revision, or the latest when the probe names none. Each probe is applied once, so choosing
 * differently afterwards is never undone. Without a probe nothing happens.
 */
export function useProbedSelection({ kind, definitions, definitionId, revisions, pickDefinition, pickRevision }: {
  kind: string;
  definitions: { definition_id: string; kind: string }[] | undefined;
  definitionId: string | null;
  /** Revisions of `definitionId` (one page, oldest first); undefined until read for that definition. */
  revisions: { revision_id: string; number: number }[] | undefined;
  pickDefinition: (id: string) => void;
  pickRevision: (id: string) => void;
}) {
  const probe = useProbe()?.probe ?? null;
  const object = probe?.object ?? null;
  const rev = probe?.rev ?? null;
  const definitionApplied = useRef<string | null>(null);
  const revisionApplied = useRef<string | null>(null);
  useEffect(() => {
    if (!object || definitionApplied.current === object) return;
    if (!definitions?.some(d => d.definition_id === object && d.kind === kind)) return;
    definitionApplied.current = object; revisionApplied.current = null;
    if (object !== definitionId) pickDefinition(object);
  }, [object, definitions, definitionId, kind, pickDefinition]);
  useEffect(() => {
    if (!object || definitionApplied.current !== object || definitionId !== object || !revisions) return;
    const key = `${object}@${rev ?? ''}`;
    if (revisionApplied.current === key) return;
    const chosen = rev === null ? (revisions.length > 0 && revisions.length < 50 ? revisions[revisions.length - 1] : undefined) : revisions.find(r => r.number === rev);
    revisionApplied.current = key;
    if (chosen) pickRevision(chosen.revision_id);
  }, [object, rev, definitionId, revisions, pickRevision]);
}
