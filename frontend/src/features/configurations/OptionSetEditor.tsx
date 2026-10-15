import { Alert, Badge, Button, Checkbox, Group, NativeSelect, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { randomUUID } from '../../lib/random-id';
import { InspectionScope, ReadOnlyNote, usePermission } from '../../lib/permissions';
import { definitionIn, useOpenProbed } from '../scope/openProbed';
import { addProjectReference, command, libraryDefinitions, read, type Definition, type Identity } from '../identity/api';
import { operation, type AuthoringContext, type Described } from './api';
import { ConstraintEditor } from './ConstraintEditor';
import {
  blankChoice, blankConstraint, blankOption, DOMAIN_KINDS, DOMAINS, EXCLUDED_KINDS, OCCURRENCE_DOMAINS, parseOptionSet, REVISION_DOMAINS, serializeOptionSet, validateOptionSet,
  type ChoiceBody, type Domain, type OptionBody, type OptionSetBody,
} from './optionSet';

type Revisions = Identity['revisions'];
type Occurrence = NonNullable<AuthoringContext['target']>['occurrences'][number];

/** Option-set authoring: declare options and their exact choices on a draft, then freeze it. */
/** Option-set authoring. `projectId` is optional context: "Use in this project" is offered only with one. */
export function OptionSetAuthoring({ projectId = null, definitions, onCreated }: { projectId?: string | null; definitions: Definition[]; onCreated: () => void }) {
  const create = usePermission('item.create');
  const [definition, setDefinition] = useState('');
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [draftId, setDraftId] = useState('');
  const [name, setName] = useState('');
  const [useHere, setUseHere] = useState(true);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => { setIdentity(null); setDraftId(''); }, [definition]);
  useEffect(() => {
    let active = true;
    // A refresh after freezing keeps the open draft; choosing another set resets it.
    if (definition) read<Identity>(`catalog/definitions/${definition}`)
      .then((data) => { if (active) { setIdentity(data); setDraftId((current) => data.drafts.some((item) => item.draft_id === current) ? current : data.drafts[0]?.draft_id ?? ''); } })
      .catch((failure: Error) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [definition, reload]);
  async function createSet() {
    setBusy(true); setError(''); setNote('');
    try {
      // New option sets join the workspace library; a project reference is optional context.
      const { workspace_id } = await libraryDefinitions(projectId);
      const result = await command<{ definition_id: string }>('definition.create', { workspace_id, kind: 'option_set', name: name.trim(), content: serializeOptionSet(parseOptionSet(null)) });
      if (projectId && useHere) {
        try { await addProjectReference(projectId, 'definition', result.definition_id, 'option_set'); }
        catch (failure) { setNote(`Created in the library, but not added to this project: ${(failure as Error).message}`); }
      }
      setName(''); onCreated(); setDefinition(result.definition_id);
    } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  }
  const optionSets = definitions.filter((item) => item.kind === 'option_set');
  useOpenProbed(definitions.length ? definitionIn(definitions, ['option_set']) : null, setDefinition);
  return <Stack gap="sm">
    <Title order={4}>Option sets</Title>
    <Text size="sm">Declare options for parts, board populations, firmware, materials, processes and requirements. Each choice pins one exact frozen revision or declares one value; occurrence options address a path of an exact target assembly revision. Freeze the option set before a configuration can pin it.</Text>
    {error && <Alert color="red">{error}</Alert>}
    {note && <Alert color="yellow">{note}</Alert>}
    <Group align="end">
      <NativeSelect label="Option set to edit" value={definition} data={[{ value: '', label: optionSets.length ? 'Select an option set' : 'No option sets in the library' }, ...optionSets.map((item) => ({ value: item.definition_id, label: item.name }))]} onChange={(event) => setDefinition(event.currentTarget.value)} />
      {identity && <NativeSelect label="Option-set draft" value={draftId} data={[{ value: '', label: identity.drafts.length ? 'Select a draft' : 'No editable draft' }, ...identity.drafts.map((item) => ({ value: item.draft_id, label: `Draft ${item.draft_id.slice(0, 8)} · ${item.state}` }))]} onChange={(event) => setDraftId(event.currentTarget.value)} />}
      {identity && <Text size="sm">{identity.revisions.length ? `Frozen revisions: ${identity.revisions.map((item) => item.number).join(', ')}` : 'No frozen revision yet'}</Text>}
    </Group>
    <InspectionScope permission="item.create"><Group align="end">
      <TextInput label="New option set name" value={name} onChange={(event) => setName(event.currentTarget.value)} />
      {projectId && <Checkbox label="Use in this project" checked={useHere} onChange={(event) => setUseHere(event.currentTarget.checked)} />}
      <Button {...create.props} disabled={!create.allowed || !name.trim() || busy} onClick={() => { void createSet(); }}>Create option set</Button>
    </Group></InspectionScope>
    <ReadOnlyNote permission="item.create" />
    {draftId && <OptionSetDraftEditor key={draftId} draftId={draftId} definitions={definitions} onFrozen={() => setReload((value) => value + 1)} />}
  </Stack>;
}

function OptionSetDraftEditor({ draftId, definitions, onFrozen }: { draftId: string; definitions: Definition[]; onFrozen: () => void }) {
  const edit = usePermission('design.edit');
  const freeze = usePermission('design.freeze');
  const generation = useRef(0);
  const [body, setBody] = useState<OptionSetBody | null>(null);
  const [state, setState] = useState('');
  const [dirty, setDirty] = useState(false);
  const [context, setContext] = useState<AuthoringContext['target']>(null);
  const [targetDefinition, setTargetDefinition] = useState('');
  const [described, setDescribed] = useState<Record<string, Described>>({});
  const [revisionLists, setRevisionLists] = useState<Record<string, Revisions>>({});
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(false);

  async function describe(revisionIds: string[], target?: string | null) {
    const unique = [...new Set(revisionIds)].filter((id) => id && !described[id]);
    const requests: Promise<AuthoringContext>[] = [];
    for (let start = 0; start < unique.length; start += 100) requests.push(operation<AuthoringContext>('configuration.authoring_context', { revision_ids: unique.slice(start, start + 100) }));
    if (target !== undefined) requests.push(operation<AuthoringContext>('configuration.authoring_context', { target_revision_id: target, revision_ids: [] }));
    const results = await Promise.all(requests);
    setDescribed((current) => ({ ...current, ...Object.fromEntries(results.flatMap((item) => item.revisions).map((item) => [item.revision_id, item])) }));
    if (target !== undefined) {
      const found = results[results.length - 1]?.target ?? null;
      setContext(found);
      if (found) setTargetDefinition(found.definition_id);
    }
  }
  async function load() {
    const token = ++generation.current;
    setBusy(true); setError(''); setMessage('');
    try {
      const draft = await read<{ content: unknown; state: string }>(`drafts/${draftId}`);
      if (token !== generation.current) return;
      const parsed = parseOptionSet(draft.content);
      setBody(parsed); setState(draft.state); setDirty(false); setChecked(false); setContext(null);
      const ids = parsed.options.flatMap((o) => o.choices.map((c) => c.revision_id ?? '')).filter(Boolean);
      await describe(ids, parsed.target_revision_id ?? undefined);
    } catch (failure) { if (token === generation.current) setError((failure as Error).message); }
    finally { if (token === generation.current) setBusy(false); }
  }
  useEffect(() => { void load(); return () => { generation.current++; }; }, []); // A new draft remounts this editor.
  async function revisionsOf(definitionId: string) {
    if (!definitionId || revisionLists[definitionId]) return;
    try {
      const identity = await read<Identity>(`catalog/definitions/${definitionId}`);
      setRevisionLists((current) => ({ ...current, [definitionId]: identity.revisions }));
    } catch (failure) { setError((failure as Error).message); }
  }
  useEffect(() => { void revisionsOf(targetDefinition); }, [targetDefinition]);

  function change(next: OptionSetBody) { setBody(next); setDirty(true); setChecked(true); setMessage(''); }
  function updateOption(index: number, option: OptionBody) {
    if (!body) return;
    change({ ...body, options: body.options.map((item, position) => position === index ? option : item) });
  }
  async function chooseTarget(revisionId: string) {
    if (!body) return;
    change({ ...body, target_revision_id: revisionId || null });
    setContext(null);
    if (revisionId) {
      try { await describe([], revisionId); } catch (failure) { setError((failure as Error).message); }
    }
  }
  async function save() {
    if (!body) return;
    setChecked(true);
    if (validateOptionSet(body).length) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await operation<{ state: string }>('draft.update', { draft_id: draftId, changes: serializeOptionSet(body) }, { state });
      setState(result.state); setDirty(false); setMessage('Saved option-set draft.');
    } catch (failure) {
      // Unsaved edits stay in the editor; a conflict is resolved by reloading deliberately.
      setError(`${(failure as Error).message} Your unsaved edits are kept.`);
    } finally { setBusy(false); }
  }
  async function freezeDraft() {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await operation<{ number: number; draft: { state: string } }>('draft.freeze', { draft_id: draftId }, { state, key: randomUUID() });
      setState(result.draft.state); setMessage(`Frozen as option-set revision ${result.number}. Configurations pin that exact revision.`); onFrozen();
    } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  }

  if (!body) return <Stack>{error && <Alert color="red">{error}</Alert>}{busy && <Text size="sm" role="status">Loading option set…</Text>}</Stack>;
  const problems = validateOptionSet(body);
  const assemblies = definitions.filter((item) => item.kind === 'assembly');
  const targetRevisions = revisionLists[targetDefinition] ?? [];
  return <Stack gap="sm">
    {error && <Alert color="red">{error}</Alert>}
    {message && <Alert color="green">{message}</Alert>}
    <dl className="sb-meter" style={{ display: 'flex', gap: 24, margin: 0, flexWrap: 'wrap' }}>
      <div><dt className="sb-silk">Draft</dt><dd style={{ margin: 0 }}><Badge variant="draft">{state}</Badge></dd></div>
      <div><dt className="sb-silk">Options</dt><dd style={{ margin: 0, fontFamily: 'var(--sb-font-data)' }}>{body.options.length}</dd></div>
      <div><dt className="sb-silk">Target</dt><dd style={{ margin: 0 }}>{context ? <Badge variant="frozen">{context.name} · rev {context.number}</Badge> : body.target_revision_id ? <Text size="sm">Not described</Text> : <Text size="sm">None</Text>}</dd></div>
      <div><dt className="sb-silk">Edits</dt><dd style={{ margin: 0 }}><Text size="sm">{dirty ? 'Unsaved' : 'Saved'}</Text></dd></div>
    </dl>
    <InspectionScope permission="design.edit">
    <Group align="end">
      <NativeSelect label="Target assembly" disabled={busy} value={targetDefinition} data={[{ value: '', label: 'No target assembly' }, ...assemblies.map((item) => ({ value: item.definition_id, label: item.name }))]}
        onChange={(event) => { const value = event.currentTarget.value; setTargetDefinition(value); if (!value) void chooseTarget(''); }} />
      {targetDefinition && <NativeSelect label="Exact target revision" disabled={busy} value={body.target_revision_id ?? ''}
        data={[{ value: '', label: 'Select a frozen revision' }, ...targetRevisions.map((item) => ({ value: item.revision_id, label: `Revision ${item.number}` }))]}
        onChange={(event) => { void chooseTarget(event.currentTarget.value); }} />}
    </Group>
    {body.options.map((option, index) => <OptionEditor key={index} option={option} disabled={busy} editable={edit.allowed} definitions={definitions} occurrences={context?.occurrences ?? []}
      described={described} revisionLists={revisionLists} onRevisions={(id) => { void revisionsOf(id); }} onDescribe={(id) => { void describe([id]).catch((failure: Error) => setError(failure.message)); }}
      onChange={(next) => updateOption(index, next)} onRemove={() => change({ ...body, options: body.options.filter((_, position) => position !== index) })} />)}
    {body.options.length === 0 && <Text size="sm">No options declared.</Text>}
    </InspectionScope>
    {edit.allowed && <Group><Button variant="quiet" disabled={busy} onClick={() => change({ ...body, options: [...body.options, blankOption(body)] })}>Add option</Button></Group>}
    <Title order={5}>Constraints</Title>
    <Text size="sm">Explicit rules evaluated at resolution as valid, invalid, unknown or not evaluated. A fact limit reads the chosen exact revision's recorded facts; a missing fact stays unknown, never compatible.</Text>
    <InspectionScope permission="design.edit">
    {body.constraints.map((rule, index) => <ConstraintEditor key={index} rule={rule} options={body.options} disabled={busy} editable={edit.allowed}
      onChange={(next) => change({ ...body, constraints: body.constraints.map((item, position) => position === index ? next : item) })}
      onRemove={() => change({ ...body, constraints: body.constraints.filter((_, position) => position !== index) })} />)}
    {body.constraints.length === 0 && <Text size="sm">No constraints declared.</Text>}
    </InspectionScope>
    {edit.allowed && <Group>
      <Button variant="quiet" disabled={busy || body.options.length < 2} onClick={() => change({ ...body, constraints: [...body.constraints, blankConstraint(body, 'requires')] })}>Add requires rule</Button>
      <Button variant="quiet" disabled={busy || body.options.length < 2} onClick={() => change({ ...body, constraints: [...body.constraints, blankConstraint(body, 'excludes')] })}>Add excludes rule</Button>
      <Button variant="quiet" disabled={busy || body.options.length === 0} onClick={() => change({ ...body, constraints: [...body.constraints, blankConstraint(body, 'fact_limit')] })}>Add fact limit</Button>
    </Group>}
    {checked && problems.length > 0 && <Alert color="yellow" title="Not yet valid"><Stack gap={2}>{problems.map((item) => <Text key={item} size="sm">{item}</Text>)}</Stack></Alert>}
    <ReadOnlyNote permission="design.edit" />
    <Group>
      <Button {...edit.props} disabled={!edit.allowed || busy || !dirty} onClick={() => { void save(); }}>Save option set</Button>
      <Button variant="quiet" disabled={busy} onClick={() => { void load(); }}>{dirty ? 'Discard edits and reload' : 'Reload'}</Button>
      <Button variant="commit" {...freeze.props} disabled={!freeze.allowed || busy || dirty || problems.length > 0} onClick={() => { void freezeDraft(); }}>Freeze option set</Button>
    </Group>
    <ReadOnlyNote permission="design.freeze" />
    {dirty && <Text size="sm">Save before freezing. Exact pins, target paths and population options are checked by the server on save.</Text>}
  </Stack>;
}

