import { Alert, Badge, Button, Card, Group, MantineThemeProvider, Select, Stack, Table, Text, TextInput } from '@mantine/core';
import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { request, type RevisionDetail, type SourcePage } from '../sources/api';
import { RevisionLabel } from '../../lib/IdentityLabel';
import { FUNCTIONS, type ConfigEntry, type Firmware, type FirmwareRead, type FirmwareSource, type PinAssumption, type PopulationReview, type SourceFileRole, type TargetSummary, type Toolchain } from './api';
const ROLES: SourceFileRole[] = ['application', 'library', 'configuration', 'board_support', 'lockfile', 'other'];
const FAMILIES: Toolchain['family'][] = ['platformio', 'esp_idf', 'arduino_cli', 'zephyr', 'cmake_gcc', 'other'];
const statusColor = { valid: 'green', invalid: 'red', unknown: 'yellow', not_evaluated: 'gray' } as const;
const orNull = (value: string) => value.trim() ? value.trim() : null;
export const blankFirmware = (): Firmware => ({ sources: [], configuration: [], toolchain: { family: 'platformio', name: '', version: null, framework: null, board_id: null }, target: { population_revision_id: '', option_id: '', component_id: '', declared_part: null }, pins: [] });
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


export function FirmwareFields({ value: form, onChange, active, editable, workspaceId, principalKey, onAccessLost }: { value: Firmware; onChange: (value: Firmware) => void; active: boolean; editable: boolean; workspaceId: string; principalKey: string; onAccessLost: () => void }) {
  const latest = useRef({ form, active, editable }); latest.current = { form, active, editable };
  const epoch = useRef(0); useEffect(() => { epoch.current++; }, [active]);
  const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const scope = [principalKey, workspaceId];
  const choices = useQuery({ queryKey: ['firmware-authoring-choices', ...scope], enabled: active && editable, retry: false, queryFn: async () => { const [targets, sources] = await Promise.all([request<{ targets: TargetSummary[] }>(`pcb/workspaces/${workspaceId}/firmware-targets`), request<SourcePage>(`sources/workspaces/${workspaceId}/revisions`)]); return { targets: targets.targets, sources: sources.revisions }; } });
  const populationRead = useQuery({ queryKey: ['firmware-population', ...scope, form.target.population_revision_id], enabled: active && !!form.target.population_revision_id, retry: false, queryFn: () => request<PopulationReview>(`pcb/population-revisions/${form.target.population_revision_id}/review`) });
  const population = active && !populationRead.isError && !populationRead.isFetching ? populationRead.data : undefined;
  const targets = choices.isError || choices.isFetching ? [] : choices.data?.targets ?? [], sourcePage = choices.isError || choices.isFetching ? [] : choices.data?.sources ?? [];
  const option = population?.population.options.find(o => o.local_id === form.target.option_id);
  const decision = (componentId: string) => option?.decisions.find(d => d.component_id === componentId)?.status;
  const components = population?.report.components ?? [];
  const reference = (componentId: string) => components.find(c => c.id === componentId)?.reference ?? '?';
  const targetPads = population?.report.pads.filter(p => p.component_id === form.target.component_id && p.type !== 'npth') ?? [];
  const peerPads = population?.report.pads.filter(p => p.component_id !== form.target.component_id && p.type !== 'npth') ?? [];
  const update = (patch: Partial<Firmware>) => { if (editable) onChange({ ...form, ...patch }); };
  const setPin = (index: number, patch: Partial<PinAssumption>) => update({ pins: form.pins.map((pin, i) => i === index ? { ...pin, ...patch } : pin) });
  const setConfig = (index: number, patch: Partial<ConfigEntry>) => update({ configuration: form.configuration.map((entry, i) => i === index ? { ...entry, ...patch } : entry) });
  async function addSource(revisionId: string | null) {
    if (!revisionId || !active || !editable) return;
    const signature = JSON.stringify(form.sources), token = epoch.current;
    try {
      const detail = await request<RevisionDetail>(`sources/revisions/${revisionId}`);
      if (!alive.current || token !== epoch.current || !latest.current.active || !latest.current.editable || JSON.stringify(latest.current.form.sources) !== signature) return;
      let index = 1; while (latest.current.form.sources.some(source => source.local_id === `src${index}`)) index++;
      const pin: FirmwareSource = { local_id: `src${index}`, source_revision_id: detail.revision_id, source_manifest_sha256: detail.manifest_sha256, files: detail.manifest.files.map(file => ({ path: file.path, sha256: file.sha256, rights: file.rights, role: 'other' })) };
      onChange({ ...latest.current.form, sources: [...latest.current.form.sources, pin] });
    } catch { if (alive.current && latest.current.active) onAccessLost(); }
  }
  return <MantineThemeProvider theme={{ components: { Select: Select.extend({ defaultProps: { comboboxProps: { withinPortal: false } } }) } }}><fieldset disabled={!active || !editable} style={{ border: 0, padding: 0, minWidth: 0 }}><Stack>
    {active && choices.isError && <Alert color="red">{choices.error.message}</Alert>}
    {active && populationRead.isError && <Alert color="red">{populationRead.error.message}</Alert>}
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
          onChange={value => { update({ target: { ...form.target, population_revision_id: value ?? '', option_id: '', component_id: '' }, pins: form.pins.map(p => ({ ...p, pad_id: null, peer_pad_id: null })) });  }} />
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

  </Stack></fieldset></MantineThemeProvider>;
}

export function FirmwareInspection({ read }: { read: FirmwareRead }) {
  const value = read.content.firmware;
  return <Stack><Text fw={600}>Toolchain: {value.toolchain.family} · {value.toolchain.name} · version {value.toolchain.version ?? 'unknown'}{value.toolchain.board_id ? ` · board id ${value.toolchain.board_id}` : ''}</Text>
    <Text size="sm">Configuration: {value.configuration.map(entry => `${entry.key}=${entry.status === 'known' ? entry.value : entry.status === 'secret_reference' ? '[secret reference]' : '[unknown]'}`).join(', ') || 'none'}</Text>
    <Table><Table.Thead><Table.Tr><Table.Th>Signal</Table.Th><Table.Th>Declared function</Table.Th><Table.Th>Exact pad</Table.Th><Table.Th>Expected net / peer</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{value.pins.map((pin, index) => <Table.Tr key={index}><Table.Td>{pin.signal}</Table.Td><Table.Td>{pin.function}{pin.peripheral ? ` · ${pin.peripheral}` : ''}</Table.Td><Table.Td>{pin.pad_id ?? 'Unknown'}</Table.Td><Table.Td>{pin.expected_net ?? 'Unknown'} / {pin.peer_pad_id ?? 'Unknown'}{pin.basis && <Text size="xs">{pin.basis}</Text>}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
    <FirmwareEvaluation read={read} />
  </Stack>;
}
