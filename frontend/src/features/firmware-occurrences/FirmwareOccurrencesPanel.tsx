import { SbIdentityBadge, SbUnknown } from "../../components/sb";
import { Alert, Button, Card, Group, NativeSelect, Stack, Table, Text, Textarea, Title } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { randomUUID } from '../../lib/random-id';
import { FirmwareBuildPanel } from '../firmware-builds/FirmwareBuildPanel';
import type { FirmwareRead } from '../firmware/api';
import { operation, type Adoption, type OccurrenceInspection, type Owner, type SelectionReview, type Submission } from './api';
import { RevisionLabel } from "../../lib/IdentityLabel";
import { ReadOnlyNote, useCan } from "../../lib/permissions";

import { RevisionPicker } from '../cables/RevisionPicker';
import { DefinitionPickerScope } from '../../components/library/DefinitionSelect';
export function FirmwareOccurrencesPanel({ owner, active = true, principalKey = 'standalone' }: { owner: Owner | null; active?: boolean; principalKey?: string }) {
  return owner ? <DefinitionPickerScope.Provider value={{ key: `${principalKey}:occurrence-firmware`, active }}><OccurrenceWorkspace key={`${principalKey}:${JSON.stringify(owner)}`} owner={owner} active={active} /></DefinitionPickerScope.Provider> : <Text>Select a saved Device draft or frozen revision to review its firmware assignments.</Text>;
}

