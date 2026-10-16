import { Alert, Button, Card, Group, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { InspectionScope, ReadOnlyNote, usePermission } from "../../lib/permissions";
import { SbIdentityBadge, SbStatus, SbUnknown } from "../../components/sb";
import { request, type RevisionDetail, type SourcePage } from "../sources/api";
import type { Catalog, Representation, RightsStatus, SourceIdentifier } from "./api";

import { newestFirst } from '../../lib/revision-labels';
const KINDS = ["datasheet", "symbol", "footprint", "model", "drawing"];

/** Cleared is a recorded status, not an approval; restricted and unknown are never shown as OK. */
function Rights({ text, status }: { text: string; status: RightsStatus }) {
  if (status === "cleared") return <SbStatus led="info" dimension="rights" value={`cleared · ${text}`} />;
  if (status === "restricted") return <SbStatus led="review" dimension="rights" value={`restricted · ${text}`} />;
  return <SbStatus led="review" dimension="rights" value={`not cleared · ${text}`} />;
}

const RIGHTS_OPTIONS = [{ value: "unknown", label: "Unknown (not cleared)" }, { value: "restricted", label: "Restricted" }, { value: "cleared", label: "Cleared" }];

function RevisionPin({ revisionNumber, name }: { revisionNumber: number; name: string }) {
  return <Group gap={6} wrap="nowrap"><SbIdentityBadge kind="frozen">{`Revision ${revisionNumber}`}</SbIdentityBadge><Text size="sm">{name}</Text></Group>;
}

/**
 * Datasheets, symbols, footprints, models and external source identifiers linked to one exact
 * revision. A representation documents the design; it is not an orderable part or a lot.
 */
export function RepresentationsCard({ catalog, workspaceId, pending, register, active = true, scopeKey = "" }: {
  scopeKey?: string; active?: boolean; catalog: Catalog | undefined; workspaceId: string | null; pending: boolean; register: (operation: string, payload: object) => void;
}) {
  const gate = usePermission("item.create");
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<string | null>("datasheet");
  const [bundleId, setBundleId] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [scheme, setScheme] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [idLabel, setIdLabel] = useState("");
  const [rights, setRights] = useState("");
  const [repStatus, setRepStatus] = useState<string | null>(null);
  const [idStatus, setIdStatus] = useState<string | null>(null);
  const bundles = useQuery({ queryKey: ["source-revisions", scopeKey, workspaceId], enabled: active && !!workspaceId, queryFn: () => request<SourcePage>(`sources/workspaces/${workspaceId}/revisions`) });
  const detail = useQuery({ queryKey: ["source-revision", scopeKey, bundleId], enabled: active && !!bundleId, queryFn: () => request<RevisionDetail>(`sources/revisions/${bundleId}`) });
  const sourceRevisions = active && !bundles.isError && !bundles.isFetching ? bundles.data?.revisions ?? [] : [];
  const sourceFiles = active && !detail.isError && !detail.isFetching ? detail.data?.manifest.files ?? [] : [];
  const file = sourceFiles.find((f) => f.path === path);
  return <Card withBorder><Stack gap="xs">
    <Title order={3}>Representations and source references</Title>
    <Text size="sm">These document this exact revision. A datasheet, symbol, footprint or model is not an orderable part or a physical lot, and linking one does not qualify the part.</Text>
    <Table><Table.Thead><Table.Tr><Table.Th>Kind</Table.Th><Table.Th>Documents</Table.Th><Table.Th>Source file</Table.Th><Table.Th>Rights</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
      {catalog?.representations.map((r: Representation) => <Table.Tr key={r.representation_id}>
        <Table.Td>{r.label} ({r.kind})</Table.Td>
        <Table.Td><RevisionPin revisionNumber={r.revision_number} name={r.definition_name} /></Table.Td>
        <Table.Td><Text size="xs" className="sb-mono">{r.source_path}</Text><Text size="xs" className="sb-mono">SHA-256: {r.sha256}</Text>{r.model_metadata && <Text size="xs">{r.model_metadata.purpose} · {r.model_metadata.units ?? 'units unknown'} · {r.model_metadata.frame ?? 'frame unknown'} · builder {r.model_metadata.builder_version ?? 'not declared'}</Text>}</Table.Td>
        <Table.Td><Rights text={r.rights} status={r.rights_status} /></Table.Td>
      </Table.Tr>)}
      {catalog?.source_identifiers.map((i: SourceIdentifier) => <Table.Tr key={i.source_identifier_id}>
        <Table.Td>{i.label} (source identifier)</Table.Td>
        <Table.Td><RevisionPin revisionNumber={i.revision_number} name={i.definition_name} /></Table.Td>
        <Table.Td><Text size="xs" className="sb-mono">{i.scheme}: {i.identifier}</Text><Text size="xs" c="dimmed">Reference only; nothing fetched.</Text></Table.Td>
        <Table.Td><Rights text={i.rights} status={i.rights_status} /></Table.Td>
      </Table.Tr>)}
    </Table.Tbody></Table>
    {catalog && !catalog.representations.length && !catalog.source_identifiers.length && <SbUnknown what="Linked representations" />}
    <InspectionScope permission="item.create">
      <Title order={4}>Link a source file</Title>
      <TextInput label="Representation label" value={label} onChange={(e) => setLabel(e.currentTarget.value)} />
      <Select label="Representation kind" value={kind} onChange={setKind} data={KINDS} allowDeselect={false} />
      <Select label="Source bundle revision" placeholder="Choose a registered source" searchable value={bundleId} onChange={(v) => { setBundleId(v); setPath(null); }}
        data={newestFirst(sourceRevisions).map((r) => ({ value: r.revision_id, label: `${r.name} · revision ${r.number} (${r.role})` }))} />
      <Select label="Source file" placeholder="Choose an exact file" searchable value={path} onChange={setPath} disabled={!sourceFiles.length}
        data={sourceFiles.map((f) => ({ value: f.path, label: f.path }))} />
      {file && <Group gap="xs"><Text size="xs" className="sb-mono">SHA-256: {file.sha256}</Text><Text size="xs">File rights note: {file.rights}</Text></Group>}
      <Select label="Rights status" description="Required; choose Unknown explicitly if not established." placeholder="Choose a status" value={repStatus} onChange={setRepStatus} data={RIGHTS_OPTIONS} allowDeselect={false} />
      {(bundles.isError || detail.isError) && <Alert color="red">{((bundles.error ?? detail.error) as Error).message}</Alert>}
    </InspectionScope>
    <Button {...gate.props} disabled={!gate.allowed || !active || pending || !label.trim() || !bundleId || !file || !repStatus} loading={pending}
      onClick={() => register("representation", { label, kind, source_bundle_revision_id: bundleId, source_path: path, rights_status: repStatus })}>Register representation</Button>
    <InspectionScope permission="item.create">
      <Title order={4}>Add an external source identifier</Title>
      <TextInput label="Identifier scheme" description="Lowercase, e.g. library-id, url, standard" value={scheme} onChange={(e) => setScheme(e.currentTarget.value)} />
      <TextInput label="Source identifier" value={identifier} onChange={(e) => setIdentifier(e.currentTarget.value)} />
      <TextInput label="Source identifier label" value={idLabel} onChange={(e) => setIdLabel(e.currentTarget.value)} />
      <Select label="Source identifier rights status" description="Required; choose Unknown explicitly if not established." placeholder="Choose a status" value={idStatus} onChange={setIdStatus} data={RIGHTS_OPTIONS} allowDeselect={false} />
      <TextInput label="Rights note" value={rights} onChange={(e) => setRights(e.currentTarget.value)} />
    </InspectionScope>
    <Button {...gate.props} disabled={!gate.allowed || !active || pending || !scheme.trim() || !identifier.trim() || !idLabel.trim() || !rights.trim() || !idStatus} loading={pending}
      onClick={() => register("source_identifier", { scheme, identifier, label: idLabel, rights_status: idStatus, rights })}>Register source identifier</Button>
    <ReadOnlyNote permission="item.create">Linking representations is unavailable.</ReadOnlyNote>
  </Stack></Card>;
}
