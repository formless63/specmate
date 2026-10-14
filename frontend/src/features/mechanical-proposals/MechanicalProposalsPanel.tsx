import { Alert, Badge, Button, Card, Group, SegmentedControl, Select, Stack, Table, Text, Textarea, TextInput, Title } from '@mantine/core';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ReadOnlyNote, usePermission } from '../../lib/permissions';
import { randomUUID } from '../../lib/random-id';
import { SourceError } from '../sources/api';
import { boardInputs, createDraft, decideRetained, listBoards, listDrafts, readDraft, readRetained, retainDraft, updateDraft, type BoardChoice, type BoardInputs, type DecidePayload, type Decision, type Draft, type DraftRow, type Feature, type Proposal, type Retained, type Side } from './api';
import { emptyForm, fromForm, toForm, type Choice, type FormState } from './form';
import { PlanPreview } from './PlanPreview';

const SIDES: Side[] = ['west', 'east', 'north', 'south'];
const sideData = SIDES.map(value => ({ value, label: `${value} wall` }));
const faceData = [{ value: 'lid', label: 'Lid' }, { value: 'floor', label: 'Floor' }];
const choiceData = [{ value: 'undecided', label: 'Not decided (candidate only)' }, { value: 'mount', label: 'Mounting boss' }, { value: 'declined', label: 'Not a mount' }];

/** Root keyed by principal and project, so no draft, board identity or unsaved text crosses either. */
export function MechanicalProposalsPanel({ workspaceId, principalKey = '' }: { workspaceId: string; principalKey?: string }) {
  return <Workspace key={JSON.stringify([principalKey, workspaceId])} workspaceId={workspaceId} />;
}

function Field({ label, value, onChange, unit = 'mm', disabled }: { label: string; value: string; onChange: (value: string) => void; unit?: string; disabled?: boolean }) {
  return <TextInput label={label} description={`${unit}; blank means unknown`} value={value} inputMode="decimal" disabled={disabled} onChange={event => onChange(event.currentTarget.value)} />;
}

