import { Alert, Table, Text, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { MiddleTruncate } from "../../lib/MiddleTruncate";
import { RevisionLabel } from "../../lib/IdentityLabel";
import { runOperation } from "../workspace/api";

export type ShareRecord = {
  id: string; kind: string; root_revision_id: string; release_id: string | null; purpose: string;
  archive_sha256: string; manifest_sha256: string; shared_by: number; shared_by_username: string; shared_at: string; via: string;
};
type Page = { workspace_id: string; shares: ShareRecord[]; total: number; offset: number; limit: number };

const KINDS: Record<string, string> = { export_package: "Export package", selected_package: "Selected package", release: "Release archive" };
const PAGE = 50;

/**
 * The workspace's sharing record (KNW-004): every copy that left the workspace, who handed it out and when.
 * Every member can read it; rows are append-only, so this is a read-only table.
 */
export function ShareRecordsPanel({ workspaceId }: { workspaceId?: string | null }) {
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    setError(null);
    runOperation<Page>("share.list", { workspace_id: workspaceId, offset, limit: PAGE })
      .then((response) => { if (live) setPage(response.result); })
      .catch((reason: unknown) => { if (live) { setPage(null); setError(reason instanceof Error ? reason.message : "Unable to read the sharing record."); } });
    return () => { live = false; };
  }, [workspaceId, offset]);

  return <section className="sb-dash" aria-labelledby="sb-share-records">
    <Title order={2} id="sb-share-records" className="sb-dash-title">Sharing record</Title>
    <Text className="sb-dash-note">Every package or release archive handed out of this workspace. Entries cannot be edited or removed.</Text>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    {!page ? (!error && <Text>Reading sharing record…</Text>) : page.shares.length === 0 ? <Text>Nothing has been shared from this workspace.</Text> : <>
      <div className="sb-ws-scroll"><Table className="sb-ws-table" verticalSpacing={4} horizontalSpacing="sm">
        <Table.Thead><Table.Tr><Table.Th>What</Table.Th><Table.Th>Root and revision</Table.Th><Table.Th>Purpose</Table.Th><Table.Th>Archive SHA-256</Table.Th><Table.Th>Manifest SHA-256</Table.Th><Table.Th>Shared by</Table.Th><Table.Th>When</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{page.shares.map((row) => <Table.Tr key={row.id}>
          <Table.Td>{KINDS[row.kind] ?? row.kind}</Table.Td>
          <Table.Td><RevisionLabel id={row.root_revision_id} /></Table.Td>
          <Table.Td>{row.purpose}</Table.Td>
          <Table.Td><MiddleTruncate text={row.archive_sha256} /></Table.Td>
          <Table.Td><MiddleTruncate text={row.manifest_sha256} /></Table.Td>
          <Table.Td className="sb-mono">{row.shared_by_username}</Table.Td>
          <Table.Td className="sb-mono"><time dateTime={row.shared_at}>{new Date(row.shared_at).toLocaleString()}</time></Table.Td>
        </Table.Tr>)}</Table.Tbody></Table></div>
      <Text size="xs" className="sb-dash-note">{page.offset + 1}–{page.offset + page.shares.length} of {page.total}
        {page.offset > 0 && <> · <button type="button" className="sb-exact-toggle" onClick={() => setOffset(Math.max(0, offset - PAGE))}>Newer</button></>}
        {page.offset + page.shares.length < page.total && <> · <button type="button" className="sb-exact-toggle" onClick={() => setOffset(offset + PAGE)}>Older</button></>}
      </Text>
    </>}
  </section>;
}
