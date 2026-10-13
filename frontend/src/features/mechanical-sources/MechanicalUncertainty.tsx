import { Button, Card, Group, NumberInput, Select, Stack, Text, Textarea, TextInput, Title } from '@mantine/core';
import type { AssumptionStatus, ConnectorEnvelope, MechanicalSource, MechanicalUncertainty, ScopedAssumption, UncertaintyAssessment } from './api';

export const unknownUncertainty = (): MechanicalUncertainty => ({ materials: [], processes: [], tolerances: [], connector_envelopes: [] });
const statuses = ['unknown', 'declared', 'not_applicable'];
const nullable = (value: string) => value.trim() || null;
const local = (prefix: string, rows: ScopedAssumption[]) => { let n = 1; while (rows.some(r => r.local_id === prefix + n)) n++; return prefix + n; };

export function MechanicalUncertaintyRead({ assessment }: { assessment?: UncertaintyAssessment }) {
  if (!assessment) return <Text>Material, process, tolerance and connector scope unassessed. Fit remains not evaluated.</Text>;
  const u = assessment.assumptions;
  return <Stack gap="xs">
    <Title order={5}>Geometry and process prerequisites</Title>
    <Text>{assessment.readiness.replace(/_/g, ' ')} · Explicit scopes only. Native geometry is not validated; fit, clearance and manufacturability are not evaluated. Physical qualification: false.</Text>
    {u.materials.map(row => <Text key={row.local_id}>Material {row.local_id} · {row.target_local_id ?? 'mechanical item'} · {row.status.replace(/_/g, ' ')} · {row.specification ?? 'specification unknown'} · behavior {row.behavior ?? 'unknown'} · basis {row.basis ?? 'unknown'}</Text>)}
    {u.processes.map(row => <Text key={row.local_id}>Process {row.local_id} · {row.target_local_id ?? 'mechanical item'} · {row.status.replace(/_/g, ' ')} · {row.method ?? 'method unknown'} · parameters {row.parameters.join('; ') || 'unknown'} · behavior {row.behavior ?? 'unknown'} · basis {row.basis ?? 'unknown'}</Text>)}
    {u.tolerances.map(row => <Text key={row.local_id}>Tolerance {row.local_id} · {row.target_local_id ?? 'mechanical item'}/{row.model_local_id ?? 'no model scope'} · {row.dimension} · {row.status.replace(/_/g, ' ')} · deviation {row.lower_deviation ?? 'unknown'} to {row.upper_deviation ?? 'unknown'} mm · basis {row.basis ?? 'unknown'}</Text>)}
    {u.connector_envelopes.map(row => <Text key={row.local_id}>Connector envelope {row.local_id} · {row.target_local_id}/{row.usage} · {row.status.replace(/_/g, ' ')} · min {row.minimum?.join(', ') ?? 'unknown'} / max {row.maximum?.join(', ') ?? 'unknown'} mm · frame {row.frame ?? 'unknown'} · basis {row.basis ?? 'unknown'}</Text>)}
    {assessment.prerequisites.map((row, index) => <Text key={index} size="sm">{row.status.replace(/_/g, ' ')} · {row.scope.target_local_id ?? 'mechanical item'}{row.scope.model_local_id ? `/${row.scope.model_local_id}` : ''} · {row.message}</Text>)}
  </Stack>;
}

