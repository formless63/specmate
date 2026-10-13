import { Alert, Button, Card, Group, NativeSelect, Stack, Table, Text, Textarea, Title } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { randomUUID } from '../../lib/random-id';
import type { FirmwareRead, FirmwareSummary } from '../firmware/api';
import { read, type Definition, type Identity } from '../identity/api';
import { operation, type Adoption, type OccurrenceInspection, type Owner, type SelectionReview, type Submission } from './api';

export function FirmwareOccurrencesPanel({ projectId, permissions }: { projectId: string; permissions?: string[] }) {
  return <Workspace key={projectId} projectId={projectId} canEdit={permissions?.includes('design.edit') ?? true} />;
}

function Workspace({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const [opened, setOpened] = useState(false);
  return <Card withBorder><Stack>
    <Title order={3}>Firmware on repeated boards</Title>
    <Text>Choose firmware independently for each exact contextual board occurrence. Review its frozen sources, configuration and population before adopting the selection.</Text>
    <Button onClick={() => setOpened(!opened)}>{opened ? 'Hide occurrence firmware' : 'Show occurrence firmware'}</Button>
    {opened && <Selector projectId={projectId} canEdit={canEdit} />}
  </Stack></Card>;
}

function Selector({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const selectionGeneration = useRef(0);
  const [definitions, setDefinitions] = useState<Definition[]>([]);
  const [firmware, setFirmware] = useState<FirmwareSummary[]>([]);
  const [definition, setDefinition] = useState('');
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [owner, setOwner] = useState<Owner | null>(null);
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    let active = true;
    selectionGeneration.current++;
    setDefinitions([]); setFirmware([]); setError('');
    Promise.all([read<Definition[]>(`projects/${projectId}/definitions`), read<{ firmware: FirmwareSummary[] }>(`pcb/projects/${projectId}/firmware`)])
      .then(([items, records]) => { if (active) { setDefinitions(items.filter((item) => item.kind === 'assembly')); setFirmware(records.firmware); } })
      .catch((failure: Error) => { if (active) { setDefinitions([]); setFirmware([]); setError(failure.message); } });
    return () => { active = false; };
  }, [projectId]);
  useEffect(() => {
    let active = true;
    selectionGeneration.current++;
    setIdentity(null); setOwner(null);
    if (definition) read<Identity>(`catalog/definitions/${definition}?offset=${offset}`)
      .then((data) => { if (active) setIdentity(data); })
      .catch((failure: Error) => { if (active) { setIdentity(null); setError(failure.message); } });
    return () => { active = false; selectionGeneration.current++; };
  }, [definition, offset]);
  async function choose(value: string) {
    const token = ++selectionGeneration.current;
    setOwner(null); setError('');
    if (!value) return;
    if (value.startsWith('draft:')) { setOwner({ draft_id: value.slice(6) }); return; }
    try {
      const revision = await read<{ snapshot_id: string }>(`revisions/${value.slice(9)}`);
      if (token === selectionGeneration.current) setOwner({ snapshot_id: revision.snapshot_id });
    } catch (failure) { if (token === selectionGeneration.current) setError((failure as Error).message); }
  }
  return <Stack>
    {error && <Alert color="red">{error}</Alert>}
    <NativeSelect label="Owning assembly" value={definition} data={[{ value: '', label: 'Select an assembly' }, ...definitions.map((item) => ({ value: item.definition_id, label: item.name }))]} onChange={(event) => { setDefinition(event.currentTarget.value); setOffset(0); }} />
    {identity && <>
      <NativeSelect key={`${definition}:${offset}`} label="Assembly draft or frozen revision" defaultValue="" data={[{ value: '', label: 'Select exact assembly state' }, ...identity.drafts.map((item) => ({ value: `draft:${item.draft_id}`, label: `Draft ${item.draft_id} · ${item.state}` })), ...identity.revisions.map((item) => ({ value: `revision:${item.revision_id}`, label: `Frozen revision ${item.number}` }))]} onChange={(event) => { void choose(event.currentTarget.value); }} />
      <Group><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous assembly states</Button><Button disabled={Math.max(identity.drafts.length, identity.revisions.length) < 50} onClick={() => setOffset(offset + 50)}>Next assembly states</Button></Group>
    </>}
    {owner && <OccurrenceWorkspace key={JSON.stringify(owner)} owner={owner} firmware={firmware} canEdit={canEdit} />}
  </Stack>;
}

