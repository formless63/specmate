import { Alert, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useProbe } from "../probe";
import { requestJson } from "../workspace/api";

/** Revision numbers are allocated consecutively; resolve the one bounded catalog page. */
export function useExactRevision(enabled = true) {
  const probe = useProbe()?.probe;
  const object = probe?.object;
  const number = probe?.rev;
  return useQuery({
    queryKey: ["library-exact-revision", object, number],
    enabled: enabled && !!object && number !== null && number !== undefined,
    retry: false,
    queryFn: async ({ signal }) => {
      const offset = Math.floor((number! - 1) / 50) * 50;
      const page = await requestJson<{ definition_id: string; revisions: { revision_id: string; number: number }[] }>(`/api/v0/catalog/definitions/${encodeURIComponent(object!)}?offset=${offset}&limit=50`, { signal });
      const revision = page.definition_id === object ? page.revisions.find(row => row.number === number) : undefined;
      if (!revision) throw new Error(`Exact revision r${number} is unavailable.`);
      return revision;
    },
  });
}

/** Shared with the editor hook, so a missing historic pin never looks like a current one. */
export function ExactRevisionNotice() {
  const probe = useProbe()?.probe;
  const exact = useExactRevision();
  if (probe?.rev === null || probe?.rev === undefined) return null;
  if (exact.isError) return <Alert color="red" title="Exact revision unavailable">The selected r{probe.rev} cannot be read. A newer revision has not been substituted.</Alert>;
  if (exact.isPending) return <Text role="status">Reading exact revision r{probe.rev}…</Text>;
  return null;
}