function Workspace({ workspaceId }: { workspaceId: string }) {
  const edit = usePermission('design.edit');
  // Creating a proposal draft adds a workspace item (item.create); editing it needs design.edit.
  const createGate = usePermission('item.create');
  const [boards, setBoards] = useState<BoardChoice[]>([]);
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [inputs, setInputs] = useState<BoardInputs | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [dirty, setDirty] = useState(false);
  const [retained, setRetained] = useState<Retained | null>(null);
  const [board, setBoard] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const intent = useRef<{ identity: string; key: string } | null>(null);
  const keyFor = (identity: string) => { if (intent.current?.identity !== identity) intent.current = { identity, key: randomUUID() }; return intent.current.key; };
  const outcome = useCallback((reason: unknown) => {
    if (!mounted.current) return;
    if (reason instanceof SourceError && [401, 403, 404].includes(reason.status)) {
      generation.current += 1; setDenied(true); setDraft(null); setInputs(null); setRetained(null); setBoards([]); setRows([]); setDirty(false);
      setError('Access to this project or its board source changed. Reload to check current access.');
      return;
    }
    if (reason instanceof SourceError && reason.status === 409) { setStale(true); setError('This proposal changed since you loaded it. Your unsaved edits are kept; nothing was saved.'); return; }
    setError(reason instanceof Error ? reason.message : 'Request failed.');
  }, []);
  const refreshLists = useCallback(async (signal?: AbortSignal) => {
    const [choices, drafts] = await Promise.all([listBoards(workspaceId, signal), listDrafts(workspaceId, signal)]);
    if (!mounted.current || signal?.aborted) return;
    setBoards(choices.boards); setRows(drafts.drafts); setDenied(false);
  }, [workspaceId]);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    refreshLists(controller.signal).catch(reason => { if (!controller.signal.aborted) outcome(reason); });
    return () => { mounted.current = false; controller.abort(); };
  }, [refreshLists, outcome]);

  async function open(id: string) {
    const ticket = ++generation.current;
    setBusy(true); setError(''); setStale(false); setRetained(null);
    try {
      const next = await readDraft(id);
      const choices = await boardInputs(workspaceId, next.interpretation_id);
      if (!mounted.current || ticket !== generation.current) return;
      if (next.workspace_id !== workspaceId || choices.interpretation_id !== next.interpretation_id) throw new Error('Response does not match the selected project or board.');
      setDraft(next); setInputs(choices); setForm(toForm(next.parameters)); setDirty(false);
    } catch (reason) { setDraft(null); setInputs(null); outcome(reason); } finally { if (mounted.current) setBusy(false); }
  }
  async function create() {
    if (!board || !name.trim()) return;
    setBusy(true); setError('');
    try {
      const created = await createDraft(workspaceId, board, name.trim(), fromForm(emptyForm()).parameters, keyFor(JSON.stringify(['create', workspaceId, board, name.trim()])));
      await refreshLists(); intent.current = null; setName('');
      await open(created.draft_id);
    } catch (reason) { outcome(reason); } finally { if (mounted.current) setBusy(false); }
  }
  const parsed = fromForm(form);
  async function save() {
    if (!draft || parsed.errors.length) return;
    setBusy(true); setError('');
    try {
      const saved = await updateDraft(draft.draft_id, parsed.parameters, draft.state, keyFor(JSON.stringify(['update', draft.draft_id, draft.state, parsed.parameters])));
      if (!mounted.current) return;
      setDraft(saved); setForm(toForm(saved.parameters)); setDirty(false); setStale(false); intent.current = null;
      await refreshLists();
    } catch (reason) { outcome(reason); } finally { if (mounted.current) setBusy(false); }
  }
  async function retain() {
    if (!draft || dirty) return;
    setBusy(true); setError('');
    try {
      const record = await retainDraft(draft.draft_id, draft.state, keyFor(JSON.stringify(['retain', draft.draft_id, draft.state])));
      intent.current = null;
      await open(draft.draft_id);
      if (mounted.current) setRetained(await readRetained(record.revision_id, workspaceId));
    } catch (reason) { outcome(reason); } finally { if (mounted.current) setBusy(false); }
  }
  async function showRetained(id: string) {
    setBusy(true); setError('');
    try { const record = await readRetained(id, workspaceId); if (mounted.current) setRetained(record); }
    catch (reason) { setRetained(null); outcome(reason); } finally { if (mounted.current) setBusy(false); }
  }
  async function decide(revisionId: string, state: string, payload: DecidePayload) {
    setBusy(true); setError('');
    try {
      await decideRetained(revisionId, payload, state, keyFor(JSON.stringify(['decide', revisionId, state, payload])));
      intent.current = null;
      if (!mounted.current) return;
      setRetained(await readRetained(revisionId, workspaceId));
      if (!dirty && draft) { const next = await readDraft(draft.draft_id); if (mounted.current) setDraft(next); }
    } catch (reason) { if (reason instanceof SourceError && reason.status === 409) throw reason; outcome(reason); }
    finally { if (mounted.current) setBusy(false); }
  }
  const change = (apply: (current: FormState) => FormState) => { setForm(apply); setDirty(true); intent.current = null; };
  const readOnly = !edit.allowed;
  const component = (id: string) => inputs?.components.find(c => c.component_id === id);

  return <Stack>
    <Title order={2}>Parametric proposals</Title>
    <Text>Reviewable enclosure, boss, opening, vent and cable-guide drafts generated from an accepted board and your declarations. Blank values are unknown and keep the dependent geometry incomplete; nothing is defaulted. A proposal is not a fit, clearance, printability or manufacturing conclusion, and it never edits design drafts, frozen revisions or placements.</Text>
    <ReadOnlyNote permission="design.edit" />
    {error && <Alert color="red" role="alert">{error}</Alert>}
    {denied && <Button variant="quiet" onClick={() => { setError(''); refreshLists().catch(outcome); }}>Reload current access</Button>}
    {stale && draft && <Button variant="quiet" onClick={() => void open(draft.draft_id)}>Load latest (discards unsaved edits)</Button>}

    <Card withBorder><Stack>
      <Title order={3}>Drafts</Title>
      {rows.length === 0 ? <Text>No proposal drafts in this project.</Text> : <Table><Table.Thead><Table.Tr><Table.Th>Name</Table.Th><Table.Th>State</Table.Th><Table.Th>Retained</Table.Th><Table.Th /></Table.Tr></Table.Thead><Table.Tbody>
        {rows.map(row => <Table.Tr key={row.draft_id}><Table.Td>{row.name}</Table.Td><Table.Td><Badge variant="draft">{row.state}</Badge></Table.Td><Table.Td>{row.revision_count}</Table.Td><Table.Td><Button variant="quiet" disabled={busy} onClick={() => void open(row.draft_id)} aria-label={`Open proposal ${row.name}`}>Open</Button></Table.Td></Table.Tr>)}
      </Table.Tbody></Table>}
      <Group align="end">
        <Select label="Accepted board" placeholder={boards.length ? 'Choose a board' : 'No accepted board interpretation'} value={board} onChange={setBoard} data={boards.map(b => ({ value: b.interpretation_id, label: `${b.board_path || 'board'} · ${b.sha256.slice(0, 12)} · outline ${b.outline}` }))} />
        <TextInput label="New proposal name" value={name} onChange={event => setName(event.currentTarget.value)} />
        <Button {...createGate.props} disabled={!createGate.allowed || busy || !board || !name.trim()} onClick={() => void create()}>Create proposal draft</Button>
      </Group>
    </Stack></Card>

    {draft && inputs && <>
      <Card withBorder><Stack>
        <Group><Title order={3}>{draft.name}</Title><Badge variant="draft">{draft.state}</Badge>{dirty && <Badge variant="occurrence">Unsaved edits</Badge>}</Group>
        <Text size="xs">Board interpretation {draft.interpretation_id} · SHA-256 {inputs.sha256} · frame: {inputs.frame}</Text>
        <Title order={4}>Enclosure shell</Title>
        <Group grow align="start">
          {([['board_clearance_mm', 'Board clearance'], ['wall_mm', 'Wall thickness'], ['corner_radius_mm', 'Corner radius'], ['interior_height_mm', 'Interior height'], ['board_thickness_mm', 'Board thickness']] as const).map(([key, label]) =>
            <Field key={key} label={label} value={form.shell[key]} disabled={readOnly} onChange={value => change(f => ({ ...f, shell: { ...f.shell, [key]: value } }))} />)}
        </Group>
        <Title order={4}>Mounting bosses</Title>
        <Group grow align="start">
          {([['outer_diameter_mm', 'Boss outer diameter'], ['pilot_diameter_mm', 'Pilot diameter'], ['height_mm', 'Standoff height'], ['lid_clearance_diameter_mm', 'Lid fastener clearance diameter']] as const).map(([key, label]) =>
            <Field key={key} label={label} value={form.boss[key]} disabled={readOnly} onChange={value => change(f => ({ ...f, boss: { ...f.boss, [key]: value } }))} />)}
        </Group>
        {inputs.holes.length === 0 ? <Text>The accepted board lists no non-plated hole candidates.</Text> : inputs.holes.map(hole =>
          <Select key={hole.pad_id} label={`Hole at (${hole.position[0]}, ${hole.position[1]}) drill ${hole.drill[0]} x ${hole.drill[1]} mm`} description={`${hole.mounting_status}; native ${hole.pad_id}`} allowDeselect={false} disabled={readOnly} data={choiceData} value={form.mounts[hole.pad_id] ?? 'undecided'} onChange={value => change(f => ({ ...f, mounts: { ...f.mounts, [hole.pad_id]: (value ?? 'undecided') as Choice } }))} />)}
      </Stack></Card>

      <Section title="Connector openings" onAdd={readOnly ? undefined : () => change(f => ({ ...f, connectors: [...f.connectors, { component_id: inputs.components.find(c => !f.connectors.some(x => x.component_id === c.component_id))?.component_id ?? '', side: 'east', lateral_offset_mm: '', width_mm: '', height_mm: '', center_above_board_mm: '', clearance_mm: '' }] }))} addLabel="Add connector opening" addDisabled={inputs.components.length === 0}>
        {form.connectors.map((c, index) => <Card withBorder key={index}><Stack>
          <Group align="end">
            <Select label="Component (native identity)" description={component(c.component_id) ? `${component(c.component_id)?.footprint} · ${component(c.component_id)?.side} side · origin ${component(c.component_id)?.position.join(', ')}` : 'Choose a component'} data={inputs.components.map(x => ({ value: x.component_id, label: `${x.reference} · ${x.value}` }))} value={c.component_id || null} disabled={readOnly} onChange={value => change(f => ({ ...f, connectors: f.connectors.map((x, i) => i === index ? { ...x, component_id: value ?? '' } : x) }))} />
            <Select label="Wall" data={sideData} allowDeselect={false} value={c.side} disabled={readOnly} onChange={value => change(f => ({ ...f, connectors: f.connectors.map((x, i) => i === index ? { ...x, side: (value ?? 'east') as Side } : x) }))} />
            <Button variant="risk" disabled={readOnly} onClick={() => change(f => ({ ...f, connectors: f.connectors.filter((_, i) => i !== index) }))}>Remove opening</Button>
          </Group>
          <Group grow align="start">{([['lateral_offset_mm', 'Centreline offset from origin along wall'], ['width_mm', 'Envelope width'], ['height_mm', 'Envelope height'], ['center_above_board_mm', 'Centre above board surface'], ['clearance_mm', 'Opening clearance per side']] as const).map(([key, label]) =>
            <Field key={key} label={label} value={c[key]} disabled={readOnly} onChange={value => change(f => ({ ...f, connectors: f.connectors.map((x, i) => i === index ? { ...x, [key]: value } : x) }))} />)}</Group>
        </Stack></Card>)}
      </Section>

      <Section title="Vent slot arrays" onAdd={readOnly ? undefined : () => change(f => ({ ...f, vents: [...f.vents, { local_id: `vent-${f.vents.length + 1}`, face: 'lid', slot_width_mm: '', slot_length_mm: '', pitch_x_mm: '', pitch_y_mm: '', edge_margin_mm: '', keepout_margin_mm: '' }] }))} addLabel="Add vent array">
        {form.vents.map((v, index) => <Card withBorder key={index}><Stack>
          <Group align="end"><TextInput label="Vent ID" value={v.local_id} disabled={readOnly} onChange={event => { const value = event.currentTarget.value; change(f => ({ ...f, vents: f.vents.map((x, i) => i === index ? { ...x, local_id: value } : x) })); }} />
            <Select label="Face" data={faceData} allowDeselect={false} value={v.face} disabled={readOnly} onChange={value => change(f => ({ ...f, vents: f.vents.map((x, i) => i === index ? { ...x, face: (value ?? 'lid') as 'lid' | 'floor' } : x) }))} />
            <Button variant="risk" disabled={readOnly} onClick={() => change(f => ({ ...f, vents: f.vents.filter((_, i) => i !== index) }))}>Remove vent array</Button></Group>
          <Group grow align="start">{([['slot_width_mm', 'Slot width'], ['slot_length_mm', 'Slot length'], ['pitch_x_mm', 'Pitch along x'], ['pitch_y_mm', 'Pitch along y'], ['edge_margin_mm', 'Edge margin'], ['keepout_margin_mm', 'Boss keep-out margin']] as const).map(([key, label]) =>
            <Field key={key} label={`${v.local_id || 'Vent'} ${label}`} value={v[key]} disabled={readOnly} onChange={value => change(f => ({ ...f, vents: f.vents.map((x, i) => i === index ? { ...x, [key]: value } : x) }))} />)}</Group>
        </Stack></Card>)}
      </Section>

      <Section title="Cable guides" onAdd={readOnly ? undefined : () => change(f => ({ ...f, guides: [...f.guides, { local_id: `guide-${f.guides.length + 1}`, side: 'north', offset_along_wall_mm: '', cable_diameter_mm: '', clearance_mm: '', post_width_mm: '', post_depth_mm: '' }] }))} addLabel="Add cable guide">
        {form.guides.map((g, index) => <Card withBorder key={index}><Stack>
          <Group align="end"><TextInput label="Guide ID" value={g.local_id} disabled={readOnly} onChange={event => { const value = event.currentTarget.value; change(f => ({ ...f, guides: f.guides.map((x, i) => i === index ? { ...x, local_id: value } : x) })); }} />
            <Select label="Guide wall" data={sideData} allowDeselect={false} value={g.side} disabled={readOnly} onChange={value => change(f => ({ ...f, guides: f.guides.map((x, i) => i === index ? { ...x, side: (value ?? 'north') as Side } : x) }))} />
            <Button variant="risk" disabled={readOnly} onClick={() => change(f => ({ ...f, guides: f.guides.filter((_, i) => i !== index) }))}>Remove cable guide</Button></Group>
          <Group grow align="start">{([['offset_along_wall_mm', 'Offset from wall low end'], ['cable_diameter_mm', 'Cable diameter'], ['clearance_mm', 'Slot clearance (total)'], ['post_width_mm', 'Post width'], ['post_depth_mm', 'Post depth']] as const).map(([key, label]) =>
            <Field key={key} label={`${g.local_id || 'Guide'} ${label}`} value={g[key]} disabled={readOnly} onChange={value => change(f => ({ ...f, guides: f.guides.map((x, i) => i === index ? { ...x, [key]: value } : x) }))} />)}</Group>
        </Stack></Card>)}
      </Section>

      {parsed.errors.map(message => <Alert key={message} color="red" role="alert">{message}</Alert>)}
      <Group>
        <Button {...edit.props} disabled={!edit.allowed || busy || !dirty || parsed.errors.length > 0} onClick={() => void save()}>Save declarations</Button>
        <Button variant="commit" {...edit.props} disabled={!edit.allowed || busy || dirty} title={dirty ? 'Save first: retention records the saved proposal.' : edit.props.title} onClick={() => void retain()}>Retain proposal record</Button>
        <Button variant="quiet" disabled={busy || !dirty} onClick={() => { setForm(toForm(draft.parameters)); setDirty(false); intent.current = null; }}>Discard unsaved edits</Button>
      </Group>

      <ProposalReview proposal={draft.proposal} label="Saved proposal" saved />
      <Card withBorder><Stack><Title order={3}>Retained records</Title>
        {draft.revisions.length === 0 ? <Text>None retained. A retained record is an immutable derived copy of the saved proposal, incomplete or not.</Text> :
          draft.revisions.map(r => <Group key={r.revision_id}><Badge variant="frozen">Record {r.number}</Badge><Text size="xs">{r.status} · {r.sha256}</Text>{r.current_decision ? <Badge variant="frozen">{r.current_decision}</Badge> : <Badge variant="draft">no decision</Badge>}<Button variant="quiet" disabled={busy} onClick={() => void showRetained(r.revision_id)} aria-label={`Inspect retained record ${r.number}`}>Inspect</Button></Group>)}
      </Stack></Card>
    </>}
    {retained?.document && <Card withBorder><Stack>
      <Group><Title order={3}>Retained record {retained.number}</Title><Badge variant="frozen">{retained.status}</Badge></Group>
      <Text size="xs">SHA-256 {retained.sha256} · draft version {retained.draft_version} · board {retained.interpretation_sha256}</Text>
      <ProposalReview proposal={retained.document.proposal} label="Retained proposal" />
      <DecisionReview key={`${retained.revision_id}:${retained.decision_state}`} retained={retained} allowed={edit.allowed} reason={edit.props.title} busy={busy} onDecide={decide} onReload={() => showRetained(retained.revision_id)} />
    </Stack></Card>}
  </Stack>;
}

