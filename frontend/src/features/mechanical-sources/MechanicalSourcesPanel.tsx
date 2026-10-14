import { Alert, Badge, Button, Card, Group, Select, Stack, Table, Text, Textarea, TextInput, Title } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { randomUUID } from '../../lib/random-id';
import { command, request, SourceError, type RevisionDetail, type SourcePage } from '../sources/api';
import { MechanicalUncertaintyEditor, MechanicalUncertaintyRead } from './MechanicalUncertainty';
import type { MechanicalFile, MechanicalRead, MechanicalSource, MechanicalSourcePin, ModelChoice, ModelPin, RecordPage, TargetChoice, TargetPage, TargetPin } from './api';
import { ExactPins, RevisionLabel } from "../../lib/IdentityLabel";

const keyFor = (prefix: string, rows: { local_id: string }[]) => {
  let i = 1; while (rows.some(row => row.local_id === `${prefix}${i}`)) i += 1; return `${prefix}${i}`;
};
const nullable = (text: string) => text.trim() || null;
const currentPath = (read: MechanicalRead) => read.draft_id ? `mechanical-sources/drafts/${read.draft_id}` : `mechanical-sources/revisions/${read.revision_id}`;
const blank = (): MechanicalSource => ({ item_role: 'enclosure', sources: [], targets: [], models: [], limitations: [] });
const roleOptions: MechanicalFile['role'][] = ['native', 'recipe', 'model', 'supporting', 'unsupported'];
const formats: MechanicalFile['format'][] = ['freecad', 'build123d', 'cadquery', 'step', 'brep', 'mesh', 'other'];

export function MechanicalEvaluation({ read }: { read: MechanicalRead }) {
  return <Stack gap="xs">
    <Badge color={read.evaluation.readiness === 'blocked' ? 'red' : 'yellow'}>{read.evaluation.readiness.replace(/_/g, ' ')}</Badge>
    <Text size="sm">Native execution: none · Geometry validation: not performed · Clearance, fit and manufacturability: not evaluated · Physical qualification: false</Text>
    <Table><Table.Thead><Table.Tr><Table.Th>Preserved source</Table.Th><Table.Th>Exact pins and ancestry</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
      {read.evaluation.sources.map(source => <Table.Tr key={source.local_id}><Table.Td>{source.name} revision {source.number} ({source.role})</Table.Td><Table.Td>
        <Text size="xs"><RevisionLabel kind="source" id={source.source_revision_id} /> · manifest {source.source_manifest_sha256}</Text>
        <Text size="xs">Original/derivative ancestry: {source.derived_from ?? 'original'} · {source.ancestry.join(', ') || 'none'}</Text>
        {source.files.map(file => <Text size="xs" key={file.path}>{file.path} · {file.sha256} · rights {file.rights} · {file.role}/{file.format}</Text>)}
      </Table.Td></Table.Tr>)}
    </Table.Tbody></Table>
    {read.evaluation.targets.map(target => <Card withBorder key={target.local_id}><Text>{target.local_id}: {target.name} revision {target.number} · {target.role}</Text>
      <Text size="xs"><RevisionLabel id={target.revision_id} snapshotId={target.snapshot_sha256} /></Text>
      {target.board && <Text size="xs">Board interpretation {target.board.interpretation_id} · {target.board.interpretation_sha256} · <RevisionLabel kind="source" id={target.board.source_revision_id} role="native source" /> · manifest {target.board.source_manifest_sha256} · option {target.board.option_id ?? 'unknown'}</Text>}
      {target.component && <Text size="sm">Native component: {target.component.reference} · {target.native_component_id}</Text>}
      {target.board_geometry && <Text size="sm">Extracted board input: {target.board_geometry.outline.length} outline polygons · {target.board_geometry.coverage.outline} · {target.board_geometry.units} · {target.board_geometry.coordinate_frame} · {target.board_geometry.extractor.adapter}/{target.board_geometry.extractor.tool_version}. {target.board_geometry.unsupported.join('; ')}</Text>}
    </Card>)}
    {read.evaluation.models.map(model => <Card withBorder key={model.local_id}><Text>{model.label} · target {model.target_local_id} · {model.purpose}</Text>
      <Text size="xs">Representation {model.representation_id} · <RevisionLabel id={model.revision_id} snapshotId={model.snapshot_sha256} /> · source {model.source_local_id}/{model.path} · {model.sha256} · rights {model.rights}</Text>
      <Text size="sm">Units {model.units ?? 'unknown'} · frame {model.frame ?? 'unknown'} · accuracy {model.accuracy ?? 'unknown'} · {model.basis}</Text>
    </Card>)}
    <MechanicalUncertaintyRead assessment={read.evaluation.uncertainty_assessment} />
    {read.evaluation.findings.map((finding, i) => <Text size="sm" key={i}>{finding.status.replace(/_/g, ' ')} · {finding.local_id ? `${finding.local_id}: ` : ''}{finding.message}</Text>)}
    {read.evaluation.limitations.map((text, i) => <Text size="sm" key={i}>Limitation: {text}</Text>)}
  </Stack>;
}

