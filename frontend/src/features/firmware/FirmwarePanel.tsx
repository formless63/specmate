import { Alert, Badge, Button, Card, Group, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { FirmwareBuildPanel } from '../firmware-builds/FirmwareBuildPanel';
import { command, request, SourceError, type RevisionDetail, type SourcePage } from '../sources/api';
import {
  FUNCTIONS, type AssignmentReview, type ConfigEntry, type Firmware, type FirmwareRead, type FirmwareSource, type FirmwareSummary,
  type PinAssumption, type PopulationReview, type SourceFileRole, type TargetSummary, type Toolchain,
} from './api';
import { RevisionLabel } from "../../lib/IdentityLabel";

const ROLES: SourceFileRole[] = ['application', 'library', 'configuration', 'board_support', 'lockfile', 'other'];
const FAMILIES: Toolchain['family'][] = ['platformio', 'esp_idf', 'arduino_cli', 'zephyr', 'cmake_gcc', 'other'];
const statusColor = { valid: 'green', invalid: 'red', unknown: 'yellow', not_evaluated: 'gray' } as const;
const blankToolchain: Toolchain = { family: 'platformio', name: '', version: null, framework: null, board_id: null };
const orNull = (value: string) => (value.trim() ? value.trim() : null);

/** Evaluation is declarations only: never a verified toolchain, build, flash or working device. */
export function FirmwareEvaluation({ read }: { read: FirmwareRead }) {
  const { evaluation } = read;
  return <Stack gap="xs">
    <Group><Badge color={evaluation.readiness === 'blocked' ? 'red' : evaluation.readiness === 'declared' ? 'green' : 'yellow'}>{evaluation.readiness.replace(/_/g, ' ')}</Badge>
      <Text size="sm">Declaration review: toolchain support and compilation require separate evidence · Flashing: not performed · Device operation: not observed</Text></Group>
    {evaluation.readiness === 'blocked' && <Alert color="red">Invalid target or pin assumptions block freezing. These declarations do not describe a working build.</Alert>}
    <Text size="sm">Target: {evaluation.target.population_name} revision {evaluation.target.population_number} · option {evaluation.target.option_name ?? `${evaluation.target.option_id} (missing)`} · {evaluation.target.component ? `${evaluation.target.component.reference} ${evaluation.target.component.value}` : 'component not in board'}{evaluation.target.declared_part ? ` · declared part label ${evaluation.target.declared_part} (not verified)` : ''}</Text>
    <Text size="xs" style={{ overflowWrap: 'anywhere' }}>Population snapshot {evaluation.target.population_snapshot_sha256} · interpretation {evaluation.target.interpretation_id} ({evaluation.target.interpretation_sha256}) · <RevisionLabel kind="source" id={evaluation.target.board_source_revision_id} role="board source" /></Text>
    {evaluation.sources.map(source => <Text size="xs" key={source.local_id} style={{ overflowWrap: 'anywhere' }}>Source {source.local_id}: {source.bundle_name} revision {source.revision_number} · manifest {source.manifest_sha256} · {source.files.map(f => `${f.path} (${f.role}, ${f.rights}, ${f.sha256.slice(0, 12)})`).join(', ')}</Text>)}
    <Table><Table.Thead><Table.Tr><Table.Th>Status</Table.Th><Table.Th>Check</Table.Th><Table.Th>Subject</Table.Th><Table.Th>Finding</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{evaluation.findings.map((f, index) => <Table.Tr key={index}><Table.Td><Badge color={statusColor[f.status]}>{f.status.replace('_', ' ')}</Badge></Table.Td><Table.Td>{f.code}</Table.Td><Table.Td>{f.subject.signal ?? f.subject.key ?? ''}</Table.Td><Table.Td>{f.message}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
  </Stack>;
}

type FirmwarePanelProps = { projectId: string; permissions?: string[]; onAccessLost?: () => void };

export function FirmwarePanel(props: FirmwarePanelProps) {
  return <FirmwareWorkspace key={props.projectId} {...props} />;
}

function FirmwareWorkspace({ projectId, permissions, onAccessLost }: FirmwarePanelProps) {
  const canEdit = !permissions || permissions.includes('design.edit');
  const canFreeze = !permissions || permissions.includes('design.freeze');
  const [shown, setShown] = useState(false);
  const [list, setList] = useState<FirmwareSummary[]>([]);
  const [targets, setTargets] = useState<TargetSummary[]>([]);
  const [sourcePage, setSourcePage] = useState<SourcePage['revisions']>([]);
  const [current, setCurrent] = useState<FirmwareRead | null>(null);
  const [form, setForm] = useState<Firmware | null>(null);
  const [name, setName] = useState('');
  const [population, setPopulation] = useState<PopulationReview | null>(null);
  const [assemblyId, setAssemblyId] = useState('');
  const [review, setReview] = useState<AssignmentReview | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const alive = useRef(false);
  const refreshRequest = useRef(0);
  const populationRequest = useRef(0);
  const assignmentRequest = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current += 1; };
  }, []);
  const active = (token: number) => alive.current && token === generation.current;
  function nextSelection() {
    generation.current += 1;
    setBusy(false); setMessage(''); setPopulation(null); setReview(null);
    return generation.current;
  }

  function failed(reason: unknown) {
    setMessage(reason instanceof Error ? reason.message : 'Firmware request failed.');
    const denied = reason instanceof SourceError && [401, 403, 404].includes(reason.status);
    if (!denied) return;
    generation.current += 1; setBusy(false); setList([]); setTargets([]); setSourcePage([]); setCurrent(null); setForm(null); setPopulation(null); setReview(null); setShown(false); onAccessLost?.();
  }
  const currentPath = (value: FirmwareRead) => value.draft_id ? `pcb/firmware-drafts/${value.draft_id}` : `pcb/firmware-revisions/${value.revision_id}`;
  async function checkRetainedAccess() {
    // Recheck exact selected sources as well as the persisted record. A project
    // list can succeed after one retained derivative origin becomes unavailable.
    return await Promise.all([
      current ? request<FirmwareRead>(currentPath(current)) : Promise.resolve(null),
      ...((form?.sources ?? []).map(source => request(`sources/revisions/${source.source_revision_id}`))),
      form?.target.population_revision_id ? request(`pcb/population-revisions/${form.target.population_revision_id}/review`) : Promise.resolve(null),
      review ? request<AssignmentReview>(`pcb/assemblies/${review.assembly_snapshot_id}/firmware-review`) : Promise.resolve(null),
    ]);
  }
  async function refresh() {
    const token = generation.current;
    const requestId = ++refreshRequest.current;
    const stillCurrent = () => active(token) && requestId === refreshRequest.current;
    try {
      const [firmware, available, sources, retained] = await Promise.all([
        request<{ firmware: FirmwareSummary[] }>(`pcb/projects/${projectId}/firmware`),
        request<{ targets: TargetSummary[] }>(`pcb/projects/${projectId}/firmware-targets`),
        request<SourcePage>(`sources/projects/${projectId}/revisions`),
        checkRetainedAccess(),
      ]);
      if (!stillCurrent()) return false;
      setList(firmware.firmware); setTargets(available.targets); setSourcePage(sources.revisions); setShown(true);
      // An unsaved editor keeps its original compare-and-set token.
      if (current && !form) setCurrent(retained[0] as FirmwareRead);
      return true;
    } catch (reason) { if (stillCurrent()) failed(reason); return false; }
  }
  async function loadPopulation(revisionId: string) {
    const token = generation.current;
    const requestId = ++populationRequest.current;
    const stillCurrent = () => active(token) && requestId === populationRequest.current;
    setPopulation(null);
    if (!revisionId) return;
    try {
      const result = await request<PopulationReview>(`pcb/population-revisions/${revisionId}/review`);
      if (stillCurrent()) setPopulation(result);
    } catch (reason) { if (stillCurrent()) failed(reason); }
  }
  async function open(path: string) {
    const token = nextSelection();
    setCurrent(null); setForm(null);
    try {
      const result = await request<FirmwareRead>(path);
      if (!active(token)) return;
      setCurrent(result); setForm(null); setReview(null);
    } catch (reason) { if (active(token)) failed(reason); }
  }
  function startNew() {
    nextSelection();
    setCurrent(null); setName(''); setPopulation(null);
    setForm({ sources: [], configuration: [], toolchain: { ...blankToolchain }, target: { population_revision_id: '', option_id: '', component_id: '', declared_part: null }, pins: [] });
  }
  function editCurrent() {
    if (!current) return;
    nextSelection();
    setForm(structuredClone(current.content.firmware)); void loadPopulation(current.content.firmware.target.population_revision_id);
  }
  async function addSource(revisionId: string | null) {
    if (!revisionId || !form) return;
    const token = generation.current;
    try {
      const detail = await request<RevisionDetail>(`sources/revisions/${revisionId}`);
      if (!active(token)) return;
      const pin: FirmwareSource = {
        local_id: `src${form.sources.length + 1}`, source_revision_id: detail.revision_id, source_manifest_sha256: detail.manifest_sha256,
        files: detail.manifest.files.map(f => ({ path: f.path, sha256: f.sha256, rights: f.rights, role: 'other' as SourceFileRole })),
      };
      setForm(latest => {
        if (!latest || !active(token)) return latest;
        let index = 1;
        while (latest.sources.some(source => source.local_id === `src${index}`)) index += 1;
        return { ...latest, sources: [...latest.sources, { ...pin, local_id: `src${index}` }] };
      });
    } catch (reason) { if (active(token)) failed(reason); }
  }
  async function save() {
    if (!form) return;
    const token = generation.current;
    setBusy(true); setMessage('');
    try {
      if (current?.draft_id && current.state) {
        await command('firmware.update', { draft_id: current.draft_id, firmware: form }, { expectedState: current.state });
        if (active(token)) await open(`pcb/firmware-drafts/${current.draft_id}`);
      } else {
        const created = await command<{ draft_id: string }>('firmware.create', { project_id: projectId, name: name.trim(), firmware: form });
        if (!active(token) || !await refresh() || !active(token)) return;
        await open(`pcb/firmware-drafts/${created.draft_id}`);
      }
    } catch (reason) {
      if (!active(token)) return;
      // The unsaved form is kept on conflicts, validation failures and missing references.
      if (reason instanceof SourceError && reason.status === 404) {
        try { await checkRetainedAccess(); } catch (denial) { if (active(token)) failed(denial); return; }
        if (!active(token)) return;
        // A missing new reference does not revoke an otherwise authorized draft.
        setMessage(reason.message);
      } else failed(reason);
    } finally { if (active(token)) setBusy(false); }
  }
  async function freeze() {
    if (!current?.draft_id || !current.state) return;
    const token = generation.current;
    setBusy(true); setMessage('');
    try {
      const frozen = await command<{ revision_id: string }>('firmware.freeze', { draft_id: current.draft_id }, { expectedState: current.state });
      if (!active(token) || !await refresh() || !active(token)) return;
      await open(`pcb/firmware-revisions/${frozen.revision_id}`);
    } catch (reason) { if (active(token)) failed(reason); } finally { if (active(token)) setBusy(false); }
  }
  async function reviewAssembly() {
    const token = generation.current;
    const requestId = ++assignmentRequest.current;
    const stillCurrent = () => active(token) && requestId === assignmentRequest.current;
    setReview(null);
    try {
      const result = await request<AssignmentReview>(`pcb/assemblies/${assemblyId.trim()}/firmware-review`);
      if (stillCurrent()) setReview(result);
    } catch (reason) { if (stillCurrent()) failed(reason); }
  }

  const option = population?.population.options.find(o => o.local_id === form?.target.option_id);
  const decision = (componentId: string) => option?.decisions.find(d => d.component_id === componentId)?.status;
  const components = population?.report.components ?? [];
  const reference = (componentId: string) => components.find(c => c.id === componentId)?.reference ?? '?';
  const targetPads = population?.report.pads.filter(p => p.component_id === form?.target.component_id && p.type !== 'npth') ?? [];
  const peerPads = population?.report.pads.filter(p => p.component_id !== form?.target.component_id && p.type !== 'npth') ?? [];
  const update = (patch: Partial<Firmware>) => form && setForm({ ...form, ...patch });
  const setPin = (index: number, patch: Partial<PinAssumption>) => form && update({ pins: form.pins.map((pin, i) => i === index ? { ...pin, ...patch } : pin) });
  const setConfig = (index: number, patch: Partial<ConfigEntry>) => form && update({ configuration: form.configuration.map((entry, i) => i === index ? { ...entry, ...patch } : entry) });

  return <Card withBorder><Stack>
    <Title order={3}>Firmware dependencies and targets</Title>
    <Text size="sm">Pin exact firmware sources, configuration and a declared toolchain to one frozen board population and exact native pads. Declarations are not verified toolchain support, a compiled build, a flash or a working device. Labels never establish pin correspondence.</Text>
    {message && <Alert color="red">{message}</Alert>}
    <Button variant="subtle" disabled={busy} onClick={() => void refresh()}>{shown ? 'Refresh firmware' : 'Show firmware'}</Button>
    {shown && <Stack>
      {list.map(item => <Group key={item.definition_id}><Text size="sm">{item.name}</Text>
        {item.draft_id && <Button size="xs" variant="light" onClick={() => void open(`pcb/firmware-drafts/${item.draft_id}`)}>Open {item.name} draft</Button>}
        {item.revisions.map(r => <Button key={r.revision_id} size="xs" variant="subtle" onClick={() => void open(`pcb/firmware-revisions/${r.revision_id}`)}>{item.name} revision {r.number}</Button>)}
      </Group>)}
      {canEdit && !form && <Button variant="light" onClick={startNew}>New firmware declaration</Button>}
      {current && !form && <Stack>
        <Title order={4}>{current.name} · {current.revision_id ? `frozen revision ${current.revision_number}` : `draft ${current.state}`}</Title>
        {current.snapshot_sha256 && <Text size="xs">Snapshot SHA-256 {current.snapshot_sha256}</Text>}
        <Text size="sm">Toolchain: {current.content.firmware.toolchain.family} · {current.content.firmware.toolchain.name} · version {current.content.firmware.toolchain.version ?? 'unknown'}{current.content.firmware.toolchain.board_id ? ` · board id ${current.content.firmware.toolchain.board_id}` : ''}</Text>
        <Text size="sm">Configuration: {current.content.firmware.configuration.map(c => `${c.key}=${c.status === 'known' ? c.value : c.status === 'secret_reference' ? '[secret reference]' : 'unknown'}`).join(', ') || 'none'}</Text>
        <FirmwareEvaluation read={current} />
        {current.revision_id && <FirmwareBuildPanel firmware_revision_id={current.revision_id} canExecute={permissions?.includes('build.execute') ?? false} />}
        {current.draft_id && canEdit && <Button variant="light" onClick={editCurrent}>Edit firmware draft</Button>}
        {current.draft_id && canFreeze && <Button disabled={busy || current.evaluation.readiness === 'blocked'} onClick={() => void freeze()}>Freeze firmware declarations</Button>}
      </Stack>}
      {form && <Stack>
        <Title order={4}>{current ? `Edit ${current.name}` : 'New firmware declaration'}</Title>
        {!current && <TextInput label="Firmware name" value={name} onChange={e => setName(e.currentTarget.value)} />}
        <Text fw={600}>Exact sources</Text>
        <Select label="Add preserved source revision" placeholder="Choose a revision" data={sourcePage.map(r => ({ value: r.revision_id, label: `${r.name} revision ${r.number}` }))} value={null} onChange={value => void addSource(value)} />
        {form.sources.map((source, si) => <Card withBorder key={source.local_id}><Text size="sm">{sourcePage.find(r => r.revision_id === source.source_revision_id)?.name ?? source.source_revision_id} · manifest {source.source_manifest_sha256.slice(0, 16)}</Text>
          {source.files.map((file, fi) => <Group key={file.path}><Text size="xs" w={240}>{file.path} · {file.rights}</Text>
            <Select aria-label={`Role for ${file.path}`} size="xs" data={ROLES} value={file.role} allowDeselect={false} onChange={value => update({ sources: form.sources.map((s, i) => i !== si ? s : { ...s, files: s.files.map((f, j) => j === fi ? { ...f, role: value as SourceFileRole } : f) }) })} />
            <Button size="xs" variant="subtle" onClick={() => update({ sources: form.sources.map((s, i) => i !== si ? s : { ...s, files: s.files.filter((_, j) => j !== fi) }).filter(s => s.files.length) })}>Remove {file.path}</Button></Group>)}
        </Card>)}
        <Text fw={600}>Toolchain declaration</Text>
        <Group grow>
          <Select label="Toolchain family" data={FAMILIES} value={form.toolchain.family} allowDeselect={false} onChange={value => update({ toolchain: { ...form.toolchain, family: value as Toolchain['family'] } })} />
          <TextInput label="Toolchain name" value={form.toolchain.name} onChange={e => update({ toolchain: { ...form.toolchain, name: e.currentTarget.value } })} />
          <TextInput label="Toolchain version" description="Leave blank when unknown." value={form.toolchain.version ?? ''} onChange={e => update({ toolchain: { ...form.toolchain, version: orNull(e.currentTarget.value) } })} />
          <TextInput label="Toolchain board identifier" description="A label; it does not establish the populated part." value={form.toolchain.board_id ?? ''} onChange={e => update({ toolchain: { ...form.toolchain, board_id: orNull(e.currentTarget.value) } })} />
        </Group>
        <Text fw={600}>Configuration</Text>
        {form.configuration.map((entry, index) => <Group key={index}>
          <TextInput aria-label={`Configuration key ${index + 1}`} value={entry.key} onChange={e => setConfig(index, { key: e.currentTarget.value })} />
          <Select aria-label={`Configuration status ${index + 1}`} data={[{ value: 'known', label: 'Known value' }, { value: 'unknown', label: 'Unknown' }, { value: 'secret_reference', label: 'Secret reference (value not stored)' }]} value={entry.status} allowDeselect={false} onChange={value => setConfig(index, { status: value as ConfigEntry['status'], value: value === 'known' ? entry.value ?? '' : null })} />
          {entry.status === 'known' && <TextInput aria-label={`Configuration value ${index + 1}`} value={entry.value ?? ''} onChange={e => setConfig(index, { value: e.currentTarget.value })} />}
          <Button size="xs" variant="subtle" onClick={() => update({ configuration: form.configuration.filter((_, i) => i !== index) })}>Remove setting</Button>
        </Group>)}
        <Button size="xs" variant="light" onClick={() => update({ configuration: [...form.configuration, { key: '', status: 'unknown', value: null }] })}>Add setting</Button>
        <Text fw={600}>Board target</Text>
        <Select label="Frozen population revision" data={targets.map(t => ({ value: t.revision_id, label: `${t.name} revision ${t.number}` }))} value={form.target.population_revision_id || null}
          onChange={value => { update({ target: { ...form.target, population_revision_id: value ?? '', option_id: '', component_id: '' }, pins: form.pins.map(p => ({ ...p, pad_id: null, peer_pad_id: null })) }); void loadPopulation(value ?? ''); }} />
        {population && <Group grow>
          <Select label="Population option" data={population.population.options.map(o => ({ value: o.local_id, label: o.name }))} value={form.target.option_id || null} onChange={value => update({ target: { ...form.target, option_id: value ?? '' } })} />
          <Select label="Target component" description="Exact native component; its population decision is shown." data={components.map(c => ({ value: c.id, label: `${c.reference} ${c.value} · ${decision(c.id) ?? 'unresolved'}` }))} value={form.target.component_id || null}
            onChange={value => update({ target: { ...form.target, component_id: value ?? '' }, pins: form.pins.map(p => ({ ...p, pad_id: null })) })} />
          <TextInput label="Declared part label" description="Informational only." value={form.target.declared_part ?? ''} onChange={e => update({ target: { ...form.target, declared_part: orNull(e.currentTarget.value) } })} />
        </Group>}
        <Text fw={600}>Pin and peripheral assumptions</Text>
        {form.pins.map((pin, index) => <Card withBorder key={index}><Group grow>
          <TextInput aria-label={`Signal ${index + 1}`} label="Signal" value={pin.signal} onChange={e => setPin(index, { signal: e.currentTarget.value })} />
          <Select aria-label={`Pad for signal ${index + 1}`} label="Target pad" placeholder="Unknown" clearable data={targetPads.map(p => ({ value: p.id, label: p.terminal }))} value={pin.pad_id} onChange={value => setPin(index, { pad_id: value })} />
          <Select aria-label={`Function for signal ${index + 1}`} label="Function" data={FUNCTIONS} value={pin.function} allowDeselect={false} onChange={value => setPin(index, { function: value as PinAssumption['function'] })} />
          <TextInput aria-label={`Peripheral for signal ${index + 1}`} label="Peripheral instance" value={pin.peripheral ?? ''} onChange={e => setPin(index, { peripheral: orNull(e.currentTarget.value) })} />
          <TextInput aria-label={`Expected net for signal ${index + 1}`} label="Expected reported net" value={pin.expected_net ?? ''} onChange={e => setPin(index, { expected_net: orNull(e.currentTarget.value) })} />
          <Select aria-label={`Peer pad for signal ${index + 1}`} label="Peer pad" clearable data={peerPads.map(p => ({ value: p.id, label: `${p.terminal} (${reference(p.component_id)})` }))} value={pin.peer_pad_id} onChange={value => setPin(index, { peer_pad_id: value })} />
        </Group><Button size="xs" variant="subtle" onClick={() => update({ pins: form.pins.filter((_, i) => i !== index) })}>Remove signal</Button></Card>)}
        <Button size="xs" variant="light" onClick={() => update({ pins: [...form.pins, { signal: '', pad_id: null, function: 'gpio_in', peripheral: null, expected_net: null, peer_pad_id: null, basis: null }] })}>Add signal</Button>
        <Group>
          <Button disabled={busy || (!current && !name.trim()) || !form.sources.length || !form.toolchain.name.trim() || !form.target.component_id || !form.target.option_id} onClick={() => void save()}>Save firmware draft</Button>
          <Button variant="subtle" disabled={busy} onClick={() => { nextSelection(); setForm(null); }}>Discard edits</Button>
        </Group>
        <Text size="xs">Saving validates exact source pins and records findings. Freezing requires no invalid target or pin finding.</Text>
      </Stack>}
      <Card withBorder><Stack gap="xs">
        <Text fw={600}>Assembly firmware assignments</Text>
        <TextInput label="Frozen assembly snapshot ID" value={assemblyId} onChange={e => { assignmentRequest.current += 1; setReview(null); setAssemblyId(e.currentTarget.value); }} />
        <Button size="xs" disabled={!assemblyId.trim()} onClick={() => void reviewAssembly()}>Review firmware assignments</Button>
        {review && <Table><Table.Tbody>{review.assignments.map(row => <Table.Tr key={row.path.join('/')}><Table.Td>{row.path.join(' / ')}</Table.Td><Table.Td>{row.firmware_name}</Table.Td><Table.Td><Badge color={statusColor[row.status]}>{row.status}</Badge></Table.Td><Table.Td>{row.message}</Table.Td></Table.Tr>)}</Table.Tbody></Table>}
      </Stack></Card>
    </Stack>}
  </Stack></Card>;
}
