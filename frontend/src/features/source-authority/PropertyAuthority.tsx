import { useCan } from "../../lib/permissions";
import { Alert, Badge, Button, Card, Group, Select, Stack, Table, Text, Textarea, Title } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { randomUUID } from '../../lib/random-id';
import { command, request, SourceError, type RevisionDetail } from '../sources/api';
import type { Authority, AuthoritySummary, Candidate, OutlineSummary, OutlineValue, Projection } from './api';
import { RevisionLabel } from "../../lib/IdentityLabel";

const statusText: Record<Authority['status'], string> = {
  unreconciled: 'No extraction of the owner has been reconciled yet. The outline is unknown here.',
  current: 'The projection reflects the owner’s current source revision.',
  stale: 'The owning source changed after the last reconciliation. The shown projection belongs to an earlier revision.',
  conflicting: 'Accepted extractions of the owner’s current source disagree. Nothing is chosen.',
};

function SummaryText({ summary }: { summary: OutlineSummary | null }) {
  if (!summary) return <Text size="sm">None</Text>;
  if (summary.status === 'unknown') return <Text size="sm">Unknown: {summary.reason.join('; ')}</Text>;
  const [x0, y0, x1, y1] = summary.bbox_mm;
  return <Text size="sm">{summary.outline_polygons} outline polygon(s), {summary.cutouts} cutout(s), {summary.vertices} vertices · bounds {x0}, {y0} to {x1}, {y1} mm · net area {summary.net_area_mm2} mm²{summary.geometry === 'exact-arcs' ? ` · exact geometry: ${summary.arcs} arc(s), ${summary.circles} circle(s)${summary.beziers ? `, ${summary.beziers} Bezier` : ''}; display tolerance ${summary.tolerance_mm} mm${summary.area_basis === 'approximate-within-tolerance' ? ' (area approximate within tolerance)' : ''}${summary.bridged_gaps ? ` · ${summary.bridged_gaps} outline gap(s) bridged (max ${summary.max_bridged_gap_mm} mm)` : ''}` : ''}</Text>;
}

export function OutlinePreview({ value, label }: { value: OutlineValue; label: string }) {
  if (!value.outline?.length) return null;
  const points = value.outline.flat();
  const xs = points.map(p => p[0]); const ys = points.map(p => p[1]);
  const [minX, minY] = [Math.min(...xs), Math.min(...ys)];
  const width = Math.max(Math.max(...xs) - minX, 1e-6); const height = Math.max(Math.max(...ys) - minY, 1e-6);
  const pad = Math.max(width, height) * 0.05;
  const path = (polygon: [number, number][]) => polygon.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ') + ' Z';
  // KiCad native frame: x right, y down, which matches SVG.
  return <svg role="img" aria-label={label} viewBox={`${minX - pad} ${minY - pad} ${width + 2 * pad} ${height + 2 * pad}`} style={{ maxWidth: 320, maxHeight: 200, border: '1px solid var(--mantine-color-default-border)' }}>
    <path d={[...value.outline.map(path), ...(value.cutouts ?? []).map(path)].join(' ')} fillRule="evenodd" fill="var(--mantine-color-green-light)" stroke="currentColor" strokeWidth={Math.max(width, height) / 200} />
  </svg>;
}

function ProjectionCard({ projection, title }: { projection: Projection; title: string }) {
  return <Card withBorder><Stack gap={4}>
    <Text fw={600}>{title} · projection version {projection.version} · {projection.status}</Text>
    <SummaryText summary={projection.summary} />
    <OutlinePreview value={projection.value} label={`${title} outline`} />
    <Text size="xs"><RevisionLabel kind="source" id={projection.source_revision_id} role="Source" /> (revision {projection.source_number}) · {projection.source_path}</Text>
    <Text size="xs" style={{ overflowWrap: 'anywhere' }}>Source SHA-256 {projection.source_sha256} · report SHA-256 {projection.report_sha256}</Text>
    <Text size="xs">Interpretation {projection.interpretation_id} · build {projection.build_id} · {projection.adapter} · KiCad {projection.tool_version} format {projection.native_format_version}</Text>
    {projection.changes.kind !== 'initial' && <Text size="xs">Change: {projection.changes.kind}{projection.changes.vertices ? ` · ${projection.changes.vertices.added} vertices added, ${projection.changes.vertices.removed} removed` : ''}</Text>}
    <Text size="xs">Basis: {projection.basis} · by {projection.reconciled_by}</Text>
  </Stack></Card>;
}

