import { Alert, Anchor, Button, Group, NumberInput, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { InspectionScope, ReadOnlyNote, useCan, usePermission } from '../../lib/permissions';
import { SbJobCard, SbProvenance, SbStatus, SbUnknown } from '../../components/sb';
import { jobState, pretty } from '../builds/BuildsPanel';
import {
  ROLES, freezeRecord, listMechanical, listPreparationRevisions, listPreparations, listProfileRevisions, listProfiles,
  readMechanicalRevision, readPreparation, requestSlice, savePreparation, sliceOptions, sliceOutputUrl, sliceRead,
  type Estimate, type MechanicalRecords, type MechanicalRevision, type Pin, type PreparationRead, type PreparationRecord,
  type PrintPreparation, type ProfileRecord, type RevisionRow, type Role, type SliceOptions, type SliceRead, type Technology,
} from './api';
import { ModelUpload } from './ModelUpload';
import { ParameterTable } from './ParameterTable';

const message = (e: unknown) => e instanceof Error ? e.message : String(e);

function blank(technology: Technology): PrintPreparation {
  return {
    schema_version: '1', variant_label: '', technology,
    part: { mechanical_revision_id: '', snapshot_sha256: '', source_local_id: '', path: '' },
    model_units: { value: null, basis: 'unknown', source: null, note: null },
    profiles: { printer: { revision_id: '', snapshot_sha256: '' }, process: { revision_id: '', snapshot_sha256: '' }, material: { revision_id: '', snapshot_sha256: '' } },
    orientation: { status: 'unknown', rotation_deg: null, basis: null }, supports: { status: 'unknown', basis: null },
    copies: 1, output_format: 'gcode', slicer_tool: 'orcaslicer-2.4.2', limitations: [],
  };
}

/** Slice builds that can still change; the card polls until none of these remain. */
const NONTERMINAL_SLICE = new Set(['waiting_dispatch', 'queued', 'leased', 'running', 'cancellation_requested']);
const SLICE_POLL_MS = 3000;

function EstimateCell({ label, estimate, unit }: { label: string; estimate: Estimate; unit: string }) {
  return estimate.status === 'unknown' || estimate.value === null
    ? <SbUnknown what={label} />
    : <Text size="sm" className="sb-mono">{estimate.value} {unit} (slicer estimate)</Text>;
}

/** Manufacturing variants: one part identity, exact model, profiles, orientation, supports and slicer. */
export function PreparationsSection({ workspaceId, projectId, refreshKey }: { workspaceId: string; projectId: string | null; refreshKey: number }) {
  const create = usePermission('item.create');
  const freezeGate = usePermission('design.freeze');
  const canExecute = useCan('build.execute');
  const [records, setRecords] = useState<PreparationRecord[]>([]);
  const [profiles, setProfiles] = useState<ProfileRecord[]>([]);
  const [mechanical, setMechanical] = useState<MechanicalRecords['records']>([]);
  const [part, setPart] = useState<MechanicalRevision | null>(null);
  const [profileRevisions, setProfileRevisions] = useState<Partial<Record<Role, RevisionRow & { name: string }>>>({});
  const [current, setCurrent] = useState<PreparationRecord | null>(null);
  const [read, setRead] = useState<PreparationRead | null>(null);
  const [revisions, setRevisions] = useState<RevisionRow[]>([]);
  const [draft, setDraft] = useState<PrintPreparation | null>(null);
  const [dirty, setDirty] = useState(false);
  const [frozen, setFrozen] = useState<string | null>(null);
  const [slicing, setSlicing] = useState<SliceOptions | null>(null);
  const [review, setReview] = useState<SliceRead | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let alive = true;
    Promise.all([listPreparations(projectId), listProfiles(projectId), listMechanical(workspaceId)])
      .then(([prep, prof, mech]) => { if (alive) { setRecords(prep); setProfiles(prof); setMechanical(mech.records); } })
      .catch(e => { if (alive) setError(message(e)); });
    return () => { alive = false; };
  }, [projectId, workspaceId, refreshKey]);

  const pending = !!frozen && !!slicing?.builds.some(build => NONTERMINAL_SLICE.has(build.state));
  useEffect(() => {
    if (!pending || !frozen) return;
    let alive = true;
    const timer = setInterval(() => {
      sliceOptions(frozen).then(next => { if (alive) setSlicing(next); }).catch(() => { /* keep the last known state; the next tick retries */ });
    }, SLICE_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [pending, frozen]);

  const edit = (change: (next: PrintPreparation) => void) => {
    setDraft(prior => { if (!prior) return prior; const next = structuredClone(prior); change(next); return next; });
    setDirty(true); setNotice('');
  };
  const open = async (record: PreparationRecord) => {
    setBusy(true); setError(''); setNotice(''); setFrozen(null); setSlicing(null); setReview(null);
    try {
      const [detail, history] = await Promise.all([readPreparation({ draft_id: record.draft_id! }), listPreparationRevisions(record.definition_id)]);
      setCurrent(detail); setRead(detail); setRevisions(history);
      setDraft(detail.content.print_preparation ?? null); setDirty(false);
      const pin = detail.content.print_preparation?.part.mechanical_revision_id;
      setPart(pin ? await readMechanicalRevision(pin) : null);
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const openRevision = async (revisionId: string | null) => {
    setFrozen(revisionId); setReview(null); setSlicing(null);
    if (!revisionId) { if (current) setRead(await readPreparation({ draft_id: current.draft_id! })); return; }
    setBusy(true); setError('');
    try {
      const [detail, options] = await Promise.all([readPreparation({ revision_id: revisionId }), sliceOptions(revisionId)]);
      setRead(detail); setSlicing(options);
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const choosePart = async (revisionId: string) => {
    try {
      const revision = await readMechanicalRevision(revisionId);
      setPart(revision);
      edit(next => { next.part = { mechanical_revision_id: revision.revision_id, snapshot_sha256: revision.snapshot_sha256, source_local_id: '', path: '' }; });
    } catch (e) { setError(message(e)); }
  };
  const chooseProfile = async (role: Role, draftId: string) => {
    const record = profiles.find(p => p.draft_id === draftId);
    if (!record) return;
    try {
      const history = await listProfileRevisions(record.definition_id);
      const latest = history[history.length - 1];
      if (!latest) { setError(`${record.name} has no frozen revision; freeze it before pinning.`); return; }
      setProfileRevisions(items => ({ ...items, [role]: { ...latest, name: record.name } }));
      const pin: Pin = { revision_id: latest.revision_id, snapshot_sha256: latest.sha256 };
      edit(next => { next.profiles[role] = pin; });
    } catch (e) { setError(message(e)); }
  };
  const save = async () => {
    if (!draft || !draft.variant_label.trim()) return;
    setBusy(true); setError('');
    try {
      const saved = await savePreparation(draft.variant_label.trim(), draft, current?.draft_id && current.state ? { draft_id: current.draft_id, state: current.state } : null);
      setRecords(items => [...items.filter(item => item.draft_id !== saved.draft_id), saved]);
      await open(saved); setNotice(`Saved ${saved.name}.`);
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const freeze = async () => {
    if (!current?.draft_id || !current.state || dirty) return;
    setBusy(true); setError('');
    try {
      const result = await freezeRecord('print_preparation.freeze', { draft_id: current.draft_id, state: current.state });
      await open(current); await openRevision(result.revision_id); setNotice(`Frozen preparation revision ${result.number}.`);
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const slice = async () => {
    if (!frozen || !slicing?.available_recipe_id) return;
    setBusy(true); setError('');
    try { await requestSlice(frozen, slicing.available_recipe_id); setSlicing(await sliceOptions(frozen)); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const inspect = async (buildId: string) => {
    if (!frozen) return;
    setBusy(true); setError('');
    try { setReview(await sliceRead(frozen, buildId)); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };

  const models = part?.content.mechanical_source.sources.flatMap(s => s.files.filter(f => f.role === 'model').map(f => ({ value: `${s.local_id}\u0000${f.path}`, label: `${f.path} (${f.format})` }))) ?? [];
  const profileChoices = (role: Role) => profiles.filter(p => p.content.print_profile?.role === role && p.content.print_profile.technology === draft?.technology && p.base_revision_id)
    .map(p => ({ value: p.draft_id!, label: p.name }));

  return <Stack component="section" aria-label="Print preparations" gap="xs">
    <Title order={3}>Preparations and manufacturing variants</Title>
    <Text size="sm">A preparation is one manufacturing variant of a mechanical part. It pins the exact model, profiles, orientation, supports and slicer tool. Nothing here is called printable or sent to a printer.</Text>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    {notice && <Alert color="green" role="status">{notice}</Alert>}
    <Group align="end">
      <Select label="Saved preparation" placeholder="Select a preparation" data={records.map(r => ({ value: r.draft_id!, label: r.name }))}
        value={current?.draft_id ?? null} onChange={value => { const found = records.find(r => r.draft_id === value); if (found) void open(found); }} />
      <InspectionScope permission="item.create">
        <Group align="end">
          <Button variant="light" onClick={() => { setCurrent(null); setRead(null); setRevisions([]); setPart(null); setFrozen(null); setSlicing(null); setDraft(blank('fdm')); setDirty(true); }} {...create.props}>Start new FDM preparation</Button>
          <Button variant="light" onClick={() => { setCurrent(null); setRead(null); setRevisions([]); setPart(null); setFrozen(null); setSlicing(null); setDraft(blank('resin')); setDirty(true); }} {...create.props}>Start new resin preparation</Button>
        </Group>
      </InspectionScope>
      {revisions.length > 0 && <Select label="Frozen revision" placeholder="View or slice a revision" clearable data={revisions.map(r => ({ value: r.revision_id, label: `r${r.number}` }))}
        value={frozen} onChange={value => void openRevision(value)} />}
    </Group>
    {draft && !frozen && <InspectionScope permission="item.create">
      <Stack gap="xs">
        <ModelUpload workspaceId={workspaceId} onCreated={(revisionId) => { void listMechanical(workspaceId).then(found => { setMechanical(found.records); return choosePart(revisionId); }).catch(e => setError(message(e))); }} />
        <Group align="end">
          <TextInput label="Variant label" value={draft.variant_label} onChange={e => { const value = e.target.value; edit(next => { next.variant_label = value; }); }} />
          <Text size="sm">Technology: {draft.technology.toUpperCase()}</Text>
          <Select label="Part (frozen mechanical source)" placeholder="Select a revision" value={draft.part.mechanical_revision_id || null}
            data={mechanical.flatMap(m => m.revisions.map(r => ({ value: r.revision_id, label: `${m.name} r${r.number}` })))} onChange={value => value && void choosePart(value)} />
          <Select label="Model file" placeholder={part ? 'Select a pinned model' : 'Select a part first'} data={models}
            value={draft.part.path ? `${draft.part.source_local_id}\u0000${draft.part.path}` : null}
            onChange={value => { if (!value) return; const [local, path] = value.split('\u0000'); edit(next => { next.part.source_local_id = local ?? ''; next.part.path = path ?? ''; }); }} />
        </Group>
        <Group align="end">
          {ROLES.map(role => <Select key={role} label={`${role} profile`} placeholder="Frozen profile" data={profileChoices(role)}
            onChange={value => value && void chooseProfile(role, value)}
            description={profileRevisions[role] ? `${profileRevisions[role]!.name} r${profileRevisions[role]!.number}` : draft.profiles[role].revision_id ? 'pinned exact revision' : 'not pinned'} />)}
        </Group>
        <Group align="end">
          <Select label="Model units" value={draft.model_units.value ?? 'unknown'} data={['unknown', 'mm', 'in']}
            onChange={value => edit(next => { next.model_units = !value || value === 'unknown' ? { value: null, basis: 'unknown', source: null, note: null } : { value: value as 'mm' | 'in', basis: 'preference', source: null, note: 'Declared in print preparation' }; })} />
          <Select label="Orientation" value={draft.orientation.status} data={[{ value: 'unknown', label: 'Unknown' }, { value: 'as_modelled', label: 'As modeled' }, { value: 'rotated', label: 'Rotated' }]}
            onChange={value => edit(next => { const status = (value ?? 'unknown') as PrintPreparation['orientation']['status']; next.orientation = { status, rotation_deg: status === 'rotated' ? next.orientation.rotation_deg ?? [0, 0, 0] : null, basis: status === 'unknown' ? null : next.orientation.basis }; })} />
          {draft.orientation.rotation_deg && (['X', 'Y', 'Z'] as const).map((axis, index) => <NumberInput key={axis} label={`Rotate ${axis} deg`} min={-360} max={360} w={110}
            value={draft.orientation.rotation_deg![index]} onChange={v => edit(next => { const angles = [...next.orientation.rotation_deg!] as [number, number, number]; angles[index] = typeof v === 'number' ? v : 0; next.orientation.rotation_deg = angles; })} />)}
          {draft.orientation.status !== 'unknown' && <TextInput label="Orientation basis" value={draft.orientation.basis ?? ''} onChange={e => { const value = e.target.value; edit(next => { next.orientation.basis = value || null; }); }} />}
        </Group>
        <Group align="end">
          <Select label="Supports" value={draft.supports.status} data={[{ value: 'unknown', label: 'Unknown' }, { value: 'none', label: 'None' }, { value: 'auto', label: 'Automatic' }, { value: 'buildplate_only', label: 'Build plate only' }]}
            onChange={value => edit(next => { const status = (value ?? 'unknown') as PrintPreparation['supports']['status']; next.supports = { status, basis: status === 'unknown' ? null : next.supports.basis }; })} />
          {draft.supports.status !== 'unknown' && <TextInput label="Supports basis" value={draft.supports.basis ?? ''} onChange={e => { const value = e.target.value; edit(next => { next.supports.basis = value || null; }); }} />}
          <NumberInput label="Copies" min={1} max={32} w={90} value={draft.copies} onChange={v => edit(next => { next.copies = typeof v === 'number' ? v : 1; })} />
          <Select label="Output" value={draft.output_format}
            data={[{ value: 'gcode', label: 'G-code' }, { value: '3mf', label: draft.slicer_tool === 'orcaslicer-2.4.2' ? 'G-code and sliced 3MF project' : 'Prepared 3MF' }]}
            onChange={value => value && edit(next => { next.output_format = value as 'gcode' | '3mf'; })} />
          {draft.technology === 'fdm' && <Select label="Slicer" value={draft.slicer_tool}
            data={[{ value: 'orcaslicer-2.4.2', label: 'OrcaSlicer 2.4.2 (vendor presets)' }, { value: 'prusaslicer-2.5.0', label: 'PrusaSlicer 2.5.0 (image not built)' }]}
            onChange={value => value && edit(next => { next.slicer_tool = value as PrintPreparation['slicer_tool']; })} />}
        </Group>
        <Group>
          <Button onClick={() => void save()} loading={busy} disabled={!dirty || !draft.variant_label.trim()} {...create.props}>Save preparation</Button>
          <Button variant="light" onClick={() => void freeze()} disabled={!current || dirty || busy} {...freezeGate.props}>Freeze preparation</Button>
        </Group>
      </Stack>
    </InspectionScope>}
    <ReadOnlyNote permission="item.create">Saving preparations is unavailable.</ReadOnlyNote>
    {read?.part_identity && <Stack gap={4}>
      <Group gap="sm">
        <SbStatus led="not-evaluated" dimension="printable" value="not evaluated" />
        <SbStatus led="off" dimension="printer submission" value="not available" />
        <SbStatus led="not-evaluated" dimension="physical qualification" value="none" />
      </Group>
      <SbProvenance label="Part" summary={`${read.part_identity.name} r${read.part_identity.revision_number} · ${read.part_identity.model.path} (${read.part_identity.model.format}) · rights ${read.part_identity.model.rights}`}
        pins={[{ label: 'Part identity', value: read.part_identity.mechanical_definition_id }, { label: 'Model SHA-256', value: read.part_identity.model.sha256 }]} />
      <ParameterTable rows={read.parameters} />
      {read.slicing && read.slicing.blockers.length > 0 && <Alert color="yellow" title="Slicing unavailable">{read.slicing.blockers.map(b => <Text size="sm" key={b}>{b}</Text>)}</Alert>}
      {read.slicing?.tool_default_settings && read.slicing.tool_default_settings.length > 0 && <Text size="sm">Left to slicer defaults (not declared): {read.slicing.tool_default_settings.join(', ')}</Text>}
      {read.slicing?.presets && <Text size="sm">Vendor presets: {ROLES.map(role => read.slicing!.presets![role] ? `${role} ${read.slicing!.presets![role]!.vendor} ${read.slicing!.presets![role]!.bundle_version} / ${read.slicing!.presets![role]!.name}` : `${role} none`).join(' · ')}</Text>}
      {read.slicing?.preset_settings && read.slicing.preset_settings.length > 0 && <Text size="sm">Taken from the vendor preset (not declared): {read.slicing.preset_settings.join(', ')}</Text>}
      {read.slicing?.not_sent_settings && read.slicing.not_sent_settings.length > 0 && <Text size="sm">Declared but not sent to this slicer: {read.slicing.not_sent_settings.join(', ')}</Text>}
    </Stack>}
    {frozen && slicing && <Stack gap={4} aria-label="Slicing">
      <Title order={4}>Optional slicing</Title>
      <Text size="sm">Tool: {slicing.tool.name} {slicing.tool.package_version}. Requires an operator-approved recipe for this exact revision.</Text>
      {!slicing.available_recipe_id && <Alert color="yellow" title="Slicing is not available" role="status">
        <Text size="sm">{slicing.unavailable_reason ?? 'No approved recipe exists for this exact revision.'}</Text>
        {slicing.proposed_recipe && <Text size="xs">Slicing runs only after an operator approves the recipe, enables the tool and starts the runner; those steps are outside this workspace.</Text>}
      </Alert>}
      {slicing.recipe_id && <Text size="xs" className="sb-mono">Exact recipe: {slicing.recipe_id}</Text>}
      <Group><Button onClick={() => void slice()} disabled={!canExecute || busy || !slicing.available_recipe_id}>Request slice</Button></Group>
      <ReadOnlyNote permission="build.execute">Requesting a slice is unavailable.</ReadOnlyNote>
      {slicing.builds.map(build => <SbJobCard key={build.build_id} title={build.build_id} state={jobState(build.state)} stateWords={pretty(build.state)} dimension="slice"
        detail={build.failure ?? undefined}
        actions={<Button variant="light" size="xs" disabled={busy || build.state !== 'succeeded'} onClick={() => void inspect(build.build_id)}>Inspect slice {build.build_id}</Button>} />)}
    </Stack>}
    {review && <Stack gap={4} aria-label="Slice evidence">
      <Title order={4}>Registered slice evidence</Title>
      <Text size="sm">Generated by {review.inputs.tool.name} {review.inputs.tool.package_version}. This is not a printability claim, printer submission or physical qualification.</Text>
      <SbProvenance label="Tool image" summary={review.image} pins={[{ label: 'Recipe', value: review.recipe_id }, { label: 'Report SHA-256', value: review.report_sha256 }]} />
      <Text size="sm">Profiles: {ROLES.map(role => `${role} ${review.inputs.profiles[role].revision_id.slice(0, 8)}`).join(' · ')}</Text>
      <Group gap="lg">
        <EstimateCell label="Print time" estimate={review.report.estimates.print_time_s} unit="s" />
        <EstimateCell label="Filament length" estimate={review.report.estimates.filament_length_mm} unit="mm" />
        <EstimateCell label="Filament mass" estimate={review.report.estimates.filament_mass_g} unit="g" />
        {review.report.estimates.layer_count && <EstimateCell label="Layer count" estimate={review.report.estimates.layer_count} unit="layers" />}
      </Group>
      {review.report.applied_settings && <Text size="sm">Applied presets: {['printer_settings_id', 'print_settings_id', 'filament_settings_id'].map(key => review.report.applied_settings![key] ?? 'unknown').join(' · ')}</Text>}
      <Table aria-label="Slice outputs"><Table.Thead><Table.Tr><Table.Th>Output</Table.Th><Table.Th>Size</Table.Th><Table.Th>Rights</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{review.outputs.map(output => <Table.Tr key={output.output_id}>
          <Table.Td><Anchor href={sliceOutputUrl(review, output.output_id)}>{output.path}</Anchor></Table.Td>
          <Table.Td><Text size="sm" className="sb-mono">{output.size} B</Text></Table.Td>
          <Table.Td><Text size="sm">{output.rights}</Text></Table.Td>
        </Table.Tr>)}</Table.Tbody></Table>
    </Stack>}
  </Stack>;
}
