import { Alert, Button, Card, Group, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { command, preserve, request, SourceError, type RevisionDetail, type SourcePage } from './api';
import { EditHandoff, EditProvenanceCard } from './EditHandoff';
import { PropertyAuthorityPanel } from '../source-authority/PropertyAuthority';
import { RevisionLabel } from "../../lib/IdentityLabel";

export function SourcesPanel(props: { projectId: string; permissions?: string[] }) {
  return <SourceWorkspace key={props.projectId} {...props} />;
}
function SourceWorkspace({ projectId, permissions }: { projectId: string; permissions?: string[] }) {
  const canWrite = !permissions || permissions.includes('source.register');
  const [page, setPage] = useState<SourcePage>({ revisions: [], next_after: null });
  const [detail, setDetail] = useState<RevisionDetail | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [rights, setRights] = useState('unknown');
  const [path, setPath] = useState<string | null>(null);
  const [derivedName, setDerivedName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const generation = useRef(0);
  const alive = useRef(true);
  function authorityFailure(reason: unknown) {
    return reason instanceof SourceError && [401, 403, 404].includes(reason.status);
  }
  function failed(reason: unknown) {
    if (!alive.current) return;
    setError(reason instanceof Error ? reason.message : 'Source request failed.');
    if (authorityFailure(reason)) {
      generation.current += 1; setPage({ revisions: [], next_after: null }); setDetail(null); setPath(null); setDenied(true);
    }
  }
  async function refresh(after?: string) {
    const token = ++generation.current;
    try {
      const result = await request<SourcePage>(`sources/projects/${projectId}/revisions${after ? `?after=${after}` : ''}`);
      if (!alive.current || token !== generation.current) return false;
      setPage(previous => after ? { ...result, revisions: [...previous.revisions, ...result.revisions] } : result);
      setDenied(false);
      return true;
    } catch (reason) {
      if (authorityFailure(reason) || token === generation.current) failed(reason);
      return false;
    }
  }
  async function inspect(id: string) {
    const token = ++generation.current;
    setDetail(null); setPath(null); setError('');
    try {
      const result = await request<RevisionDetail>(`sources/revisions/${id}`);
      if (!alive.current || token !== generation.current) return;
      setDetail(result); setDerivedName(`${result.name} expanded`);
      if (result.manifest.files.length === 1) setPath(result.manifest.files[0]!.path);
    } catch (reason) { if (authorityFailure(reason) || token === generation.current) failed(reason); }
  }
  useEffect(() => {
    alive.current = true; void refresh();
    return () => { alive.current = false; generation.current += 1; };
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  async function save() {
    if (!file) return;
    setBusy(true); setError('');
    try {
      const result = await preserve(projectId, file, name.trim(), rights.trim());
      if (!alive.current) return;
      if (await refresh()) await inspect(result.revision_id);
    } catch (reason) { failed(reason); } finally { if (alive.current) setBusy(false); }
  }
  async function expand() {
    if (!detail || !path) return;
    setBusy(true); setError('');
    try {
      const result = await command<{ revision_id: string }>('source.expand_zip', {
        source_revision_id: detail.revision_id, path, name: derivedName.trim(), format: 'zip',
      });
      if (!alive.current) return;
      if (await refresh()) await inspect(result.revision_id);
    } catch (reason) { failed(reason); } finally { if (alive.current) setBusy(false); }
  }
  return <Stack><Title order={2}>Sources</Title>
    <Text>Preserve exact source bytes and declared rights. Files remain inert; importing or expanding does not run a tool or approve the design.</Text>
    {error && <Alert color="red">{error}</Alert>}
    <Button variant="subtle" disabled={busy} onClick={() => { setDetail(null); setPath(null); setError(''); void refresh(); }}>Refresh sources</Button>
    {canWrite && !denied && <Card withBorder><Stack>
      <Title order={3}>Preserve an original</Title>
      <Text size="sm">Choose one file, up to 16 MiB in this panel. Unsupported formats are preserved without interpretation.</Text>
      <label>Original source file<input aria-label="Original source file" type="file" disabled={busy} onChange={event => { const selected = event.currentTarget.files?.[0] ?? null; setFile(selected); if (selected) setName(selected.name); }} /></label>
      <TextInput label="Source name" value={name} disabled={busy} onChange={event => setName(event.currentTarget.value)} />
      <TextInput label="Declared rights" description="Use unknown when rights have not been established. A declaration is not license verification." value={rights} disabled={busy} onChange={event => setRights(event.currentTarget.value)} />
      {file && file.size > 16 * 1024 * 1024 && <Text c="red">This file exceeds the panel's 16 MiB limit.</Text>}
      <Button disabled={!file || file.size > 16 * 1024 * 1024 || !name.trim() || !rights.trim()} loading={busy} onClick={() => void save()}>Preserve source</Button>
    </Stack></Card>}
    <Stack gap="xs">{page.revisions.map(revision => <Card withBorder key={revision.revision_id}><Group justify="space-between"><div><Text><RevisionLabel id={revision.revision_id} known={{ name: revision.name, kind: revision.role, number: revision.number }} /></Text></div><Button disabled={busy} onClick={() => void inspect(revision.revision_id)}>Inspect {revision.name} revision {revision.number}</Button></Group></Card>)}</Stack>
    {page.next_after && <Button disabled={busy} onClick={() => void refresh(page.next_after!)}>More sources</Button>}
    {detail && <Card withBorder><Stack><Title order={3}>Exact source revision</Title>
      <Text><RevisionLabel id={detail.revision_id} known={{ name: detail.name, kind: detail.role, number: detail.number }} /></Text><Text size="sm">Manifest SHA-256: {detail.manifest_sha256}</Text>
      <Button variant="subtle" disabled={busy} onClick={() => void inspect(detail.revision_id)}>Refresh exact source</Button>
      {detail.expansion && <Card withBorder><Text fw={600}>ZIP expansion provenance</Text><Text><RevisionLabel kind="source" id={detail.expansion.source_revision_id} role="Archive" /></Text><Text>Archive path: {detail.expansion.path}</Text><Text size="sm">Archive SHA-256: {detail.expansion.sha256}</Text><Text>Inherited declared rights: {detail.expansion.rights}</Text><Text size="sm">Parser: {detail.expansion.parser} · Execution: none</Text></Card>}
      <EditProvenanceCard detail={detail} />
      {detail.manifest.ancestry.map(id => <Text key={id}>Parent revision: {id}</Text>)}
      <Table.ScrollContainer minWidth={700}><Table><Table.Thead><Table.Tr><Table.Th>Path</Table.Th><Table.Th>Bytes</Table.Th><Table.Th>SHA-256</Table.Th><Table.Th>Declared rights</Table.Th><Table.Th>Original bytes</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{detail.manifest.files.map(entry => <Table.Tr key={entry.path}><Table.Td>{entry.path}</Table.Td><Table.Td>{entry.bytes}</Table.Td><Table.Td style={{ overflowWrap: 'anywhere' }}>{entry.sha256}</Table.Td><Table.Td>{entry.rights}</Table.Td><Table.Td><a href={`/api/v0/sources/revisions/${detail.revision_id}/file?${new URLSearchParams({ path: entry.path })}`}>Download {entry.path}</a></Table.Td></Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer>
      {canWrite && detail.role === 'original' && <Stack><Title order={4}>Expand a ZIP as a separate derivative</Title><Text size="sm">Classic stored or deflated ZIP only: up to 1000 entries, 16 MiB per file, 64 MiB expanded total and 200× expansion. Encrypted, linked, ZIP64, streamed data-descriptor and unsupported metadata archives are rejected. Nested archives stay inert. Empty directories are validated but omitted. The original remains preserved if expansion fails.</Text>
        <Select label="Preserved ZIP file" data={detail.manifest.files.map(entry => entry.path)} value={path} onChange={setPath} disabled={busy} />
        <TextInput label="Expanded bundle name" value={derivedName} disabled={busy} onChange={event => setDerivedName(event.currentTarget.value)} />
        <Button disabled={!path || !derivedName.trim()} loading={busy} onClick={() => void expand()}>Expand ZIP into derivative</Button>
      </Stack>}
      <EditHandoff key={detail.revision_id} projectId={projectId} detail={detail} canWrite={canWrite} busy={busy} setBusy={value => { if (alive.current) setBusy(value); }}
        onAuthorityFailure={failed} onSubmitted={async id => { if (alive.current && await refresh()) await inspect(id); }} />
    </Stack></Card>}
    {!denied && <PropertyAuthorityPanel projectId={projectId} canWrite={canWrite} detail={detail} onOpenRevision={id => void inspect(id)} onAuthorityFailure={failed} />}
  </Stack>;
}
