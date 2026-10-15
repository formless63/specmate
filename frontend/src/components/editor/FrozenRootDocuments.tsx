import { Button, Group, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import type { Identity } from "../../features/identity/api";
import { useNavigation } from "../../features/navigation";
import { useProbe } from "../../features/probe";
import { requestJson, type LibraryRecord } from "../../features/workspace/api";
import { RootDocuments } from "./Documents";

/** Interim frozen-root slot; harness/device editing remains owned by their editor slices. */
export function FrozenRootDocuments({ kind, record, workspaceId, principalKey, active, children }: {
  kind: "harness" | "assembly"; record?: LibraryRecord; workspaceId: string; principalKey: string; active: boolean; children: ReactNode;
}) {
  const navigation = useNavigation(); const probe = useProbe()?.probe;
  const documents = navigation?.location.filters?.view === "documents";
  const [buildVisited, setBuildVisited] = useState(!documents);
  useEffect(() => { if (!documents) setBuildVisited(true); }, [documents]);
  const [targets, setTargets] = useState<Record<string, { record: LibraryRecord; revision: number | null }>>({});
  useEffect(() => {
    if (record?.kind === kind && probe?.object === record.record_id && active) setTargets(previous => ({ ...previous, [record.record_id]: { record, revision: probe.rev ?? record.latest_revision } }));
  }, [record, probe?.object, probe?.rev, kind, active]);
  const show = (view: "build" | "documents") => navigation?.navigate({ filters: { ...navigation.location.filters, view } });
  return <Stack gap="xs"><Group><Button size="xs" variant={documents ? "quiet" : "default"} onClick={() => show("build")}>Build</Button><Button size="xs" variant={documents ? "default" : "quiet"} onClick={() => show("documents")}>Documents</Button></Group>
    <div hidden={documents}>{buildVisited ? children : null}</div>
    {Object.values(targets).map(target => <FrozenSession key={target.record.record_id} {...target} workspaceId={workspaceId} principalKey={principalKey} active={active && documents && probe?.object === target.record.record_id} />)}
  </Stack>;
}
function FrozenSession({ record, revision, workspaceId, principalKey, active }: {
  record: LibraryRecord; revision: number | null; workspaceId: string; principalKey: string; active: boolean;
}) {
  const offset = revision ? Math.floor((revision - 1) / 50) * 50 : 0;
  const identity = useQuery({ queryKey: ["document-root-identity", principalKey, workspaceId, record.record_id, offset], queryFn: () => requestJson<Identity>(`/api/v0/catalog/definitions/${record.record_id}?offset=${offset}`), enabled: active && !!revision, retry: false });
  const revisionId = identity.data?.revisions.find(row => row.number === revision)?.revision_id ?? null;
  return <div hidden={!active}>
    {identity.isError ? <Stack gap="xs"><Text role="status">This exact design is unavailable.</Text><Button size="xs" onClick={() => void identity.refetch()}>Retry exact design access</Button></Stack> : !revision ? <Text role="status">Freeze a revision to prepare exact documents. Working documents are not available for this design kind yet.</Text> : !revisionId ? <Text role="status">{identity.isFetching ? "Reading exact design revision…" : "This exact revision is unavailable."}</Text> : null}
    {revisionId && <RootDocuments name={record.label} snapshot={{ definitionId: record.record_id, revisionId, draftId: null }} workspaceId={workspaceId} principalKey={principalKey} active={active && !identity.isError && !identity.isFetching} authorizeWorking={async () => { throw new Error("No working adapter is available."); }} />}
  </div>;
}
