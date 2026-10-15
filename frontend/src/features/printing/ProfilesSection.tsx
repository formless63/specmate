import { RecordNavigation } from "../make/RecordNavigation";
import { Alert, Button, Group, NumberInput, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import { InspectionScope, ReadOnlyNote, usePermission } from '../../lib/permissions';
import { SbStatus, SbUnknown } from '../../components/sb';
import {
  freezeRecord, listOrcaPresets, listProfileRevisions, listProfiles, readProfile, saveProfile,
  type OrcaPresetSet,
  type Basis, type ParameterRow, type ParameterSpec, type ParameterValue, type PrintProfile,
  type ProfileRecord, type RevisionRow, type Role, type Technology,
} from './api';
import { SourceLine, valueText } from './ParameterTable';

const message = (e: unknown) => e instanceof Error ? e.message : String(e);

/** Printer, process and material profiles: versioned workspace items with per-parameter provenance. */
export function ProfilesSection({ projectId, specs, onChanged }: { projectId: string | null; specs: ParameterSpec[]; onChanged: () => void }) {
  const create = usePermission('item.create');
  const freezeGate = usePermission('design.freeze');
  const [records, setRecords] = useState<ProfileRecord[]>([]);
  const [current, setCurrent] = useState<ProfileRecord | null>(null);
  const [profile, setProfile] = useState<PrintProfile | null>(null);
  const [rows, setRows] = useState<ParameterRow[]>([]);
  const [revisions, setRevisions] = useState<RevisionRow[]>([]);
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('material');
  const [technology, setTechnology] = useState<Technology>('fdm');
  const [basis, setBasis] = useState<Basis>('preference');
  const [note, setNote] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [presetSets, setPresetSets] = useState<OrcaPresetSet[]>([]);

  useEffect(() => {
    let alive = true;
    listOrcaPresets().then(found => { if (alive) setPresetSets(found ?? []); }).catch(() => { if (alive) setPresetSets([]); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    listProfiles(projectId).then(found => { if (alive) setRecords(found); }).catch(e => { if (alive) setError(message(e)); });
    return () => { alive = false; };
  }, [projectId]);

  const shown = profile ?? null;
  const roleSpecs = useMemo(() => shown ? specs.filter(s => s.technology === shown.technology && s.role === shown.role) : [], [shown, specs]);
  const recorded = useMemo(() => new Map(rows.map(row => [row.key, row])), [rows]);

  const open = async (record: ProfileRecord) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const [read, history] = await Promise.all([readProfile({ draft_id: record.draft_id! }), listProfileRevisions(record.definition_id)]);
      setCurrent(read); setProfile(read.content.print_profile ?? null); setRows(read.parameters);
      setRevisions(history); setName(read.name); setDirty(false);
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const [quickKey, setQuickKey] = useState<string | null>(null);
  const [quickBusy, setQuickBusy] = useState(false);
  /** Printer, process and material profiles for one vendor preset set, each frozen so a preparation can pin it. */
  const quickSetup = async () => {
    const set = presetSets.find(item => item.key === quickKey);
    if (!set) return;
    setQuickBusy(true); setError(''); setNotice('');
    try {
      for (const r of ['printer', 'process', 'material'] as Role[]) {
        const saved = await saveProfile(`${set.label} ${r}`, { schema_version: '1', role: r, technology: 'fdm', parameters: {}, vendor_preset: set[r], limitations: [] }, null);
        await freezeRecord('print_profile.freeze', { draft_id: saved.draft_id!, state: saved.state! });
      }
      setRecords(await listProfiles(projectId));
      setNotice(`Created and froze printer, process and material profiles. Declare further parameters by editing a profile. Preset set: ${set.label}`); onChanged();
    } catch (e) { setError(message(e)); setRecords(await listProfiles(projectId).catch(() => records)); onChanged(); } finally { setQuickBusy(false); }
  };
  const start = () => {
    setCurrent(null); setRows([]); setRevisions([]); setDirty(true); setNotice('');
    setProfile({ schema_version: '1', role, technology, parameters: {}, limitations: [] });
  };
  const change = (key: string, value: ParameterValue | null) => {
    if (!profile) return;
    const parameters = { ...profile.parameters };
    if (value === null) delete parameters[key];
    else parameters[key] = { value, basis, source: basis === 'documented' && note.trim() ? { kind: 'citation', citation: note.trim() } : null, note: note.trim() || null };
    setProfile({ ...profile, parameters }); setDirty(true); setNotice('');
  };
  const save = async () => {
    if (!profile || !name.trim()) return;
    setBusy(true); setError('');
    try {
      const saved = await saveProfile(name.trim(), profile, current?.draft_id && current.state ? { draft_id: current.draft_id, state: current.state } : null);
      setRecords(items => [...items.filter(item => item.draft_id !== saved.draft_id), saved]);
      await open(saved); setNotice(`Saved ${saved.name}.`); onChanged();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const freeze = async () => {
    if (!current?.draft_id || !current.state || dirty) return;
    setBusy(true); setError('');
    try {
      const frozen = await freezeRecord('print_profile.freeze', { draft_id: current.draft_id, state: current.state });
      await open(current); setNotice(`Frozen profile revision ${frozen.number}.`); onChanged();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };

  return <Stack component="section" aria-label="Print profiles" gap="xs">
    <Title order={3}>Printer, process and material profiles</Title>
    <Text size="sm">Parameters not declared stay unknown; they are never filled with zero or a slicer default in the record.</Text>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    {notice && <Alert color="green" role="status">{notice}</Alert>}
    <Group align="end">
      <RecordNavigation name={current?.name ?? "profile"} selected={current?.definition_id ?? null}>
      <Select label="Saved profile" placeholder="Select a profile" data={records.map(r => ({ value: r.draft_id ?? r.definition_id, label: `${r.name}${r.content.print_profile ? ` · ${r.content.print_profile.technology} ${r.content.print_profile.role}` : ''}` }))}
        value={current?.draft_id ?? null} onChange={value => { const found = records.find(r => r.draft_id === value); if (found) void open(found); }} />
      </RecordNavigation>
      <InspectionScope permission="item.create">
        <Group align="end">
          <Select label="New profile role" value={role} data={['printer', 'process', 'material']} onChange={value => value && setRole(value as Role)} />
          <Select label="Technology" value={technology} data={[{ value: 'fdm', label: 'FDM' }, { value: 'resin', label: 'Resin' }]} onChange={value => value && setTechnology(value as Technology)} />
          <Button variant="light" onClick={start} {...create.props}>Start new profile</Button>
        </Group>
      </InspectionScope>
    </Group>
    {presetSets.length > 0 && <InspectionScope permission="item.create">
      <Group align="end">
        <Select label="Printer preset set" description="Names the pinned OrcaSlicer machine, process and filament presets; nothing is copied."
          placeholder="Select a printer" data={presetSets.map(set => ({ value: set.key, label: set.label }))} value={quickKey} onChange={setQuickKey} />
        <Button variant="light" onClick={() => void quickSetup()} loading={quickBusy} disabled={!quickKey || !freezeGate.allowed} {...create.props}>Create and freeze the three profiles</Button>
      </Group>
    </InspectionScope>}
    {revisions.length > 0 && <Text size="sm">Frozen revisions: {revisions.map(r => `r${r.number}`).join(', ')}</Text>}
    {shown && <>
      <SbStatus led={dirty ? 'review' : 'idle'} dimension={`${shown.technology} ${shown.role} profile`} value={dirty ? 'unsaved changes' : current?.base_revision_id ? 'saved draft, frozen before' : 'saved draft'} />
      <InspectionScope permission="item.create">
        <Group align="end">
          <TextInput label="Profile name" value={name} disabled={!!current} onChange={e => setName(e.target.value)} />
          <Select label="Basis for new values" value={basis} data={[{ value: 'preference', label: 'Workshop preference' }, { value: 'documented', label: 'Documented' }, { value: 'inferred', label: 'Inferred' }]}
            onChange={value => value && setBasis(value as Basis)} />
          <TextInput label="Basis note or citation" value={note} onChange={e => setNote(e.target.value)} placeholder="Where the value comes from" />
        </Group>
      </InspectionScope>
      {shown.technology === 'fdm' && <InspectionScope permission="item.create">
        <Select label="OrcaSlicer vendor preset" description="Bundled with the pinned OrcaSlicer release; declared values override it."
          data={[{ value: 'none', label: 'None' }, ...presetSets.map(set => ({ value: set.key, label: `${set[shown.role].name} (${set[shown.role].vendor} ${set[shown.role].bundle_version})` }))]}
          value={presetSets.find(set => set[shown.role].name === shown.vendor_preset?.name && set[shown.role].vendor === shown.vendor_preset?.vendor)?.key ?? 'none'}
          onChange={value => { const set = presetSets.find(item => item.key === value); setProfile({ ...shown, vendor_preset: set ? set[shown.role] : null }); setDirty(true); setNotice(''); }} />
      </InspectionScope>}
      {shown.vendor_preset && <Text size="sm">Preset: {shown.vendor_preset.vendor} {shown.vendor_preset.bundle_version} / {shown.vendor_preset.name}. Undeclared settings come from this preset.</Text>}
      <Table striped aria-label="Profile parameters">
        <Table.Thead><Table.Tr><Table.Th>Parameter</Table.Th><Table.Th>Value</Table.Th><Table.Th>Basis</Table.Th><Table.Th>Source</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{roleSpecs.map(spec => {
          const draft = shown.parameters[spec.key];
          const saved = recorded.get(spec.key);
          const value = draft?.value ?? null;
          return <Table.Tr key={spec.key}>
            <Table.Td><Text size="sm">{spec.label}{spec.unit ? ` (${spec.unit})` : ''}</Text>{spec.required_for_slicing && <Text size="xs" c="dimmed">required for PrusaSlicer slicing</Text>}</Table.Td>
            <Table.Td><InspectionScope permission="item.create">{spec.type === 'choice'
              ? <Select aria-label={spec.label} data={['unknown', ...spec.choices]} value={value === null ? 'unknown' : String(value)} onChange={v => change(spec.key, !v || v === 'unknown' ? null : v)} />
              : <NumberInput aria-label={spec.label} value={typeof value === 'number' ? value : ''} min={spec.minimum ?? undefined} max={spec.maximum ?? undefined}
                  allowDecimal={spec.type === 'number'} onChange={v => change(spec.key, typeof v === 'number' ? v : null)} />}</InspectionScope>
              {value === null && <SbUnknown what={spec.label} />}</Table.Td>
            <Table.Td><Text size="sm">{draft ? draft.basis : 'unknown'}</Text>{draft?.note && <Text size="xs" c="dimmed">{draft.note}</Text>}</Table.Td>
            <Table.Td>{saved?.source ? <SourceLine source={saved.source} /> : draft?.source ? <SourceLine source={draft.source} /> : <Text size="xs" c="dimmed">{valueText(null)}</Text>}</Table.Td>
          </Table.Tr>;
        })}</Table.Tbody>
      </Table>
      <Group>
        <Button onClick={() => void save()} loading={busy} disabled={!dirty || !name.trim()} {...create.props}>Save profile</Button>
        <Button variant="light" onClick={() => void freeze()} disabled={!current || dirty || busy} {...freezeGate.props}>Freeze profile</Button>
      </Group>
      <ReadOnlyNote permission="item.create">Saving profiles is unavailable.</ReadOnlyNote>
      {dirty && <Text size="sm">Unsaved profile values. Save before freezing.</Text>}
    </>}
  </Stack>;
}

