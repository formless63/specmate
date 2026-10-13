import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SourceError } from "../sources/api";
import { randomUUID } from "../../lib/random-id";

export const KnowledgeScope = createContext<{ id: string; pending: boolean; reading: (key: string, pending: boolean) => void; onAccessLost: () => void; current: () => boolean }>({ id: "", pending: false, reading: () => {}, onAccessLost: () => {}, current: () => true });
export function useKnowledgeScope() { return useContext(KnowledgeScope); }
export function useCurrent() {
  const scope = useContext(KnowledgeScope);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return () => mounted.current && scope.current();
}
export function useKnowledgeQuery<T>(key: readonly unknown[], queryFn: () => Promise<T>, enabled = true) {
  const scope = useContext(KnowledgeScope);
  const query = useQuery<T, Error>({ queryKey: [key[0], scope.id, ...key.slice(1)], queryFn, enabled, staleTime: 0, refetchOnMount: "always", refetchOnWindowFocus: "always", retry: false });
  const errorSeen = useRef<Error | null>(null);
  const [readKey] = useState(randomUUID);
  useEffect(() => { scope.reading(readKey, query.isFetching); return () => { scope.reading(readKey, false); }; }, [scope.reading, readKey, query.isFetching]);
  useEffect(() => {
    if (query.error !== errorSeen.current && query.error instanceof SourceError && [401, 403, 404].includes(query.error.status) && scope.current()) { errorSeen.current = query.error; scope.onAccessLost(); }
  }, [query.error, scope]);
  // Retained query data is not current authority while a refresh is held or denied.
  return { ...query, data: scope.pending || query.isFetching || query.isError ? undefined : query.data };
}
export function useIntentKey() {
  const prepared = useRef<{ fingerprint: string; key: string } | null>(null);
  return {
    for: (operation: string, payload: object, state?: string) => {
      const fingerprint = JSON.stringify([operation, payload, state]);
      if (prepared.current?.fingerprint !== fingerprint) prepared.current = { fingerprint, key: randomUUID() };
      return prepared.current.key;
    },
    complete: () => { prepared.current = null; },
  };
}
