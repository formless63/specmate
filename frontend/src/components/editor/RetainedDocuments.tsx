import { Alert, Button, Group, Select, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ApiError, listSets, receipt, download, saveFile, type Output } from "../../features/preparation-documents/api";

/** Exact retained identity and bytes: no current defaults, projection or generation on reopen. */
export function RetainedDocuments({ rootRevisionId, principalKey, workspaceId, active, onDenied }: {
  rootRevisionId: string; principalKey: string; workspaceId: string; active: boolean; onDenied: (error: unknown) => void;
}) {
  const [after, setAfter] = useState<string | null>(null), [pages, setPages] = useState<(string | null)[]>([]);
  const [selected, setSelected] = useState<string | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [withdrawn, setWithdrawn] = useState(false);
  const alive = useRef(false), current = useRef({ active, selected }); current.current = { active, selected };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  function fail(reason: unknown) {
    if (!alive.current) return;
    if (reason instanceof ApiError && [401, 403, 404].includes(reason.status)) { setWithdrawn(true); if (current.current.active) onDenied(reason); }
    if (alive.current) setError(reason instanceof Error ? reason.message : "Retained documents are unavailable.");
  }
  const choices = useQuery({ queryKey: ["retained-document-sets", principalKey, workspaceId, rootRevisionId, after], enabled: active, retry: false, staleTime: 0,
    queryFn: async () => { try { return await listSets(rootRevisionId, after); } catch (reason) { fail(reason); throw reason; } },
  });
  const retained = useQuery({ queryKey: ["retained-document-receipt", principalKey, workspaceId, rootRevisionId, selected], enabled: active && !!selected, retry: false, staleTime: 0,
    queryFn: async () => {
      try { const value = await receipt(selected!); if (value.manifest.inputs.root.revision_id !== rootRevisionId) throw new Error("The retained set belongs to another exact root."); return value; }
      catch (reason) { fail(reason); throw reason; }
    },
  });
  const hidden = withdrawn || !active || choices.isFetching || choices.isError || retained.isFetching || retained.isError;
  const value = hidden ? null : retained.data;
  async function getFile(output: Output) {
    if (!value || busy || !selected) return;
    const identifier = selected; setBusy(true); setError("");
    try { const blob = await download(identifier, output); if (alive.current && current.current.active && current.current.selected === identifier) saveFile(blob, output.filename); }
    catch (reason) { if (alive.current && current.current.selected === identifier) fail(reason); }
    finally { if (alive.current) setBusy(false); }
  }
  async function refresh() {
    if (!active || busy) return; setBusy(true); setError("");
    try { await choices.refetch({ throwOnError: true }); if (selected) await retained.refetch({ throwOnError: true }); if (alive.current && current.current.active) setWithdrawn(false); } catch (reason) { fail(reason); } finally { if (alive.current) setBusy(false); }
  }
  return <Stack gap="xs"><Text fw={600}>Retained document sets</Text><Group><Button size="xs" variant="quiet" disabled={!active || busy} onClick={() => void refresh()}>Refresh retained document access</Button><Button size="xs" variant="quiet" disabled={!active || busy || !after} onClick={() => { setAfter(null); setPages([]); setError(""); }}>Newest document sets</Button><Button size="xs" variant="quiet" disabled={!active || hidden || !pages.length} onClick={() => { setAfter(pages.at(-1) ?? null); setPages(old => old.slice(0, -1)); }}>Newer document sets</Button><Button size="xs" variant="quiet" disabled={!active || hidden || !choices.data?.next_after} onClick={() => { setPages(old => [...old, after]); setAfter(choices.data!.next_after); }}>Older document sets</Button></Group>
    {error && <Alert color="red">{error}</Alert>}
    {hidden && <Text role="status">{choices.isError || retained.isError ? "Retained content is unavailable until current access is confirmed." : active ? "Reading retained document access…" : ""}</Text>}
    {!hidden && <><Select label="Retained document set" clearable searchable dropdownOpened={active ? undefined : false} value={selected} onChange={setSelected} data={choices.data?.results.map(row => ({ value: row.document_set_id, label: `${row.created_at} · ${row.generator} · quantity ${row.quantity ?? "unknown"}` })) ?? []} />
      {!choices.data?.results.length && <Text size="sm">No currently readable document sets on this page.</Text>}
      {value && <><Text size="sm">Immutable set {value.document_set_id} · {value.generator}</Text><Text size="xs" className="sb-mono">Input SHA-256 {value.sha256}</Text><Text size="xs">Exact retained root {value.manifest.inputs.root.revision_id}. Download preserves the original file and its hash.</Text>{value.manifest.outputs.map(output => <Group key={output.filename}><Button size="xs" variant="quiet" disabled={busy} onClick={() => void getFile(output)}>Download historic {output.filename}</Button><Text size="xs" className="sb-mono">{output.sha256} · {output.size} bytes</Text></Group>)}</>}
    </>}
  </Stack>;
}
