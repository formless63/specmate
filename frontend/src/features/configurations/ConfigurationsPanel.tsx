import { Alert, Badge, Button, Card, Group, NativeSelect, Stack, Table, Text, TextInput, Textarea, Title } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { randomUUID } from '../../lib/random-id';
import { ReadOnlyNote, usePermission } from '../../lib/permissions';
import { command, read, type Definition, type Identity } from '../identity/api';
import { operation, type BuildInput, type Decision, type DraftResolution, type Selection, type Submission } from './api';

const NONE = '__none__';
const STATUS_COLOR: Record<string, string> = { resolved: 'green', complete: 'green', none: 'blue', unresolved: 'yellow', incomplete: 'yellow', invalid: 'red' };
const SOURCE: Record<Decision['source'], string> = { selected: 'Selected', default: 'Option-set default', explicit_none: 'Explicitly none', not_selected: 'Not selected' };

export function ConfigurationsPanel({ projectId }: { projectId: string }) {
  return <Workspace key={projectId} projectId={projectId} />;
}

function Workspace({ projectId }: { projectId: string }) {
  const [definitions, setDefinitions] = useState<Definition[]>([]);
  const [definition, setDefinition] = useState('');
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [draftId, setDraftId] = useState('');
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    read<Definition[]>(`projects/${projectId}/definitions`)
      .then((items) => { if (active) setDefinitions(items); })
      .catch((failure: Error) => { if (active) { setDefinitions([]); setError(failure.message); } });
    return () => { active = false; };
  }, [projectId, reload]);
  useEffect(() => {
    let active = true;
    setIdentity(null); setDraftId('');
    if (definition) read<Identity>(`catalog/definitions/${definition}`)
      .then((data) => { if (active) setIdentity(data); })
      .catch((failure: Error) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [definition]);
  const configurations = definitions.filter((item) => item.kind === 'configuration');
  return <Card withBorder><Stack>
    <Title order={3}>Options and resolved choices</Title>
    <Text size="sm">A configuration pins one frozen option set. Resolution turns explicit selections and declared defaults into exact pinned choices; a build consumes only a captured resolved snapshot. Compatibility between choices is not evaluated here.</Text>
    {error && <Alert color="red">{error}</Alert>}
    <NativeSelect label="Configuration" value={definition} data={[{ value: '', label: configurations.length ? 'Select a configuration' : 'No configurations in this project' }, ...configurations.map((item) => ({ value: item.definition_id, label: item.name }))]} onChange={(event) => setDefinition(event.currentTarget.value)} />
    {identity && <NativeSelect label="Configuration draft" value={draftId} data={[{ value: '', label: 'Select a draft' }, ...identity.drafts.map((item) => ({ value: item.draft_id, label: `Draft ${item.draft_id.slice(0, 8)} · ${item.state}` }))]} onChange={(event) => setDraftId(event.currentTarget.value)} />}
    {draftId && <DraftWorkspace key={draftId} draftId={draftId} />}
    <CreateConfiguration projectId={projectId} optionSets={definitions.filter((item) => item.kind === 'option_set')} onCreated={(id) => { setReload((value) => value + 1); setDefinition(id); }} />
  </Stack></Card>;
}

function CreateConfiguration({ projectId, optionSets, onCreated }: { projectId: string; optionSets: Definition[]; onCreated: (definitionId: string) => void }) {
  const edit = usePermission('design.edit');
  const [optionSet, setOptionSet] = useState('');
  const [revisions, setRevisions] = useState<Identity['revisions']>([]);
  const [revision, setRevision] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setRevisions([]); setRevision('');
    if (optionSet) read<Identity>(`catalog/definitions/${optionSet}`).then((data) => { if (active) setRevisions(data.revisions); }).catch((failure: Error) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [optionSet]);
  async function create() {
    setBusy(true); setError('');
    try {
      const result = await command<{ definition_id: string }>('definition.create', { project_id: projectId, kind: 'configuration', name: name.trim(),
        content: { configuration: { option_set_revision_id: revision, selections: [] } } });
      setName(''); onCreated(result.definition_id);
    } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  }
  return <Stack gap="xs">
    <Title order={4}>New configuration</Title>
    <ReadOnlyNote permission="design.edit" />
    {error && <Alert color="red">{error}</Alert>}
    <Group align="end">
      <NativeSelect label="Option set" value={optionSet} data={[{ value: '', label: optionSets.length ? 'Select an option set' : 'No option sets in this project' }, ...optionSets.map((item) => ({ value: item.definition_id, label: item.name }))]} onChange={(event) => setOptionSet(event.currentTarget.value)} />
      <NativeSelect label="Frozen option-set revision" value={revision} data={[{ value: '', label: 'Select an exact revision' }, ...revisions.map((item) => ({ value: item.revision_id, label: `Revision ${item.number}` }))]} onChange={(event) => setRevision(event.currentTarget.value)} />
      <TextInput label="Configuration name" value={name} onChange={(event) => setName(event.currentTarget.value)} />
      <Button {...edit.props} disabled={!edit.allowed || !revision || !name.trim() || busy} onClick={() => { void create(); }}>Create configuration</Button>
    </Group>
  </Stack>;
}

function selectionMap(selections: Selection[]): Record<string, string> {
  return Object.fromEntries(selections.map((item) => [item.option_key, item.choice_key ?? NONE]));
}

function DraftWorkspace({ draftId }: { draftId: string }) {
  const edit = usePermission('design.edit');
  const generation = useRef(0);
  const [preview, setPreview] = useState<DraftResolution | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [basis, setBasis] = useState('');
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [buildInput, setBuildInput] = useState<BuildInput | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function refresh() {
    const token = ++generation.current;
    setBusy(true); setError('');
    try {
      const result = await operation<DraftResolution>('configuration.resolve', { draft_id: draftId });
      if (token !== generation.current) return;
      setPreview(result); setEdits(selectionMap(result.configuration.selections)); setDirty(false);
    } catch (failure) { if (token === generation.current) { setPreview(null); setError((failure as Error).message); } }
    finally { if (token === generation.current) setBusy(false); }
  }
  useEffect(() => { void refresh(); return () => { generation.current++; }; }, []); // A new draft remounts this workspace.
  async function save() {
    if (!preview) return;
    const declared = new Set(preview.available.map((item) => item.option_key));
    const selections = Object.entries(edits).filter(([key, value]) => value !== '' && declared.has(key))
      .map(([option_key, value]) => ({ option_key, choice_key: value === NONE ? null : value }));
    setBusy(true); setError('');
    try {
      await operation('draft.update', { draft_id: draftId, changes: { configuration: { ...preview.configuration, selections } } }, { state: preview.state });
      setSubmission(null); await refresh();
    } catch (failure) { setError((failure as Error).message); setBusy(false); }
  }
  async function capture(retry = false) {
    if (!preview) return;
    const request = retry && submission ? submission : { payload: { draft_id: draftId, review_sha256: preview.review_sha256, basis }, state: preview.state, key: randomUUID() };
    setSubmission(request); setBusy(true); setError('');
    try {
      await operation('configuration.capture', request.payload, request);
      setSubmission(null); setBasis(''); await refresh();
    } catch (failure) { setError((failure as Error).message); setBusy(false); }
  }
  async function inspect(id: string) {
    setBuildInput(null); setError('');
    try { setBuildInput(await operation<BuildInput>('configuration.build_input', { resolved_configuration_id: id })); }
    catch (failure) { setError((failure as Error).message); }
  }
  const resolution = preview?.resolution;
  return <Stack>
    {error && <Alert color="red">{error}</Alert>}
    <Group><Button variant="quiet" disabled={busy} onClick={() => { void refresh(); }}>Refresh resolution</Button></Group>
    {preview && resolution && <>
      <dl className="sb-meter" style={{ display: 'flex', gap: 24, margin: 0, flexWrap: 'wrap' }}>
        <div><dt className="sb-silk">Resolution</dt><dd style={{ margin: 0 }}><Badge variant="outline" color={STATUS_COLOR[resolution.status]}>{resolution.status}</Badge></dd></div>
        <div><dt className="sb-silk">Draft</dt><dd style={{ margin: 0 }}><Badge variant="draft">{preview.state}</Badge></dd></div>
        <div><dt className="sb-silk">Option set</dt><dd style={{ margin: 0 }}><Badge variant="frozen">{resolution.option_set.name} · rev {resolution.option_set.number}</Badge></dd></div>
        <div><dt className="sb-silk">Target</dt><dd style={{ margin: 0 }}>{resolution.target ? <Badge variant="frozen">{resolution.target.name} · rev {resolution.target.number}</Badge> : <Text size="sm">None</Text>}</dd></div>
        <div><dt className="sb-silk">Unresolved</dt><dd style={{ margin: 0, fontFamily: 'var(--sb-font-data)' }}>{resolution.counts.unresolved}</dd></div>
        <div><dt className="sb-silk">Compatibility</dt><dd style={{ margin: 0 }}><Text size="sm">Not evaluated</Text></dd></div>
      </dl>
      <Table>
        <Table.Thead><Table.Tr><Table.Th>Option</Table.Th><Table.Th>Occurrence</Table.Th><Table.Th>Selection</Table.Th><Table.Th>Decision</Table.Th><Table.Th>Exact pin or value</Table.Th><Table.Th>Reason</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{resolution.decisions.map((decision) => {
          const options = preview.available.find((item) => item.option_key === decision.option_key);
          return <Table.Tr key={decision.option_key}>
            <Table.Td><Text size="sm">{decision.label}</Text><Text className="sb-silk">{decision.domain}{decision.required ? '' : ' · optional'}</Text></Table.Td>
            <Table.Td>{decision.path ? <Badge variant="occurrence">{decision.path.join('/')}</Badge> : <Text size="sm">Whole configuration</Text>}</Table.Td>
            <Table.Td><NativeSelect aria-label={`Selection for ${decision.label}`} disabled={!edit.allowed || busy} value={edits[decision.option_key] ?? ''}
              data={[{ value: '', label: options?.default_choice ? 'Use declared default' : 'No selection' }, ...(decision.required ? [] : [{ value: NONE, label: 'Explicitly none' }]), ...(options?.choices ?? []).map((choice) => ({ value: choice.key, label: choice.label }))]}
              onChange={(event) => { const value = event.currentTarget.value; setEdits((current) => ({ ...current, [decision.option_key]: value })); setDirty(true); }} /></Table.Td>
            <Table.Td><Badge variant="outline" color={STATUS_COLOR[decision.status]}>{decision.status}</Badge><Text className="sb-silk">{SOURCE[decision.source]}</Text></Table.Td>
            <Table.Td style={{ fontFamily: 'var(--sb-font-data)' }}>{decision.choice ? (decision.choice.revision
              ? <>{decision.choice.revision.name} · rev {decision.choice.revision.number}{decision.choice.population_option_id ? ` · option ${decision.choice.population_option_id}` : ''}<br />{decision.choice.revision.snapshot_sha256.slice(0, 12)}</>
              : decision.choice.value) : '-'}
              {decision.base && <><br /><Text span className="sb-silk">Base population {decision.base.population_revision_id.slice(0, 8)} · firmware {decision.base.firmware_revision_id?.slice(0, 8) ?? 'unassigned'}</Text></>}</Table.Td>
            <Table.Td><Text size="sm">{decision.reason}</Text></Table.Td>
          </Table.Tr>;
        })}</Table.Tbody>
      </Table>
      {resolution.invalid_selections.map((item) => <Alert key={item.option_key} color="red">{item.option_key}: {item.reason}</Alert>)}
      <ReadOnlyNote permission="design.edit" />
      <Group><Button {...edit.props} disabled={!edit.allowed || !dirty || busy} onClick={() => { void save(); }}>Save selections</Button>
        {dirty && <Text size="sm">Unsaved selections are not resolved or captured. Saving drops selections for undeclared options.</Text>}</Group>
      <Textarea label="Capture basis" disabled={!edit.allowed || busy} value={basis} onChange={(event) => { setBasis(event.currentTarget.value); setSubmission(null); }} />
      <Group><Button variant="commit" {...edit.props} disabled={!edit.allowed || dirty || busy || resolution.status === 'invalid' || !basis.trim()} onClick={() => { void capture(); }}>Capture resolved snapshot</Button>
        {submission && <Button variant="quiet" {...edit.props} disabled={!edit.allowed || busy} onClick={() => { void capture(true); }}>Retry capture</Button>}</Group>
      {resolution.status === 'incomplete' && <Text size="sm">An incomplete snapshot may be captured as review evidence; builds refuse it until every required option resolves.</Text>}
      <Title order={4}>Resolved snapshots</Title>
      {preview.resolved.length === 0 && <Text size="sm">No resolved snapshot captured for this draft.</Text>}
      {preview.resolved.map((item) => <Group key={item.resolved_configuration_id}>
        <Badge variant="frozen">{item.resolution_sha256.slice(0, 12)}</Badge><Badge variant="outline" color={STATUS_COLOR[item.status]}>{item.status}</Badge>
        <Text size="sm">{item.basis}</Text>
        <Button variant="quiet" onClick={() => { void inspect(item.resolved_configuration_id); }}>Inspect build input</Button>
      </Group>)}
      {preview.history_truncated && <Text size="sm">Only the latest 100 resolved snapshots are listed.</Text>}
      {buildInput && <Card withBorder><Stack gap="xs">
        <Text className="sb-silk">Build input · snapshot {buildInput.snapshot_sha256.slice(0, 16)}</Text>
        {buildInput.choices.map((choice) => <Text key={choice.option_key} size="sm" style={{ fontFamily: 'var(--sb-font-data)' }}>{choice.option_key} = {choice.revision_id ?? choice.value ?? 'none'} ({choice.source})</Text>)}
        <Text className="sb-silk">{buildInput.pins.length} exact revision pins</Text>
      </Stack></Card>}
    </>}
  </Stack>;
}