function DecisionReview({ retained, allowed, reason: gateReason, busy, onDecide, onReload }: { retained: Retained; allowed: boolean; reason?: string; busy: boolean; onDecide: (revisionId: string, state: string, payload: DecidePayload) => Promise<void>; onReload: () => void }) {
  const [decision, setDecision] = useState<DecidePayload['decision']>('deferred');
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<'create' | 'link'>('create');
  const [target, setTarget] = useState('');
  const [conflict, setConflict] = useState('');
  const [failure, setFailure] = useState('');
  const history: Decision[] = retained.decisions ?? [];
  const state = retained.decision_state;
  const final = retained.current_decision?.decision === 'accepted';
  const accepting = decision === 'accepted';
  const ready = !!state && reason.trim() !== '' && (!accepting || target.trim() !== '');
  async function submit() {
    if (!state || !ready) return;
    setConflict(''); setFailure('');
    const payload: DecidePayload = { decision, reason: reason.trim(), ...(accepting ? (mode === 'create' ? { draftName: target.trim() } : { linkDraftId: target.trim() }) : {}) };
    try { await onDecide(retained.revision_id, state, payload); }
    catch (error) {
      if (error instanceof SourceError && error.status === 409) setConflict('Decisions changed since you loaded this record; nothing was recorded. Your text is kept.');
      else setFailure(error instanceof Error ? error.message : 'Request failed.');
    }
  }
  return <Card withBorder aria-label="Review decision"><Stack gap="xs">
    <Group><Title order={4}>Review decision</Title>{retained.current_decision ? <Badge variant="frozen">{retained.current_decision.decision}</Badge> : <Badge variant="draft">undecided</Badge>}</Group>
    <Text size="xs">A decision is a separate append-only record. It never edits this retained proposal or any frozen item. Accepting creates a design draft, or links one you name, and is final.</Text>
    {history.length === 0 ? <Text size="sm">No decisions recorded.</Text> : <Table><Table.Thead><Table.Tr><Table.Th>#</Table.Th><Table.Th>Decision</Table.Th><Table.Th>Reason</Table.Th><Table.Th>Draft</Table.Th><Table.Th>When</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
      {history.map(d => <Table.Tr key={d.decision_id}><Table.Td>{d.version}</Table.Td><Table.Td>{d.decision}</Table.Td><Table.Td>{d.reason}</Table.Td><Table.Td>{d.draft_id ? `${d.link_mode} ${d.draft_id}` : 'none'}</Table.Td><Table.Td>{d.created_at}</Table.Td></Table.Tr>)}
    </Table.Tbody></Table>}
    {final ? <Text size="sm">Accepted decisions are final.</Text> : <>
      <SegmentedControl aria-label="Decision" value={decision} onChange={value => setDecision(value as DecidePayload['decision'])} disabled={!allowed} data={[{ value: 'accepted', label: 'Accept' }, { value: 'rejected', label: 'Reject' }, { value: 'deferred', label: 'Defer' }]} />
      <Textarea label="Reason (required)" value={reason} onChange={event => setReason(event.currentTarget.value)} disabled={!allowed} rows={3} maxLength={4000} />
      {accepting && <>
        <SegmentedControl aria-label="Draft target" value={mode} onChange={value => { setMode(value as 'create' | 'link'); setTarget(''); }} disabled={!allowed} data={[{ value: 'create', label: 'Create design draft' }, { value: 'link', label: 'Link existing draft' }]} />
        <TextInput label={mode === 'create' ? 'New draft name' : 'Existing design draft ID'} value={target} onChange={event => setTarget(event.currentTarget.value)} disabled={!allowed} maxLength={mode === 'create' ? 200 : 64} />
      </>}
      {conflict && <Alert color="yellow" role="alert">{conflict} <Button variant="quiet" onClick={onReload}>Load latest decisions</Button></Alert>}
      {failure && <Alert color="red" role="alert">{failure}</Alert>}
      <Group><Button variant="commit" disabled={!allowed || busy || !ready} title={allowed ? undefined : gateReason} onClick={() => void submit()}>Record decision</Button></Group>
    </>}
  </Stack></Card>;
}