function OccurrenceWorkspace({ owner, firmware, canEdit }: { owner: Owner; firmware: FirmwareSummary[]; canEdit: boolean }) {
  const generation = useRef(0);
  const [inspection, setInspection] = useState<OccurrenceInspection | null>(null);
  const [path, setPath] = useState('');
  const [candidate, setCandidate] = useState('');
  const [preview, setPreview] = useState<SelectionReview | null>(null);
  const [basis, setBasis] = useState('');
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [adoption, setAdoption] = useState<Adoption | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  function clear() { generation.current++; setPreview(null); setAdoption(null); setSubmission(null); setError(''); setBusy(false); }
  async function refresh() {
    const token = ++generation.current;
    setInspection(null); setPreview(null); setAdoption(null); setError(''); setBusy(true);
    try { const result = await operation<OccurrenceInspection>('firmware_occurrence.inspect', owner); if (token === generation.current) setInspection(result); }
    catch (failure) { if (token === generation.current) setError((failure as Error).message); }
    finally { if (token === generation.current) setBusy(false); }
  }
  useEffect(() => {
    void refresh();
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus);
    return () => { generation.current++; window.removeEventListener('focus', focus); };
  }, []); // Owner changes remount the workspace; focus checks discard retained private evidence.
  async function review() {
    const token = ++generation.current;
    setPreview(null); setAdoption(null); setSubmission(null); setBusy(true); setError('');
    try {
      const result = await operation<SelectionReview>('firmware_occurrence.review', { draft_id: owner.draft_id, path: JSON.parse(path), firmware_revision_id: candidate || null });
      if (token === generation.current) setPreview(result);
    } catch (failure) { if (token === generation.current) { setInspection(null); setError((failure as Error).message); } }
    finally { if (token === generation.current) setBusy(false); }
  }
  async function adopt(retry = false) {
    if (!canEdit || (!preview && !submission)) return;
    const request = retry && submission ? submission : { payload: { draft_id: owner.draft_id!, path: preview!.path,
      firmware_revision_id: candidate || null, review_sha256: preview!.review_sha256, basis }, state: preview!.state, key: randomUUID() };
    const token = ++generation.current;
    setSubmission(request); setBusy(true); setError('');
    try {
      await operation('firmware_occurrence.adopt', request.payload, request);
      if (token !== generation.current) return;
      setSubmission(null); setBasis(''); await refresh();
    } catch (failure) { if (token === generation.current) { setInspection(null); setPreview(null); setAdoption(null); setError((failure as Error).message); } }
    finally { if (token === generation.current) setBusy(false); }
  }
  async function inspectEvidence(id: string) {
    const token = ++generation.current;
    setAdoption(null); setPreview(null); setBusy(true); setError('');
    try { const result = await operation<Adoption>('firmware_occurrence.read_adoption', { adoption_id: id }); if (token === generation.current) setAdoption(result); }
    catch (failure) { if (token === generation.current) { setInspection(null); setError((failure as Error).message); } }
    finally { if (token === generation.current) setBusy(false); }
  }
  return <Stack>
    <Text>Compilation: not performed · Flashing: not performed · Device operation: not observed</Text>
    <Button disabled={busy} onClick={() => { void refresh(); }}>Refresh occurrence firmware</Button>
    {error && <Alert color="red">{error}</Alert>}
    {inspection && <>
      <Table><Table.Thead><Table.Tr><Table.Th>Contextual path</Table.Th><Table.Th>Exact board revision</Table.Th><Table.Th>Firmware revision</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
        {inspection.occurrences.map((item) => <Table.Tr key={JSON.stringify(item.path)}><Table.Td>{item.path.join('/')} · {item.display_ref || item.name}</Table.Td><Table.Td>{item.revision_id}</Table.Td><Table.Td>{item.firmware_revision_id ?? 'Unassigned'}</Table.Td></Table.Tr>)}
      </Table.Tbody></Table>
      {owner.draft_id && <>
        <NativeSelect label="Exact board occurrence" value={path} data={[{ value: '', label: 'Select a board occurrence' }, ...inspection.occurrences.filter((item) => item.kind === 'pcb_population').map((item) => ({ value: JSON.stringify(item.path), label: `${item.path.join('/')} · ${item.display_ref || item.name}` }))]} onChange={(event) => { clear(); setPath(event.currentTarget.value); }} />
        <NativeSelect label="Frozen firmware for this occurrence" value={candidate} data={[{ value: '', label: 'Explicitly unassigned' }, ...firmware.flatMap((item) => item.revisions.map((revision) => ({ value: revision.revision_id, label: `${item.name} revision ${revision.number}` })))]} onChange={(event) => { clear(); setCandidate(event.currentTarget.value); }} />
        <Button disabled={!path || busy} onClick={() => { void review(); }}>Review occurrence firmware selection</Button>
        {inspection.adoptions.map((item) => <Button key={item.adoption_id} variant="subtle" disabled={busy} onClick={() => { void inspectEvidence(item.adoption_id); }}>Inspect adoption {item.path.join('/')} · {item.basis}</Button>)}
        {inspection.history_truncated && <Text>Only the latest 100 adoption records are listed.</Text>}
      </>}
    </>}
    {preview && <Card withBorder><Stack>
      <Text>{preview.message}</Text><Text>Occurrence {preview.path.join('/')} · Exact population {preview.occurrence_revision_id}</Text>
      {preview.previous && <Declaration label="Previously assigned" value={preview.previous} />}
      {preview.candidate && <Declaration label="Proposed firmware" value={preview.candidate} />}
      <Textarea label="Firmware adoption review basis" disabled={busy} value={basis} onChange={(event) => { setBasis(event.currentTarget.value); setSubmission(null); }} />
      <Button disabled={!canEdit || !preview.eligible || !basis.trim() || busy} onClick={() => { void adopt(); }}>Adopt reviewed firmware selection</Button>
      {!canEdit && <Text>This account may review selections; editing permission is required to adopt.</Text>}
    </Stack></Card>}
    {submission && canEdit && <Button disabled={busy} onClick={() => { void adopt(true); }}>Retry reviewed firmware adoption</Button>}
    {adoption && <Card withBorder><Stack><Text>Immutable adoption basis: {adoption.basis}</Text><Text>Context: {adoption.path.join('/')}</Text>
      {adoption.review.previous && <Declaration label="Historical previous firmware" value={adoption.review.previous} />}
      {adoption.review.candidate && <Declaration label="Historical adopted firmware" value={adoption.review.candidate} />}
    </Stack></Card>}
  </Stack>;
}