function occurrenceLabel(item: Occurrence) {
  return `${item.display_ref ? `${item.display_ref} · ` : ''}${item.path.join('/')} · ${item.revision.name} rev ${item.revision.number}`;
}

type OptionEditorProps = {
  option: OptionBody; disabled: boolean; editable: boolean; definitions: Definition[]; occurrences: Occurrence[]; described: Record<string, Described>; revisionLists: Record<string, Revisions>;
  onRevisions: (definitionId: string) => void; onDescribe: (revisionId: string) => void; onChange: (option: OptionBody) => void; onRemove: () => void;
};

function OptionEditor({ option, disabled, editable, definitions, occurrences, described, revisionLists, onRevisions, onDescribe, onChange, onRemove }: OptionEditorProps) {
  const occurrenceOnly = OCCURRENCE_DOMAINS.has(option.domain);
  const paths = occurrences.filter((item) => !occurrenceOnly || item.revision.kind === 'pcb_population');
  const path = option.path?.join('/') ?? '';
  const at = occurrences.find((item) => item.path.join('/') === path);
  const kind = DOMAIN_KINDS[option.domain];
  const candidates = definitions.filter((item) => (kind ? item.kind === kind : !EXCLUDED_KINDS.has(item.kind)));
  const label = option.label.trim() || option.key;
  function setChoice(index: number, choice: ChoiceBody) {
    onChange({ ...option, choices: option.choices.map((item, position) => position === index ? choice : item) });
  }
  function removeChoice(index: number) {
    const removed = option.choices[index]?.key;
    onChange({ ...option, default_choice: option.default_choice === removed ? null : option.default_choice, choices: option.choices.filter((_, position) => position !== index) });
  }
  return <fieldset style={{ border: '1px solid var(--sb-border-subtle)', padding: 'var(--mantine-spacing-xs)', margin: 0 }}>
    <legend className="sb-silk">{label}</legend>
    <Stack gap="xs">
      <Group align="end" gap="xs">
        <TextInput label="Key" aria-label={`Key of ${label}`} disabled={disabled} value={option.key} w={140} onChange={(event) => onChange({ ...option, key: event.currentTarget.value })} />
        <TextInput label="Label" aria-label={`Label of ${label}`} disabled={disabled} value={option.label} onChange={(event) => onChange({ ...option, label: event.currentTarget.value })} />
        <NativeSelect label="Domain" aria-label={`Domain of ${label}`} disabled={disabled} value={option.domain} data={DOMAINS} onChange={(event) => onChange({ ...option, domain: event.currentTarget.value as Domain })} />
        <NativeSelect label="Occurrence" aria-label={`Occurrence of ${label}`} disabled={disabled || occurrences.length === 0} value={path}
          data={[{ value: '', label: occurrences.length ? (occurrenceOnly ? 'Select an occurrence' : 'Whole configuration') : 'No target occurrences' }, ...paths.map((item) => ({ value: item.path.join('/'), label: occurrenceLabel(item) }))]}
          onChange={(event) => { const value = event.currentTarget.value; onChange({ ...option, path: value ? value.split('/') : null }); }} />
        <NativeSelect label="Default" aria-label={`Default of ${label}`} disabled={disabled} value={option.default_choice ?? ''} data={[{ value: '', label: 'No default' }, ...option.choices.map((choice) => ({ value: choice.key, label: choice.label || choice.key }))]}
          onChange={(event) => onChange({ ...option, default_choice: event.currentTarget.value || null })} />
        <Checkbox label="Required" disabled={disabled} checked={option.required} onChange={(event) => onChange({ ...option, required: event.currentTarget.checked })} />
        {editable && <Button variant="risk" disabled={disabled} onClick={onRemove}>Remove option</Button>}
      </Group>
      {at && <Text className="sb-silk">Base pin at this occurrence: {at.revision.name} rev {at.revision.number}{at.revision.kind === 'pcb_population' ? ` · firmware ${at.firmware_revision_id ? at.firmware_revision_id.slice(0, 8) : 'unassigned'}` : ''}</Text>}
      <Table>
        <Table.Thead><Table.Tr><Table.Th>Choice key</Table.Th><Table.Th>Label</Table.Th><Table.Th>{REVISION_DOMAINS.has(option.domain) ? 'Exact revision' : 'Declared value'}</Table.Th><Table.Th>Notes</Table.Th><Table.Th /></Table.Tr></Table.Thead>
        <Table.Tbody>{option.choices.map((choice, index) => <ChoiceEditor key={index} option={option} choice={choice} disabled={disabled} editable={editable} candidates={candidates} at={at} described={described}
          revisionLists={revisionLists} onRevisions={onRevisions} onDescribe={onDescribe} onChange={(next) => setChoice(index, next)} onRemove={() => removeChoice(index)} />)}</Table.Tbody>
      </Table>
      {editable && <Group><Button variant="quiet" disabled={disabled} onClick={() => onChange({ ...option, choices: [...option.choices, blankChoice(option)] })}>Add choice</Button></Group>}
    </Stack>
  </fieldset>;
}