function Section({ title, children, onAdd, addLabel, addDisabled }: { title: string; children: ReactNode; onAdd?: () => void; addLabel: string; addDisabled?: boolean }) {
  return <Card withBorder><Stack><Group><Title order={4}>{title}</Title><Button variant="quiet" disabled={!onAdd || addDisabled} onClick={onAdd}>{addLabel}</Button></Group>{children}</Stack></Card>;
}

const statusText: Record<string, string> = { incomplete: 'Incomplete: unresolved inputs remain', declared_inputs_complete: 'Declared inputs complete (not a fit conclusion)' };

export function ProposalReview({ proposal, label, saved = false }: { proposal: Proposal; label: string; saved?: boolean }) {
  const byFeature = (feature: Feature) => proposal.unresolved.filter(u => u.feature_id === feature.feature_id);
  return <Card withBorder aria-label={label}><Stack>
    <Group><Title order={3}>{label}</Title><Badge variant={proposal.status === 'incomplete' ? 'draft' : 'occurrence'}>{statusText[proposal.status]}</Badge></Group>
    {saved && <Text size="sm">Reflects the last saved declarations only; unsaved edits are not previewed.</Text>}
    <Text size="sm">Geometry checks: {proposal.checks_summary.pass} pass · {proposal.checks_summary.fail} fail · {proposal.checks_summary.not_evaluated} not evaluated. They are arithmetic on declared inputs.</Text>
    <PlanPreview proposal={proposal} />
    <Title order={4}>Unresolved inputs ({proposal.unresolved.length})</Title>
    {proposal.unresolved.length === 0 ? <Text size="sm">None declared unresolved. Physical checks below remain.</Text> : <Table><Table.Tbody>
      {proposal.unresolved.map((u, index) => <Table.Tr key={index}><Table.Td>{u.feature_id}</Table.Td><Table.Td>{u.parameter}</Table.Td><Table.Td>{u.message}</Table.Td></Table.Tr>)}
    </Table.Tbody></Table>}
    <Title order={4}>Features</Title>
    {proposal.features.map(feature => <Card withBorder key={feature.feature_id}><Stack gap="xs">
      <Group><Text fw={600}>{feature.feature_id}</Text><Badge variant={feature.status === 'incomplete' ? 'draft' : 'frozen'}>{feature.kind.replace(/_/g, ' ')}</Badge>{byFeature(feature).length > 0 && <Text size="xs">{byFeature(feature).length} unresolved</Text>}</Group>
      {feature.checks.map((check, index) => <Text size="sm" key={index}>{check.status.replace('_', ' ')}: {check.code.replace(/_/g, ' ')} ({check.detail})</Text>)}
      {feature.notes.map((note, index) => <Text size="xs" key={index}>{note}</Text>)}
    </Stack></Card>)}
    <Title order={4}>Facts used</Title>
    {proposal.facts_used.map((fact, index) => <Text size="xs" key={index}>{fact.name}: {JSON.stringify(fact.value)} ({fact.origin})</Text>)}
    <Title order={4}>Remaining physical checks</Title>
    {proposal.remaining_physical_checks.map((text, index) => <Text size="sm" key={index}>{text}</Text>)}
    <Text size="sm">Fit, clearance, printability, manufacturing and physical qualification: not evaluated. Board interpretation {proposal.board.interpretation_sha256}.</Text>
  </Stack></Card>;
}