function Declaration({ label, value }: { label: string; value: FirmwareRead }) {
  const declaration = value.content.firmware;
  return <Stack gap="xs"><Title order={4}>{label}: {value.name}</Title>
    <Text>Frozen revision {value.revision_id} · SHA-256 {value.snapshot_sha256}</Text>
    <Text>Target population {declaration.target.population_revision_id} · Option {declaration.target.option_id} · Native component {declaration.target.component_id}</Text>
    <Text>Interpretation {value.evaluation.target.interpretation_id} · Board source {value.evaluation.target.board_source_revision_id}</Text>
    <Text>Declared toolchain {declaration.toolchain.name} · Version {declaration.toolchain.version ?? 'unknown'} · Support unverified</Text>
    {declaration.configuration.map((entry) => <Text key={entry.key}>{entry.key}={entry.status === 'secret_reference' ? '[secret reference]' : entry.status === 'unknown' ? '[unknown]' : entry.value}</Text>)}
    {declaration.sources.map((source) => <Stack key={source.local_id} gap="xs"><Text>Source revision {source.source_revision_id} · Manifest {source.source_manifest_sha256}</Text>
      {source.files.map((file) => <Text key={file.path}>{file.path} · {file.role} · {file.sha256} · {file.rights}</Text>)}
    </Stack>)}
    {declaration.pins.map((pin) => <Text key={pin.signal}>{pin.signal} · {pin.function} · Native pad {pin.pad_id ?? 'unknown'} · Peripheral {pin.peripheral ?? 'unknown'}</Text>)}
    {value.evaluation.findings.filter((finding) => finding.status !== 'valid').map((finding, index) => <Text key={index}>{finding.status}: {finding.message}</Text>)}
  </Stack>;
}