type ChoiceEditorProps = {
  option: OptionBody; choice: ChoiceBody; disabled: boolean; editable: boolean; candidates: Definition[]; at: Occurrence | undefined; described: Record<string, Described>; revisionLists: Record<string, Revisions>;
  onRevisions: (definitionId: string) => void; onDescribe: (revisionId: string) => void; onChange: (choice: ChoiceBody) => void; onRemove: () => void;
};

function ChoiceEditor({ option, choice, disabled, editable, candidates, at, described, revisionLists, onRevisions, onDescribe, onChange, onRemove }: ChoiceEditorProps) {
  const pinned = choice.revision_id ? described[choice.revision_id] : undefined;
  const [definition, setDefinition] = useState(pinned?.definition_id ?? '');
  useEffect(() => { if (pinned && !definition) setDefinition(pinned.definition_id); }, [pinned]);
  useEffect(() => { onRevisions(definition); }, [definition]);
  const revisions = revisionLists[definition] ?? [];
  const name = choice.label.trim() || choice.key;
  const declared = pinned?.declared_target?.population_revision_id;
  return <Table.Tr>
    <Table.Td><TextInput aria-label={`Choice key of ${name}`} disabled={disabled} value={choice.key} w={120} onChange={(event) => onChange({ ...choice, key: event.currentTarget.value })} /></Table.Td>
    <Table.Td><TextInput aria-label={`Choice label of ${name}`} disabled={disabled} value={choice.label} onChange={(event) => onChange({ ...choice, label: event.currentTarget.value })} /></Table.Td>
    <Table.Td>{REVISION_DOMAINS.has(option.domain) ? <Group gap="xs" wrap="nowrap">
      <NativeSelect aria-label={`Definition for ${name}`} disabled={disabled} value={definition} data={[{ value: '', label: candidates.length ? 'Select a definition' : 'No matching definitions' }, ...candidates.map((item) => ({ value: item.definition_id, label: item.name }))]}
        onChange={(event) => { setDefinition(event.currentTarget.value); onChange({ ...choice, revision_id: null, population_option_id: null }); }} />
      <NativeSelect aria-label={`Revision for ${name}`} disabled={disabled || !definition} value={choice.revision_id ?? ''}
        data={[{ value: '', label: 'Select a frozen revision' }, ...(pinned && !revisions.some((item) => item.revision_id === pinned.revision_id) ? [{ value: pinned.revision_id, label: `Revision ${pinned.number}` }] : []), ...revisions.map((item) => ({ value: item.revision_id, label: `Revision ${item.number}` }))]}
        onChange={(event) => { const value = event.currentTarget.value || null; onChange({ ...choice, revision_id: value, population_option_id: null }); if (value) onDescribe(value); }} />
      {option.domain === 'population' && <NativeSelect aria-label={`Population option for ${name}`} disabled={disabled || !pinned} value={choice.population_option_id ?? ''}
        data={[{ value: '', label: pinned ? 'Select a population option' : 'Pin a revision first' }, ...(pinned?.population_options ?? []).map((item) => ({ value: item.local_id, label: item.name }))]}
        onChange={(event) => onChange({ ...choice, population_option_id: event.currentTarget.value || null })} />}
    </Group> : <TextInput aria-label={`Value for ${name}`} disabled={disabled} value={choice.value ?? ''} onChange={(event) => onChange({ ...choice, value: event.currentTarget.value })} />}</Table.Td>
    <Table.Td>
      {option.domain === 'firmware' && pinned && <Text size="sm">{!at ? 'Declared target not compared: choose an occurrence.' : declared === at.revision.revision_id ? 'Declares this occurrence’s exact population as its target.' : 'Declares a different population target than this occurrence; adoption will be blocked.'}</Text>}
      {choice.revision_id && !pinned && <Text size="sm">Pin not described yet.</Text>}
      {option.default_choice === choice.key && <Badge variant="outline">Default</Badge>}
    </Table.Td>
    <Table.Td>{editable && <Button variant="subtle" disabled={disabled} aria-label={`Remove choice ${name}`} onClick={onRemove}>Remove</Button>}</Table.Td>
  </Table.Tr>;
}