export function MechanicalUncertaintyEditor({ source, onChange }: { source: MechanicalSource; onChange: (value: MechanicalUncertainty) => void }) {
  const u = source.uncertainty ?? unknownUncertainty();
  const scopeOptions = [{ value: '__item__', label: 'Mechanical item itself' }, ...source.targets.map(t => ({ value: t.local_id, label: t.local_id }))];
  function change<K extends keyof MechanicalUncertainty>(kind: K, id: string, changes: Partial<MechanicalUncertainty[K][number]>) {
    onChange({ ...u, [kind]: u[kind].map(row => row.local_id === id ? { ...row, ...changes } : row) });
  }
  function common(kind: keyof MechanicalUncertainty, row: ScopedAssumption) {
    const prefix = `${kind} ${row.local_id}`;
    return <>
      <Text size="sm">{row.local_id}</Text>
      <Select label={`Scope for ${prefix}`} data={kind === 'connector_envelopes' ? scopeOptions.slice(1) : scopeOptions} value={row.target_local_id ?? '__item__'} onChange={value => { if (value) change(kind, row.local_id, { target_local_id: value === '__item__' ? null : value, ...(kind === 'tolerances' ? { model_local_id: null } : {}) }); }} />
      <Select label={`Status for ${prefix}`} data={statuses} value={row.status} onChange={value => {
        if (!value) return;
        const status = value as AssumptionStatus;
        let cleared = {};
        if (status !== 'declared') {
          if (kind === 'materials') cleared = { specification: null, behavior: null };
          if (kind === 'processes') cleared = { method: null, parameters: [], behavior: null };
          if (kind === 'tolerances') cleared = { lower_deviation: null, upper_deviation: null };
          if (kind === 'connector_envelopes') cleared = { minimum: null, maximum: null, frame: null };
        }
        change(kind, row.local_id, { status, ...cleared });
      }} />
      <Textarea label={`Basis for ${prefix}`} description="Declare the assumption's provenance and limits. Declared and not applicable require justification." value={row.basis ?? ''} onChange={e => change(kind, row.local_id, { basis: nullable(e.currentTarget.value) })} />
      <Button size="xs" variant="subtle" onClick={() => onChange({ ...u, [kind]: u[kind].filter(r => r.local_id !== row.local_id) })}>Remove {prefix}</Button>
    </>;
  }
  const scoped = (id: string): ScopedAssumption => ({ local_id: id, target_local_id: null, status: 'unknown', basis: null });
  return <Stack>
    <Title order={4}>Material, process and geometry uncertainty</Title>
    <Text size="sm">Empty scopes are unassessed. Declare only the relevant item/target and connector usage. Bounds are declarations in mm; they do not validate geometry, correspondence, operating configurations or physical fit.</Text>
    <Button variant="default" onClick={() => onChange({ ...u, materials: [...u.materials, { ...scoped(local('material', u.materials)), specification: null, behavior: null }] })}>Add material assumption</Button>
    {u.materials.map(row => <Card withBorder key={row.local_id}><Stack>{common('materials', row)}{row.status === 'declared' && <>
      <TextInput label={`Material specification for ${row.local_id}`} value={row.specification ?? ''} onChange={e => change('materials', row.local_id, { specification: nullable(e.currentTarget.value) })} />
      <Textarea label={`Material behavior for ${row.local_id}`} placeholder="Unknown" value={row.behavior ?? ''} onChange={e => change('materials', row.local_id, { behavior: nullable(e.currentTarget.value) })} />
    </>}</Stack></Card>)}
    <Button variant="default" onClick={() => onChange({ ...u, processes: [...u.processes, { ...scoped(local('process', u.processes)), method: null, parameters: [], behavior: null }] })}>Add process assumption</Button>
    {u.processes.map(row => <Card withBorder key={row.local_id}><Stack>{common('processes', row)}{row.status === 'declared' && <>
      <TextInput label={`Process method for ${row.local_id}`} value={row.method ?? ''} onChange={e => change('processes', row.local_id, { method: nullable(e.currentTarget.value) })} />
      <Textarea label={`Process parameters for ${row.local_id}`} value={row.parameters.join('\n')} onChange={e => change('processes', row.local_id, { parameters: e.currentTarget.value.split('\n').filter(Boolean) })} />
      <Textarea label={`Process behavior for ${row.local_id}`} placeholder="Unknown" value={row.behavior ?? ''} onChange={e => change('processes', row.local_id, { behavior: nullable(e.currentTarget.value) })} />
    </>}</Stack></Card>)}
    <Button variant="default" onClick={() => onChange({ ...u, tolerances: [...u.tolerances, { ...scoped(local('tolerance', u.tolerances)), model_local_id: null, dimension: 'Unassessed dimension', units: 'mm', lower_deviation: null, upper_deviation: null }] })}>Add tolerance assumption</Button>
    {u.tolerances.map(row => <Card withBorder key={row.local_id}><Stack>{common('tolerances', row)}
      <Select label={`Exact model scope for ${row.local_id}`} clearable data={source.models.filter(m => m.target_local_id === row.target_local_id).map(m => ({ value: m.local_id, label: m.local_id }))} value={row.model_local_id} onChange={value => change('tolerances', row.local_id, { model_local_id: value })} />
      <TextInput label={`Dimension or stable feature for ${row.local_id}`} value={row.dimension} onChange={e => change('tolerances', row.local_id, { dimension: e.currentTarget.value })} />
      {row.status === 'declared' && <Group><NumberInput label={`Lower deviation (mm) for ${row.local_id}`} value={row.lower_deviation ?? ''} onChange={value => change('tolerances', row.local_id, { lower_deviation: typeof value === 'number' ? value : null })} /><NumberInput label={`Upper deviation (mm) for ${row.local_id}`} value={row.upper_deviation ?? ''} onChange={value => change('tolerances', row.local_id, { upper_deviation: typeof value === 'number' ? value : null })} /></Group>}
    </Stack></Card>)}
    <Button variant="default" disabled={!source.targets.length} onClick={() => onChange({ ...u, connector_envelopes: [...u.connector_envelopes, { ...scoped(local('envelope', u.connector_envelopes)), target_local_id: source.targets[0]!.local_id, usage: 'body', units: 'mm', minimum: null, maximum: null, frame: null }] })}>Add connector envelope scope</Button>
    {u.connector_envelopes.map(row => <Card withBorder key={row.local_id}><Stack>{common('connector_envelopes', row)}
      <Select label={`Connector usage for ${row.local_id}`} data={['body', 'mated', 'installation', 'cable_route']} value={row.usage} onChange={value => value && change('connector_envelopes', row.local_id, { usage: value as ConnectorEnvelope['usage'] })} />
      {row.status === 'declared' && <>
        <TextInput label={`Envelope frame for ${row.local_id}`} value={row.frame ?? ''} onChange={e => change('connector_envelopes', row.local_id, { frame: nullable(e.currentTarget.value) })} />
        <Text size="sm">All six bounds must be supplied; an omitted bound stays unknown.</Text>
        {(['minimum', 'maximum'] as const).map(bound => <Group key={bound}>{['X', 'Y', 'Z'].map((axis, i) => <NumberInput key={axis} label={`${bound} ${axis} (mm) for ${row.local_id}`} value={row[bound]?.[i] ?? ''} onChange={value => {
          // Retain partial bounds locally; JSON null is rejected until the user completes them.
          const values = [...(row[bound] ?? [null, null, null])]; values[i] = typeof value === 'number' ? value : null;
          change('connector_envelopes', row.local_id, { [bound]: values });
        }} />)}</Group>)}
      </>}
    </Stack></Card>)}
  </Stack>;
}