/** Exact source management only. Native tools and geometry checks require separate execution. */
export function MechanicalSourcesPanel({ workspaceId, permissions, onAccessLost }: { workspaceId: string; permissions: string[]; onAccessLost?: () => void }) {
  const [shown, setShown] = useState(true);
  const [records, setRecords] = useState<RecordPage>({ records: [], next_after: null });
  const [sources, setSources] = useState<SourcePage>({ revisions: [], next_after: null });
  const [targets, setTargets] = useState<TargetPage>({ targets: [], next_after: null });
  const [read, setRead] = useState<MechanicalRead | null>(null);
  const [form, setForm] = useState<MechanicalSource | null>(null);
  const [name, setName] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [sourcePath, setSourcePath] = useState('');
  const [targetId, setTargetId] = useState('');
  const [modelRevision, setModelRevision] = useState<TargetChoice | null>(null);
  const [modelId, setModelId] = useState('');
  const [modelTarget, setModelTarget] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(false);
  const refreshSerial = useRef(0);
  const modelSerial = useRef(0);
  const pendingSave = useRef<{ fingerprint: string; key: string } | null>(null);
  useEffect(() => {
    mounted.current = true; generation.current += 1;
    setRecords({ records: [], next_after: null }); setSources({ revisions: [], next_after: null }); setTargets({ targets: [], next_after: null });
    setRead(null); setForm(null); setName(''); setSourceId(''); setSourcePath(''); setTargetId(''); setModelRevision(null); setModelId(''); setModelTarget(''); setShown(true); setBusy(false); setMessage(''); pendingSave.current = null;
    return () => { mounted.current = false; generation.current += 1; };
  }, [workspaceId]);
  const active = (token: number) => mounted.current && token === generation.current;
  function failed(reason: unknown) {
    setMessage(reason instanceof Error ? reason.message : 'Mechanical source request failed.');
    if (reason instanceof SourceError && [401, 403, 404].includes(reason.status)) {
      generation.current += 1; setShown(false); setBusy(false);
      setRecords({ records: [], next_after: null }); setSources({ revisions: [], next_after: null }); setTargets({ targets: [], next_after: null }); setModelRevision(null);
      // Hide sensitive retained/unsaved declarations; recheck them before showing on recovery.
      onAccessLost?.();
    }
  }
  async function loadChoices(declaration: MechanicalSource | null) {
    const ids = new Set([...(declaration?.targets ?? []).map(t => t.revision_id), ...(declaration?.models ?? []).map(m => m.revision_id)]);
    return Promise.all([...ids].map(id => request<TargetChoice>(`mechanical-sources/targets/${id}`)));
  }
  async function checkRetained() {
    const [, , choices] = await Promise.all([
      read ? request<MechanicalRead>(currentPath(read)) : Promise.resolve(null),
      Promise.all((form?.sources ?? []).map(source => request(`sources/revisions/${source.source_revision_id}`))),
      loadChoices(form ?? read?.content.mechanical_source ?? null),
    ]);
    return choices;
  }
  async function refresh() {
    const token = generation.current; const serial = ++refreshSerial.current;
    try {
      const [nextRecords, nextSources, nextTargets, retainedChoices] = await Promise.all([
        request<RecordPage>(`mechanical-sources/workspaces/${workspaceId}/records`), request<SourcePage>(`sources/workspaces/${workspaceId}/revisions`),
        request<TargetPage>(`mechanical-sources/workspaces/${workspaceId}/targets`), checkRetained(),
      ]);
      if (!active(token) || serial !== refreshSerial.current) return;
      setRecords(nextRecords); setSources(nextSources); setTargets({ ...nextTargets, targets: [...nextTargets.targets.filter(t => !retainedChoices.some(c => c.revision_id === t.revision_id)), ...retainedChoices] }); setShown(true); setMessage('');
      // Retain the original state token when an unsaved form is open.
    } catch (reason) { if (active(token) && serial === refreshSerial.current) failed(reason); }
  }
  async function more(kind: 'records' | 'targets' | 'sources') {
    const token = generation.current;
    const after = kind === 'records' ? records.next_after : kind === 'targets' ? targets.next_after : sources.next_after;
    if (!after) return;
    try {
      if (kind === 'sources') {
        const page = await request<SourcePage>(`sources/workspaces/${workspaceId}/revisions?after=${after}`);
        if (active(token)) setSources(prior => ({ ...page, revisions: [...prior.revisions, ...page.revisions] }));
      } else if (kind === 'records') {
        const page = await request<RecordPage>(`mechanical-sources/workspaces/${workspaceId}/records?after=${after}`);
        if (active(token)) setRecords(prior => ({ ...page, records: [...prior.records, ...page.records] }));
      } else {
        const page = await request<TargetPage>(`mechanical-sources/workspaces/${workspaceId}/targets?after=${after}`);
        if (active(token)) setTargets(prior => ({ ...page, targets: [...prior.targets, ...page.targets] }));
      }
    } catch (reason) { if (active(token)) failed(reason); }
  }
  async function open(path: string) {
    generation.current += 1; const token = generation.current;
    setRead(null); setForm(null); setBusy(false); setMessage(''); setModelRevision(null); pendingSave.current = null;
    try {
      const result = await request<MechanicalRead>(path);
      if (!active(token)) return;
      const choices = await loadChoices(result.content.mechanical_source);
      if (active(token)) {
        setTargets(prior => ({ ...prior, targets: [...prior.targets.filter(t => !choices.some(c => c.revision_id === t.revision_id)), ...choices] }));
        setRead(result); setShown(true);
      }
    }
    catch (reason) { if (active(token)) failed(reason); }
  }
  const pinSource = (detail: RevisionDetail, prior: MechanicalSource, files = detail.manifest.files): MechanicalSourcePin => ({
    local_id: keyFor('source', prior.sources), source_revision_id: detail.revision_id, source_manifest_sha256: detail.manifest_sha256,
    files: files.map(file => ({ path: file.path, sha256: file.sha256, rights: file.rights, role: 'supporting', format: 'other' })),
  });
  async function addSource(id: string) {
    const token = generation.current;
    try { const detail = await request<RevisionDetail>(`sources/revisions/${id}`);
      if (!active(token)) return;
      const selected = sourcePath.trim() ? detail.manifest.files.filter(f => f.path === sourcePath.trim()) : detail.manifest.files;
      if (!selected.length) throw new Error('The exact source path is absent from this revision.');
      if (selected.length > 200) throw new Error('Choose an exact source file path for a bundle with more than 200 files.');
      setForm(prior => {
        if (!prior) return prior;
        const existing = prior.sources.find(s => s.source_revision_id === id);
        const pin = pinSource(detail, prior, selected);
        return existing ? { ...prior, sources: prior.sources.map(s => s.local_id === existing.local_id ? { ...s, files: [...s.files, ...pin.files.filter(f => !s.files.some(old => old.path === f.path))] } : s) }
          : { ...prior, sources: [...prior.sources, pin] };
      });
    } catch (reason) { if (active(token)) failed(reason); }
  }
  async function addTarget(id: string) {
    const token = generation.current;
    try { const detail = await request<TargetChoice>(`mechanical-sources/targets/${id}`);
      if (!active(token)) return;
      setTargets(prior => ({ ...prior, targets: [...prior.targets.filter(t => t.revision_id !== id), detail] }));
      setForm(prior => prior ? { ...prior, targets: [...prior.targets, { local_id: keyFor('target', prior.targets), role: detail.board || ['board', 'pcb'].includes(detail.kind) ? 'board' : 'hardware',
        revision_id: detail.revision_id, snapshot_sha256: detail.snapshot_sha256, board: detail.board ? {
          interpretation_id: detail.board.interpretation_id, interpretation_sha256: detail.board.interpretation_sha256,
          source_revision_id: detail.board.source_revision_id, source_manifest_sha256: detail.board.source_manifest_sha256, option_id: null,
        } : null, native_component_id: null, basis: 'Explicit input selection' }] } : prior);
    } catch (reason) { if (active(token)) failed(reason); }
  }
  async function inspectModel(id: string) {
    const token = generation.current; const serial = ++modelSerial.current; setModelRevision(null);
    try { const result = await request<TargetChoice>(`mechanical-sources/targets/${id}`); if (active(token) && serial === modelSerial.current) setModelRevision(result); }
    catch (reason) { if (active(token) && serial === modelSerial.current) failed(reason); }
  }
  async function addModel(choice: ModelChoice) {
    const token = generation.current;
    try { const detail = await request<RevisionDetail>(`sources/revisions/${choice.source_revision_id}`);
      if (!active(token)) return;
      setForm(prior => {
        if (!prior || !prior.targets.some(t => t.local_id === modelTarget)) return prior;
        const existing = prior.sources.find(s => s.source_revision_id === choice.source_revision_id);
        const source = existing ?? pinSource(detail, prior, detail.manifest.files.filter(f => f.path === choice.path));
        const selected = detail.manifest.files.find(f => f.path === choice.path);
        if (!selected) return prior;
        const files = source.files.some(f => f.path === choice.path) ? source.files : [...source.files, { path: selected.path, sha256: selected.sha256, rights: selected.rights, role: 'model' as const, format: 'other' as const }];
        const model: ModelPin = { local_id: keyFor('model', prior.models), representation_id: choice.representation_id,
          revision_id: choice.revision_id, snapshot_sha256: choice.snapshot_sha256, source_local_id: source.local_id, path: choice.path,
          target_local_id: modelTarget, purpose: 'illustration', units: null, frame: null, accuracy: null, basis: 'Declared model/target correspondence' };
        return { ...prior, sources: [...prior.sources.filter(s => s.local_id !== source.local_id), { ...source, files: files.map(f => f.path === choice.path ? { ...f, role: 'model' as const } : f) }], models: [...prior.models, model] };
      });
    } catch (reason) { if (active(token)) failed(reason); }
  }
  async function save() {
    if (!form) return;
    const token = generation.current; setBusy(true); setMessage('');
    const updating = !!read?.draft_id;
    const payload = updating ? { draft_id: read!.draft_id, mechanical_source: form } : { workspace_id: workspaceId, name, mechanical_source: form };
    const fingerprint = JSON.stringify({ payload, state: read?.state });
    if (pendingSave.current?.fingerprint !== fingerprint) pendingSave.current = { fingerprint, key: randomUUID() };
    try {
      const result = await command<{ draft_id: string }>(updating ? 'mechanical_source.update' : 'mechanical_source.create', payload,
        { expectedState: updating ? read!.state! : undefined, idempotencyKey: pendingSave.current.key });
      if (active(token)) await open(`mechanical-sources/drafts/${result.draft_id}`);
    } catch (reason) { if (active(token)) failed(reason); }
    finally { if (active(token)) setBusy(false); }
  }
  async function freeze() {
    if (!read?.draft_id || !read.state) return;
    const token = generation.current; setBusy(true);
    try { const result = await command<{ revision_id: string }>('mechanical_source.freeze', { draft_id: read.draft_id }, { expectedState: read.state });
      if (active(token)) await open(`mechanical-sources/revisions/${result.revision_id}`);
    } catch (reason) { if (active(token)) failed(reason); }
    finally { if (active(token)) setBusy(false); }
  }
  const edit = permissions.includes('design.edit');
  function changeTarget(id: string, changes: Partial<TargetPin>) { setForm(prior => prior ? { ...prior, targets: prior.targets.map(t => t.local_id === id ? { ...t, ...changes } : t) } : prior); }
  function changeModel(id: string, changes: Partial<ModelPin>) { setForm(prior => prior ? { ...prior, models: prior.models.map(m => m.local_id === id ? { ...m, ...changes } : m) } : prior); }
  return <Stack>
    <Title order={3}>Mechanical sources</Title>
    <Text size="sm">Preserve native enclosure, part and hardware files in Sources, then pin exact originals or derivatives and board/component revisions here. File formats and model quality are declarations.</Text>
    <Group><Button variant="default" onClick={() => void refresh()}>Refresh mechanical sources</Button>
      {shown && edit && <Button onClick={() => { generation.current += 1; setRead(null); setForm(blank()); setName(''); setBusy(false); setMessage(''); setModelRevision(null); pendingSave.current = null; }}>New mechanical source</Button>}</Group>
    {message && <Alert color="red">{message}</Alert>}
    {!shown && <Alert color="yellow">Source or target access is unavailable. Declarations are hidden until an explicit refresh verifies current authority.</Alert>}
    {shown && <>
      {records.records.map(record => <Card withBorder key={record.definition_id}><Group><Text>{record.name}</Text>
        {record.drafts.map(draft => <Button key={draft.draft_id} size="xs" variant="default" onClick={() => void open(`mechanical-sources/drafts/${draft.draft_id}`)}>Open draft</Button>)}
        {record.revisions.map(revision => <Button key={revision.revision_id} size="xs" variant="subtle" onClick={() => void open(`mechanical-sources/revisions/${revision.revision_id}`)}>Revision {revision.number}</Button>)}
      </Group></Card>)}
      {records.next_after && <Button variant="subtle" onClick={() => void more('records')}>More mechanical records</Button>}
      {read && <Card withBorder><Stack><Title order={4}>{read.name}{read.revision_number ? ` revision ${read.revision_number}` : ' draft'}</Title><Text size="xs">{read.revision_id ? <RevisionLabel id={read.revision_id} sha256={read.snapshot_sha256} extraPins={[{ label: 'Definition ID', value: read.definition_id }]} /> : <>Draft · state {read.state} <ExactPins pins={[{ label: 'Definition ID', value: read.definition_id }]} /></>}</Text><MechanicalEvaluation read={read} />
        {edit && read.draft_id && !form && <Button onClick={() => { generation.current += 1; setBusy(false); setForm(structuredClone(read.content.mechanical_source)); pendingSave.current = null; }}>Edit mechanical draft</Button>}
        {permissions.includes('design.freeze') && read.draft_id && !form && <Button disabled={busy || read.evaluation.readiness === 'blocked'} onClick={() => void freeze()}>Freeze mechanical declarations</Button>}
      </Stack></Card>}
      {edit && form && <Stack>
        {!read?.draft_id && <TextInput label="Mechanical source name" value={name} onChange={e => setName(e.currentTarget.value)} />}
        <Select label="Mechanical item role" value={form.item_role} data={['enclosure', 'part', 'hardware']} onChange={value => value && setForm({ ...form, item_role: value as MechanicalSource['item_role'] })} />
        <TextInput label="Exact source file path (optional)" description="Leave empty to pin all files in a bundle of up to 200 files. Set one package-relative path to add only that file." value={sourcePath} onChange={e => setSourcePath(e.currentTarget.value)} />
        <Select label="Preserved source revision" data={sources.revisions.map(s => ({ value: s.revision_id, label: `${s.name} revision ${s.number} (${s.role})` }))} onChange={value => value && void addSource(value)} value={null} searchable />
        {sources.next_after && <Button variant="subtle" onClick={() => void more('sources')}>More source revisions</Button>}
        <Group align="end"><TextInput label="Exact accessible source revision ID" value={sourceId} onChange={e => setSourceId(e.currentTarget.value)} /><Button disabled={!sourceId} onClick={() => void addSource(sourceId)}>Add exact source</Button></Group>
        {form.sources.map(source => <Card withBorder key={source.local_id}><Stack gap="xs"><Text>{source.local_id} · <RevisionLabel kind="source" id={source.source_revision_id} /> · manifest {source.source_manifest_sha256}</Text>
          {source.files.map(file => <Group key={file.path} align="end"><Text size="sm">{file.path} · rights {file.rights}</Text>
            <Select label={`Role for ${source.local_id}/${file.path}`} data={roleOptions} value={file.role} onChange={value => value && setForm(prior => prior ? { ...prior, sources: prior.sources.map(s => s.local_id === source.local_id ? { ...s, files: s.files.map(f => f.path === file.path ? { ...f, role: value as MechanicalFile['role'] } : f) } : s) } : prior)} />
            <Select label={`Format for ${source.local_id}/${file.path}`} data={formats} value={file.format} onChange={value => value && setForm(prior => prior ? { ...prior, sources: prior.sources.map(s => s.local_id === source.local_id ? { ...s, files: s.files.map(f => f.path === file.path ? { ...f, format: value as MechanicalFile['format'] } : f) } : s) } : prior)} />
            <Button size="xs" variant="subtle" disabled={form.models.some(m => m.source_local_id === source.local_id && m.path === file.path)} onClick={() => setForm(prior => prior ? { ...prior, sources: prior.sources.map(s => s.local_id === source.local_id ? { ...s, files: s.files.filter(f => f.path !== file.path) } : s).filter(s => s.files.length) } : prior)}>Unpin file</Button>
          </Group>)}
        </Stack></Card>)}
        <Select label="Exact board, component or hardware revision" data={targets.targets.map(t => ({ value: t.revision_id, label: `${t.name} revision ${t.number} (${t.kind})` }))} value={null} searchable onChange={value => value && void addTarget(value)} />
        {targets.next_after && <Button variant="subtle" onClick={() => void more('targets')}>More target revisions</Button>}
        <Group align="end"><TextInput label="Exact accessible target revision ID" value={targetId} onChange={e => setTargetId(e.currentTarget.value)} /><Button disabled={!targetId} onClick={() => void addTarget(targetId)}>Add exact target</Button></Group>
        {form.targets.map(target => { const detail = targets.targets.find(t => t.revision_id === target.revision_id); return <Card withBorder key={target.local_id}><Stack gap="xs"><Text>{target.local_id} · <RevisionLabel id={target.revision_id} snapshotId={target.snapshot_sha256} /></Text>
          <Select label={`Target role for ${target.local_id}`} value={target.role} data={target.board ? ['board', 'component'] : ['board', 'component', 'hardware']} onChange={value => value && changeTarget(target.local_id, { role: value as TargetPin['role'], native_component_id: null })} />
          <TextInput label={`Target basis for ${target.local_id}`} value={target.basis} onChange={e => changeTarget(target.local_id, { basis: e.currentTarget.value })} />
          {target.board && <Select label={`Board option for ${target.local_id}`} clearable value={target.board.option_id} data={detail?.board?.options.map(o => ({ value: o.local_id, label: o.name })) ?? []} onChange={value => changeTarget(target.local_id, { board: { ...target.board!, option_id: value } })} />}
          {target.board && target.role === 'component' && <Select label={`Native component for ${target.local_id}`} clearable value={target.native_component_id} data={detail?.components.map(c => ({ value: c.id, label: `${c.reference}: ${c.value}` })) ?? []} onChange={value => changeTarget(target.local_id, { native_component_id: value })} />}
          <Button variant="subtle" disabled={form.models.some(m => m.target_local_id === target.local_id) || Object.values(form.uncertainty ?? {}).some(rows => rows.some((r: { target_local_id: string | null }) => r.target_local_id === target.local_id))} onClick={() => setForm({ ...form, targets: form.targets.filter(t => t.local_id !== target.local_id) })}>Unpin target</Button>
        </Stack></Card>; })}
        <Select label="Model owning revision" searchable value={modelId || null} data={targets.targets.map(t => ({ value: t.revision_id, label: `${t.name} revision ${t.number}` }))} onChange={value => { setModelId(value ?? ''); if (value) void inspectModel(value); }} />
        <Select label="Model applies to target" value={modelTarget || null} data={form.targets.map(t => ({ value: t.local_id, label: t.local_id }))} onChange={value => setModelTarget(value ?? '')} />
        {modelRevision?.models.map(model => <Button key={model.representation_id} variant="default" disabled={!modelTarget} onClick={() => void addModel(model)}>Pin model {model.label}</Button>)}
        {modelRevision?.models_truncated && <Alert>Only the first 100 models are listed for this revision.</Alert>}
        {form.models.map(model => <Card withBorder key={model.local_id}><Stack gap="xs"><Text>{model.local_id} · representation {model.representation_id} · target {model.target_local_id}</Text>
          <Select label={`Geometry purpose for ${model.local_id}`} data={['manufacturing', 'clearance', 'illustration']} value={model.purpose} onChange={value => value && changeModel(model.local_id, { purpose: value as ModelPin['purpose'] })} />
          <Select label={`Model units for ${model.local_id}`} data={['mm', 'm', 'in']} clearable value={model.units} onChange={value => changeModel(model.local_id, { units: value as ModelPin['units'] })} />
          <TextInput label={`Model frame for ${model.local_id}`} value={model.frame ?? ''} placeholder="Unknown" onChange={e => changeModel(model.local_id, { frame: nullable(e.currentTarget.value) })} />
          <TextInput label={`Model accuracy for ${model.local_id}`} value={model.accuracy ?? ''} placeholder="Unknown" onChange={e => changeModel(model.local_id, { accuracy: nullable(e.currentTarget.value) })} />
          <TextInput label={`Model correspondence basis for ${model.local_id}`} value={model.basis} onChange={e => changeModel(model.local_id, { basis: e.currentTarget.value })} />
          <Button variant="subtle" disabled={form.uncertainty?.tolerances.some(t => t.model_local_id === model.local_id)} onClick={() => setForm({ ...form, models: form.models.filter(m => m.local_id !== model.local_id) })}>Unpin model</Button>
        </Stack></Card>)}
        <MechanicalUncertaintyEditor source={form} onChange={uncertainty => setForm({ ...form, uncertainty })} />
        <Textarea label="Mechanical limitations, one per line" value={form.limitations.join('\n')} onChange={e => setForm({ ...form, limitations: e.currentTarget.value.split('\n').filter(Boolean) })} />
        <Group><Button disabled={busy || !form.sources.length || (!read?.draft_id && !name.trim())} onClick={() => void save()}>Save mechanical draft</Button>
          <Button variant="default" onClick={() => { generation.current += 1; setForm(null); setBusy(false); pendingSave.current = null; }}>Cancel mechanical edit</Button></Group>
      </Stack>}
    </>}
  </Stack>;
}