function OccurrenceWorkspace({ owner, active }: { owner: Owner; active: boolean }) {
  const canEdit = useCan('design.edit') && active;
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
    if (!active) { setInspection(null); return; }
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
  }, [active]); // Exact owner changes remount the workspace; activation/focus recheck current closure.
  async function review() {
    const token = ++generation.current;
    setPreview(null); setAdoption(null); setSubmission(null); setBusy(true); setError('');
    try {
      if (!active) return;
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
  return <div hidden={!active} inert={!active || undefined}><Stack>
    <Text>{owner.snapshot_id ? 'Compilation: inspect an exact frozen occurrence for retained evidence' : 'Compilation: not performed for this draft'} · Flashing: not performed · Device operation: not observed</Text>
    <Button disabled={busy} onClick={() => { void refresh(); }}>Refresh occurrence firmware</Button>
    {error && <Alert color="red">{error}</Alert>}
    {inspection && <>
      <Table><Table.Thead><Table.Tr><Table.Th>Contextual path</Table.Th><Table.Th>Exact board revision</Table.Th><Table.Th>Firmware revision</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
        {inspection.occurrences.map((item) => <Table.Tr key={JSON.stringify(item.path)}><Table.Td><SbIdentityBadge kind="occurrence" /> {item.path.join('/')} · {item.display_ref || item.name}</Table.Td><Table.Td><RevisionLabel id={item.revision_id} /></Table.Td><Table.Td>{item.firmware_revision_id ? <RevisionLabel id={item.firmware_revision_id} role="Firmware" /> : 'Unassigned'}</Table.Td></Table.Tr>)}
      </Table.Tbody></Table>
      {owner.snapshot_id && <>
        <NativeSelect label="Frozen board occurrence for compilation" value={path} data={[{ value: '', label: 'Select an exact frozen board occurrence' }, ...inspection.occurrences.filter((item) => item.kind === 'pcb_population').map((item) => ({ value: JSON.stringify(item.path), label: `${item.path.join('/')} · ${item.display_ref || item.name}` }))]} onChange={(event) => { clear(); setPath(event.currentTarget.value); }} />
        {inspection.occurrences.filter((item) => item.kind === 'pcb_population' && JSON.stringify(item.path) === path).map((item) => item.firmware_revision_id
          ? <FirmwareBuildPanel active={active} key={path} firmware_revision_id={item.firmware_revision_id} assembly_snapshot_id={owner.snapshot_id} path={item.path} />
          : <Text key={path}>This exact frozen occurrence has no assigned firmware to compile.</Text>)}
      </>}
      {owner.draft_id && <>
        <NativeSelect label="Exact board occurrence" value={path} data={[{ value: '', label: 'Select a board occurrence' }, ...inspection.occurrences.filter((item) => item.kind === 'pcb_population').map((item) => ({ value: JSON.stringify(item.path), label: `${item.path.join('/')} · ${item.display_ref || item.name}` }))]} onChange={(event) => { clear(); setPath(event.currentTarget.value); }} />
        <RevisionPicker label="Frozen firmware for this occurrence" kind="firmware" value={candidate} onChange={value => { clear(); setCandidate(value); }} />
        <Button variant="quiet" disabled={!active || !candidate} onClick={() => { clear(); setCandidate(''); }}>Leave occurrence explicitly unassigned</Button>
        <Button disabled={!path || busy} onClick={() => { void review(); }}>Review occurrence firmware selection</Button>
        {inspection.adoptions.map((item) => <Button key={item.adoption_id} variant="subtle" disabled={busy} onClick={() => { void inspectEvidence(item.adoption_id); }}>Inspect adoption {item.path.join('/')} · {item.basis}</Button>)}
        {inspection.history_truncated && <Text>Only the latest 100 adoption records are listed.</Text>}
      </>}
    </>}
    {preview && <Card withBorder><Stack>
      <Text>{preview.message}</Text><Text>Occurrence {preview.path.join('/')} · <RevisionLabel id={preview.occurrence_revision_id} role="population" /></Text>
      {preview.previous && <Declaration label="Previously assigned" value={preview.previous} />}
      {preview.candidate && <Declaration label="Proposed firmware" value={preview.candidate} />}
      <Textarea label="Firmware adoption review basis" disabled={busy} value={basis} onChange={(event) => { setBasis(event.currentTarget.value); setSubmission(null); }} />
      <Button disabled={!canEdit || !preview.eligible || !basis.trim() || busy} onClick={() => { void adopt(); }}>Adopt reviewed firmware selection</Button>
      <ReadOnlyNote permission="design.edit">This account may review selections; adopting needs editing permission.</ReadOnlyNote>
    </Stack></Card>}
    {submission && canEdit && <Button disabled={busy} onClick={() => { void adopt(true); }}>Retry reviewed firmware adoption</Button>}
    {adoption && <Card withBorder><Stack><Text>Immutable adoption basis: {adoption.basis}</Text><Text>Context: {adoption.path.join('/')}</Text>
      {adoption.review.previous && <Declaration label="Historical previous firmware" value={adoption.review.previous} />}
      {adoption.review.candidate && <Declaration label="Historical adopted firmware" value={adoption.review.candidate} />}
    </Stack></Card>}
  </Stack></div>;
}

function Declaration({ label, value }: { label: string; value: FirmwareRead }) {
  const declaration = value.content.firmware;
  return <Stack gap="xs"><Group gap="xs"><SbIdentityBadge kind="frozen" /><Title order={4}>{label}: {value.name}</Title></Group>
    <Text><RevisionLabel id={value.revision_id} sha256={value.snapshot_sha256} /></Text>
    <Text><RevisionLabel id={declaration.target.population_revision_id} role="Target population" /> · Option {declaration.target.option_id} · Native component {declaration.target.component_id}</Text>
    <Text>Interpretation {value.evaluation.target.interpretation_id} · <RevisionLabel kind="source" id={value.evaluation.target.board_source_revision_id} role="Board source" /></Text>
    <Text>Declared toolchain {declaration.toolchain.name} · Version {declaration.toolchain.version ?? <SbUnknown />} · Support unverified</Text>
    {declaration.configuration.map((entry) => <Text key={entry.key}>{entry.key}={entry.status === 'secret_reference' ? '[secret reference]' : entry.status === 'unknown' ? '[unknown]' : entry.value}</Text>)}
    {declaration.sources.map((source) => <Stack key={source.local_id} gap="xs"><Text><RevisionLabel kind="source" id={source.source_revision_id} role="Source" /> · Manifest {source.source_manifest_sha256}</Text>
      {source.files.map((file) => <Text key={file.path}>{file.path} · {file.role} · {file.sha256} · {file.rights}</Text>)}
    </Stack>)}
    {declaration.pins.map((pin) => <Text key={pin.signal}>{pin.signal} · {pin.function} · Native pad {pin.pad_id ?? <SbUnknown />} · Peripheral {pin.peripheral ?? <SbUnknown />}</Text>)}
    {value.evaluation.findings.filter((finding) => finding.status !== 'valid').map((finding, index) => <Text key={index}>{finding.status}: {finding.message}</Text>)}
  </Stack>;
}