export function PropertyAuthorityPanel({ workspaceId, detail, onOpenRevision, onAuthorityFailure }: {
  workspaceId: string; detail: RevisionDetail | null;
  onOpenRevision: (revisionId: string) => void; onAuthorityFailure: (reason: unknown) => void;
}) {
  const canWrite = useCan('source.register');
  const [list, setList] = useState<AuthoritySummary[]>([]);
  const [selected, setSelected] = useState<Authority | null>(null);
  const [boardPath, setBoardPath] = useState<string | null>(null);
  const [basis, setBasis] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);
  const generation = useRef(0);
  const context = `${workspaceId}:${detail?.revision_id ?? ''}`;
  const lifetime = useRef({ active: false, epoch: 0, context });
  if (lifetime.current.context !== context) {
    lifetime.current.context = context;
    lifetime.current.epoch += 1;
    generation.current += 1;
  }
  const current = (epoch: number) => lifetime.current.active && lifetime.current.epoch === epoch;
  const boards = detail?.manifest.files.map(f => f.path).filter(p => p.toLowerCase().endsWith('.kicad_pcb')) ?? [];

  function failed(reason: unknown, epoch: number) {
    if (!current(epoch)) return;
    if (reason instanceof SourceError && [401, 403, 404].includes(reason.status)) {
      lifetime.current.epoch += 1; generation.current += 1; setBusy(false); setList([]); setSelected(null); setShown(false); onAuthorityFailure(reason); return;
    }
    setMessage(reason instanceof Error ? reason.message : 'Property authority request failed.');
  }
  async function refresh() {
    const token = ++generation.current;
    const epoch = lifetime.current.epoch;
    try {
      const result = await request<{ authorities: AuthoritySummary[] }>(`pcb/workspaces/${workspaceId}/property-authorities`);
      if (!current(epoch) || token !== generation.current) return false;
      setList(Array.isArray(result.authorities) ? result.authorities : []);
      return true;
    } catch (reason) { failed(reason, epoch); return false; }
  }
  async function open(id: string) {
    const token = ++generation.current;
    const epoch = lifetime.current.epoch;
    setSelected(null);
    try {
      const result = await request<Authority>(`pcb/property-authorities/${id}`);
      if (current(epoch) && token === generation.current) setSelected(result);
    } catch (reason) { failed(reason, epoch); }
  }
  useEffect(() => {
    lifetime.current.active = true;
    return () => { lifetime.current.active = false; lifetime.current.epoch += 1; generation.current += 1; };
  }, []);
  useEffect(() => { setSelected(null); setBasis(''); setBusy(false); setMessage(''); }, [context]);
  useEffect(() => { setBoardPath(boards.length === 1 ? boards[0]! : null); }, [detail?.revision_id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(operation: string, payload: object, expectedState?: string) {
    const epoch = lifetime.current.epoch;
    setBusy(true); setMessage('');
    try {
      const result = await command<{ authority_id: string }>(operation, payload, { expectedState, idempotencyKey: randomUUID() });
      if (!current(epoch)) return;
      setBasis('');
      if (await refresh() && current(epoch)) await open(result.authority_id);
    } catch (reason) {
      if (!current(epoch)) return;
      failed(reason, epoch);
      // A conflict leaves the typed basis; reread the current state so the next action is deliberate.
      if (reason instanceof SourceError && reason.status === 409 && selected) await open(selected.authority_id);
    } finally { if (current(epoch)) setBusy(false); }
  }
  const declare = () => detail && boardPath && act('source_property.declare', { owner_revision_id: detail.revision_id, path: boardPath, property: 'pcb.board_outline', basis: basis.trim() });
  const reconcile = (item: Candidate) => selected && act('source_property.reconcile', { authority_id: selected.authority_id, interpretation_id: item.interpretation_id, basis: basis.trim() }, selected.state);
  const transfer = () => selected && detail && act('source_property.transfer', { authority_id: selected.authority_id, new_owner_revision_id: detail.revision_id, basis: basis.trim() }, selected.state);
  const reconcilable = selected && canWrite && selected.status !== 'current' && selected.status !== 'conflicting';

  return <Card withBorder><Stack>
    <Title order={3}>Native property authority</Title>
    <Text size="sm">A board outline has one designated native owner. Specmate keeps no editable outline table: edit the owning source, extract it, then reconcile the accepted extraction here. Reconciliation is not native validation or physical qualification.</Text>
    {message && <Alert color="red">{message}</Alert>}
    <Button variant="subtle" disabled={busy} onClick={() => { setShown(true); setSelected(null); setMessage(''); void refresh(); }}>{shown ? 'Refresh property authorities' : 'Show property authorities'}</Button>
    {shown && <>
    {list.map(item => <Group key={item.authority_id} justify="space-between"><Text size="sm">Board outline · {item.owner_bundle_name} · {item.owner_path} · {item.state} · {item.projection_current ? 'current' : 'needs reconciliation'}</Text>
      <Button size="xs" disabled={busy} onClick={() => void open(item.authority_id)}>Review {item.owner_path} outline authority</Button></Group>)}
    {canWrite && detail && boards.length > 0 && <Stack gap="xs">
      <Text fw={600}>Designate an owner from {detail.name} revision {detail.number}</Text>
      <Select label="Owning board file" data={boards} value={boardPath} onChange={setBoardPath} disabled={busy} />
    </Stack>}
    {canWrite && <Textarea label="Basis" description="Recorded with a declaration, reconciliation or transfer." value={basis} maxLength={2000} disabled={busy} onChange={event => setBasis(event.currentTarget.value)} />}
    {canWrite && detail && boards.length > 0 && <Button disabled={busy || !boardPath || !basis.trim()} onClick={() => void declare()}>Designate board outline owner</Button>}
    {selected && <Stack>
      <Group><Title order={4}>Board outline authority</Title><Badge color={selected.status === 'current' ? 'green' : selected.status === 'conflicting' ? 'red' : 'yellow'}>{selected.status}</Badge><Text size="xs">{selected.state}</Text></Group>
      <Text size="sm">{statusText[selected.status]}</Text>
      <Text size="sm">{selected.editable_copy}</Text>
      <Card withBorder><Stack gap={4}>
        <Text fw={600}>Owner: {selected.owner.name} ({selected.owner.role}) · {selected.owner.path}</Text>
        <Text size="xs"><RevisionLabel kind="source" id={selected.owner.head_revision_id} role="Current" /> (revision {selected.owner.head_number}) · extractor {selected.extractor}</Text>
        <Text size="xs" style={{ overflowWrap: 'anywhere' }}>File SHA-256 {selected.owner.head_file_sha256 ?? 'missing'} · declared rights {selected.owner.head_file_rights ?? 'unknown'}</Text>
        {selected.owner.editable
          ? <Group><Button size="xs" variant="light" onClick={() => onOpenRevision(selected.owner.head_revision_id)}>Edit outline through owning source</Button><a href={selected.owner.handoff_url}>Download owner editing handoff</a></Group>
          : <Text size="xs">The owning original is preserved read-only. Derive a working copy of its current revision and transfer ownership to edit it.</Text>}
      </Stack></Card>
      {selected.projection ? <ProjectionCard projection={selected.projection} title="Reconciled projection" /> : <Text size="sm">No reconciled projection: the outline is unknown.</Text>}
      {selected.status === 'conflicting' && <Alert color="red">Accepted extractions of revision {selected.owner.head_number} disagree. They are preserved below; resolve the extraction evidence instead of choosing one.</Alert>}
      <Text fw={600}>Accepted extractions of the owner&apos;s current revision</Text>
      {selected.head_candidates.length === 0 && <Text size="sm">None yet. Extract revision {selected.owner.head_number} in the PCB panel and accept the successful report, then reconcile it here.</Text>}
      {selected.head_candidates.map(item => <Card withBorder key={item.interpretation_id}><Stack gap={4}>
        <Text size="sm">Interpretation {item.interpretation_id} · {item.status} · value {item.value_sha256.slice(0, 16)}</Text>
        <SummaryText summary={item.summary} />
        <Text size="xs" style={{ overflowWrap: 'anywhere' }}>Source SHA-256 {item.source_sha256} · report {item.report_sha256} · build {item.build_id}</Text>
        {reconcilable && <Button size="xs" disabled={busy || !basis.trim()} onClick={() => void reconcile(item)}>Reconcile projection to interpretation {item.interpretation_id}</Button>}
      </Stack></Card>)}
      {selected.non_owner_evidence.items.length > 0 && <Stack gap={4}><Text fw={600}>Preserved non-owner evidence</Text>
        <Text size="xs">Extractions of other bundles in this lineage are kept for review and never become the outline.{selected.non_owner_evidence.truncated ? ' Only the first 50 are shown.' : ''}</Text>
        <Table><Table.Tbody>{selected.non_owner_evidence.items.map(item => <Table.Tr key={item.interpretation_id}><Table.Td>{item.bundle_name}</Table.Td><Table.Td><RevisionLabel kind="source" id={item.source_revision_id} /></Table.Td><Table.Td><SummaryText summary={item.summary} /></Table.Td><Table.Td>{item.differs_from_projection === null ? 'No projection to compare' : item.differs_from_projection ? 'Differs from projection' : 'Matches projection'}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
      </Stack>}
      {canWrite && detail && detail.revision_id !== selected.owner.head_revision_id && <Button variant="light" disabled={busy || !basis.trim()} onClick={() => void transfer()}>Transfer ownership to {detail.name} revision {detail.number}</Button>}
      {selected.history.length > 1 && <Stack gap="xs"><Text fw={600}>Earlier projections (immutable)</Text>{selected.history.slice(1).map(item => <ProjectionCard key={item.projection_id} projection={item} title="Earlier projection" />)}</Stack>}
      <Stack gap={2}><Text fw={600}>Owner history</Text>{selected.owner_changes.map(change => <Text size="xs" key={change.version}>v{change.version}: {change.owner_path} <RevisionLabel kind="source" id={change.owner_revision_id} role="in" /> · {change.basis} · {change.changed_by}</Text>)}</Stack>
    </Stack>}
    </>}
  </Stack></Card>;
}
