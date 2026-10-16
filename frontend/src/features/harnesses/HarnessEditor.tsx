import { Alert, Button, Card, Group, MultiSelect, SegmentedControl, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { useQueries } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { StockElement, StockSpecification } from '../../../../packages/section-layout/src';
import { RevisionPicker as CatalogRevisionPicker } from '../cables/RevisionPicker';
import { connectorStack, resolveDenied, type ResolvedStack } from '../end-assemblies/api';
import { StackDiagram, StackEditor, resolvedChips, useResolvedStacks } from '../end-assemblies/StackEditor';
import { PhysicalEndsEditor } from './PhysicalEndsEditor';
import { read, terminalKey, terminalLabel, type Breakout, type Definition, type Endpoint, type Fate, type Harness, type Joint, type SegmentEnd, type SegmentTerminal, type Terminal } from './api';

type Choice = { value: string; label: string; terminal: Terminal };
type Source = { content?: { stock?: StockSpecification } };
function conductive(node: StockElement, prefix = ''): string[] {
  const path = prefix ? `${prefix}.${node.id}` : node.id;
  return node.kind === 'group' ? node.children.flatMap(c => conductive(c, path)) : ['conductor', 'shield', 'drain'].includes(node.kind) ? [path] : [];
}
export type HarnessEditorSection = 'sections' | 'segments' | 'endpoints' | 'joints' | 'breakouts' | 'review';
export function HarnessEditor({ value, onChange, definitions, onAuthorityChange, onReferenceDenied, section, selectedId, active = true }: { active?: boolean; section?: HarnessEditorSection; selectedId?: string | null; value: Harness; onChange: (v: Harness) => void; definitions: Definition[]; onAuthorityChange?: (denied: boolean) => void; onReferenceDenied?: (path: string, reason: unknown) => void }) {
  const refs = [...new Set(value.sections.map(s => s.stock_revision_id ? `revisions/${s.stock_revision_id}/snapshot` : '').filter(Boolean))];
  const sources = useQueries({ queries: refs.map(path => ({ queryKey: ['harness-source', path], enabled: active, queryFn: async () => { try { return await read<Source>(path); } catch (reason) { onReferenceDenied?.(path, reason); throw reason; } } })) });
  // Each endpoint's stack is resolved by the server: labeled terminals and typed signals.
  const stacks = useResolvedStacks(value.endpoints, active);
  const deniedEnds = value.endpoints.filter((_, i) => resolveDenied(stacks[i]?.error)).map(e => e.local_id);
  const stackDenied = deniedEnds.length > 0;
  const deniedKey = deniedEnds.join('|');
  useEffect(() => { for (const id of deniedKey ? deniedKey.split('|') : []) onReferenceDenied?.(`end-stack:${id}`, new Error('End stack unavailable')); }, [deniedKey, onReferenceDenied]);
  const denied = sources.some(source => source.isError) || stackDenied;
  useEffect(() => onAuthorityChange?.(denied), [denied, onAuthorityChange]);
  const source = (path: string) => { const result = sources[refs.indexOf(path)]; return !denied && !result?.isError ? result?.data : undefined; };
  const choices: Choice[] = [];
  for (const segment of value.segments) {
    const section = value.sections.find(s => s.local_id === segment.section_id);
    const stock = section && source(`revisions/${section.stock_revision_id}/snapshot`)?.content?.stock;
    const paths = stock ? conductive(stock.structure).filter(path => segment.element_paths === null || segment.element_paths.includes(path)) : [];
    for (const path of paths) for (const end of ['a', 'b'] as const) {
      const terminal: Terminal = { kind: 'segment', segment_id: segment.local_id, end, element_path: path };
      choices.push({ value: terminalKey(terminal), label: terminalLabel(terminal), terminal });
    }
  }
  value.endpoints.forEach((endpoint, index) => {
    const resolved = denied ? undefined : stacks[index]?.data;
    for (const layer of resolved?.layers ?? []) for (const t of layer.terminals) {
      const terminal: Terminal = { kind: 'endpoint', endpoint_id: endpoint.local_id, layer_id: layer.layer_id, terminal_id: t.terminal_id };
      const signal = t.signal?.name ?? t.reaches.map(r => r.signal?.name).filter(Boolean).join(', ');
      choices.push({ value: terminalKey(terminal), label: `${endpoint.label ?? endpoint.local_id} / ${layer.kind} ${t.label}${signal ? ` · ${signal}` : ''}`, terminal });
    }
  });
  const [sectionId, setSectionId] = useState('');
  const [segmentId, setSegmentId] = useState('');
  const [segmentSection, setSegmentSection] = useState<string | null>(null);
  const [endpointId, setEndpointId] = useState('');
  return <Stack>
    {sources.filter(s => s.isError).map((s, i) => <Alert color="red" key={i}>{s.error?.message}</Alert>)}
    {(!section || section === 'sections') && <><Title order={4}>Physical stock sections</Title><Text>One section is one original stock piece. Several segment spans can share it without adding pieces. Planned cuts remain independent of route or finished lengths.</Text>
    {value.sections.map((section, index) => !selectedId || selectedId === section.local_id ? <Card key={section.local_id} withBorder><Stack><Text fw={600}>Section {section.local_id}</Text>
      <CatalogRevisionPicker label={`Section ${section.local_id} stock`} kind="wire_stock" value={section.stock_revision_id} definitions={definitions} onChange={id => onChange({ ...value, sections: value.sections.map((s, i) => i === index ? { ...s, stock_revision_id: id } : s) })} />
      <TextInput label={`Section ${section.local_id} planned cut (mm); blank = unknown`} inputMode="decimal" value={section.planned_cut_length_mm ?? ''} onChange={e => onChange({ ...value, sections: value.sections.map((s, i) => i === index ? { ...s, planned_cut_length_mm: e.currentTarget.value || null } : s) })} />
      <TextInput label={`Section ${section.local_id} cut basis`} value={section.cut_basis ?? ''} onChange={e => onChange({ ...value, sections: value.sections.map((s, i) => i === index ? { ...s, cut_basis: e.currentTarget.value || null } : s) })} />
      <PhysicalEndsEditor section={section} segments={value.segments} endpoints={value.endpoints} hidden={denied} onChange={physical_ends => onChange({ ...value, sections: value.sections.map((s, i) => i === index ? { ...s, physical_ends } : s) })} />
      <Button variant="subtle" onClick={() => onChange({ ...value, sections: value.sections.filter((_, i) => i !== index) })}>Remove section {section.local_id}</Button>
    </Stack></Card> : null)}
    <Group><TextInput label="New physical section ID" value={sectionId} onChange={e => setSectionId(e.currentTarget.value)} /><Button disabled={!sectionId || value.sections.some(s => s.local_id === sectionId)} onClick={() => { onChange({ ...value, sections: [...value.sections, { local_id: sectionId, stock_revision_id: '', planned_cut_length_mm: null, cut_basis: null }] }); setSectionId(''); }}>Add physical section</Button></Group>
    </>}
    {(!section || section === 'segments') && <><Title order={4}>Segment spans</Title>
    {value.segments.map((segment, index) => {
      if (selectedId && selectedId !== segment.local_id) return null;
      const section = value.sections.find(s => s.local_id === segment.section_id);
      const stock = section && source(`revisions/${section.stock_revision_id}/snapshot`)?.content?.stock;
      return <Card key={segment.local_id} withBorder><Stack><Text>{segment.local_id} → physical section {segment.section_id}</Text>
        <Select label={`Segment ${segment.local_id} section`} value={segment.section_id} data={value.sections.map(s => s.local_id)} onChange={id => { if (id) onChange({ ...value, segments: value.segments.map((s, i) => i === index ? { ...s, section_id: id } : s) }); }} />
        <Select label={`Segment ${segment.local_id} feature scope`} value={segment.element_paths === null ? 'all' : 'selected'} data={[{ value: 'all', label: 'All conductive features' }, { value: 'selected', label: 'Explicit feature subset' }]} onChange={v => onChange({ ...value, segments: value.segments.map((s, i) => i === index ? { ...s, element_paths: v === 'all' ? null : [] } : s) })} />
        {segment.element_paths !== null && <MultiSelect label={`Segment ${segment.local_id} conductive paths`} disabled={denied} data={stock ? conductive(stock.structure) : []} value={denied ? [] : segment.element_paths} onChange={paths => onChange({ ...value, segments: value.segments.map((s, i) => i === index ? { ...s, element_paths: paths } : s) })} />}
        <Button variant="subtle" onClick={() => onChange({ ...value, segments: value.segments.filter((_, i) => i !== index) })}>Remove segment {segment.local_id}</Button>
      </Stack></Card>;
    })}
    <Group><TextInput label="New segment ID" value={segmentId} onChange={e => setSegmentId(e.currentTarget.value)} /><Select label="New segment physical section" data={value.sections.map(s => s.local_id)} value={segmentSection} onChange={setSegmentSection} /><Button disabled={!segmentId || !segmentSection || value.segments.some(s => s.local_id === segmentId)} onClick={() => { if (segmentSection) onChange({ ...value, segments: [...value.segments, { local_id: segmentId, section_id: segmentSection, label: null, element_paths: null }] }); setSegmentId(''); }}>Add segment span</Button></Group>
    </>}
    {(!section || section === 'endpoints') && <><Title order={4}>Endpoints</Title><Text size="sm">Each endpoint is an end stack, from the wire outward: an end assembly from the Library, or board, inline parts, connector and shell declared here.</Text>
    {value.endpoints.map((endpoint, index) => !selectedId || selectedId === endpoint.local_id ? <EndpointCard key={endpoint.local_id} endpoint={endpoint} definitions={definitions} resolved={denied ? undefined : stacks[index]?.data} error={stacks[index]?.error ?? null} onChange={next => onChange({ ...value, endpoints: value.endpoints.map((e, i) => i === index ? next : e) })} onRemove={() => onChange({ ...value, endpoints: value.endpoints.filter((_, i) => i !== index) })} /> : null)}
    <Group><TextInput label="New endpoint ID" value={endpointId} onChange={e => setEndpointId(e.currentTarget.value)} /><Button disabled={!endpointId || value.endpoints.some(e => e.local_id === endpointId)} onClick={() => { onChange({ ...value, endpoints: [...value.endpoints, { local_id: endpointId, label: null, end_assembly_revision_id: null, stack: connectorStack() }] }); setEndpointId(''); }}>Add endpoint</Button></Group>
    </>}
    {(!section || section === 'joints') && <JointEditor value={value} choices={choices} denied={denied} onChange={onChange} />}
    {(!section || section === 'breakouts') && <BreakoutEditor value={value} choices={choices} denied={denied} onChange={onChange} />}
    {(!section || section === 'review') && <><Select label="Harness review" data={['unreviewed', 'reviewed']} value={value.review} onChange={review => onChange({ ...value, review: review as Harness['review'] })} /><TextInput label="Harness review basis" value={value.review_basis ?? ''} onChange={e => onChange({ ...value, review_basis: e.currentTarget.value || null })} /></>}
  </Stack>;
}
/** One endpoint: label, then an end assembly or an ad-hoc stack (the cable end editor's stack builder). */
function EndpointCard({ endpoint, definitions, resolved, error, onChange, onRemove }: { endpoint: Endpoint; definitions: Definition[]; resolved: ResolvedStack | undefined; error: Error | null; onChange: (e: Endpoint) => void; onRemove: () => void }) {
  const fromAssembly = endpoint.end_assembly_revision_id !== null;
  const name = endpoint.label ?? `Endpoint ${endpoint.local_id}`;
  return <Card withBorder padding="sm"><Stack gap="xs">
    <Group justify="space-between"><Text fw={600}>Endpoint {endpoint.local_id}</Text><Button size="compact-xs" variant="subtle" onClick={onRemove}>Remove endpoint {endpoint.local_id}</Button></Group>
    <TextInput label={`Endpoint ${endpoint.local_id} label`} value={endpoint.label ?? ''} onChange={e => onChange({ ...endpoint, label: e.currentTarget.value || null })} />
    <SegmentedControl size="xs" w="fit-content" aria-label={`Endpoint ${endpoint.local_id} source`} value={fromAssembly ? 'assembly' : 'stack'} onChange={mode => onChange({ ...endpoint, ...(mode === 'assembly' ? { end_assembly_revision_id: '', stack: null } : { end_assembly_revision_id: null, stack: connectorStack() }) })}
      data={[{ value: 'assembly', label: 'End assembly' }, { value: 'stack', label: 'Build the stack here' }]} />
    {fromAssembly && <CatalogRevisionPicker label={`Endpoint ${endpoint.local_id} end assembly`} title="End assembly" kind="end_assembly" value={endpoint.end_assembly_revision_id ?? ''} onChange={id => onChange({ ...endpoint, end_assembly_revision_id: id })} definitions={definitions} />}
    {resolved && <StackDiagram layers={resolvedChips(resolved)} label={`${name} stack`} />}
    {!fromAssembly && endpoint.stack && <StackEditor label={name} value={endpoint.stack} onChange={stack => onChange({ ...endpoint, stack })} definitions={definitions} resolved={resolved} />}
    {error && <Alert color="red">{error.message}</Alert>}
  </Stack></Card>;
}

function JointEditor({ value, choices, denied, onChange }: { value: Harness; choices: Choice[]; denied: boolean; onChange: (v: Harness) => void }) {
  const [id, setId] = useState(''); const [kind, setKind] = useState<Joint['kind']>('splice'); const [members, setMembers] = useState<string[]>([]); const [basis, setBasis] = useState('');
  const available = choices.filter(c => !value.joints.some(j => j.members.some(t => terminalKey(t) === c.value)));
  return <Stack><Title order={4}>Declared joints and shield bonds</Title><Text>One exact terminal belongs to one joint. A shield bond needs shield, drain or shell targets and an explicit basis.</Text>
    {!denied && value.joints.map((joint, index) => <Card key={joint.local_id} withBorder><Text>{joint.local_id} ({joint.kind}): {joint.members.map(terminalLabel).join(' ↔ ')}</Text><Text>Basis: {joint.basis}</Text><Button variant="subtle" onClick={() => onChange({ ...value, joints: value.joints.filter((_, i) => i !== index) })}>Remove joint {joint.local_id}</Button></Card>)}
    <TextInput label="Joint stable ID" value={id} onChange={e => setId(e.currentTarget.value)} /><Select label="Joint declaration kind" data={['termination', 'splice', 'shield_bond']} value={kind} onChange={v => setKind(v as Joint['kind'])} /><MultiSelect label="Joint exact members" searchable data={available} disabled={denied} value={denied ? [] : members} onChange={setMembers} /><TextInput label="Joint declaration basis" value={basis} onChange={e => setBasis(e.currentTarget.value)} />
    <Button disabled={denied || !id || !basis || members.length < 2 || members.some(m => !available.some(c => c.value === m)) || value.joints.some(j => j.local_id === id)} onClick={() => { onChange({ ...value, joints: [...value.joints, { local_id: id, kind, members: members.map(m => choices.find(c => c.value === m)!.terminal), basis }] }); setId(''); setMembers([]); }}>Add declared joint</Button>
  </Stack>;
}
function BreakoutEditor({ value, choices, denied, onChange }: { value: Harness; choices: Choice[]; denied: boolean; onChange: (v: Harness) => void }) {
  const [id, setId] = useState(''); const [trunk, setTrunk] = useState<string | null>(null); const [legs, setLegs] = useState<string[]>([]);
  const ends = value.segments.flatMap(s => (['a', 'b'] as const).map(end => ({ value: JSON.stringify({ segment_id: s.local_id, end }), label: `${s.local_id} / ${end}` })));
  return <Stack><Title order={4}>Breakout fates</Title><Text>Every uncut mapping pairs one trunk feature with one leg feature on the same original section. Missing fates remain unknown; a joint fate references an existing joint.</Text>
    {!denied && value.breakouts.map((breakout, index) => <Card key={breakout.local_id} withBorder><Stack><Text fw={600}>Breakout {breakout.local_id}: {breakout.trunk.segment_id}/{breakout.trunk.end} → {breakout.legs.map(e => `${e.segment_id}/${e.end}`).join(', ')}</Text>
      <FateEditor breakout={breakout} joints={value.joints} choices={choices} onChange={next => onChange({ ...value, breakouts: value.breakouts.map((b, i) => i === index ? next : b) })} />
      <Button variant="subtle" onClick={() => onChange({ ...value, breakouts: value.breakouts.filter((_, i) => i !== index) })}>Remove breakout {breakout.local_id}</Button>
    </Stack></Card>)}
    <TextInput label="Breakout stable ID" value={id} onChange={e => setId(e.currentTarget.value)} /><Select label="Breakout trunk end" value={denied ? null : trunk} data={denied ? [] : ends} disabled={denied} onChange={setTrunk} /><MultiSelect label="Breakout leg ends" data={denied ? [] : ends.filter(e => e.value !== trunk)} value={denied ? [] : legs} disabled={denied} onChange={setLegs} />
    <Button disabled={denied || !id || !trunk || !legs.length || legs.includes(trunk) || value.breakouts.some(b => b.local_id === id)} onClick={() => { if (trunk) onChange({ ...value, breakouts: [...value.breakouts, { local_id: id, trunk: JSON.parse(trunk) as SegmentEnd, legs: legs.map(v => JSON.parse(v) as SegmentEnd), fates: [] }] }); setId(''); setTrunk(null); setLegs([]); }}>Add breakout</Button>
  </Stack>;
}
function FateEditor({ breakout, joints, choices, onChange }: { breakout: Breakout; joints: Joint[]; choices: Choice[]; onChange: (b: Breakout) => void }) {
  const [id, setId] = useState(''); const [kind, setKind] = useState<Fate['kind']>('through'); const [from, setFrom] = useState<string | null>(null); const [to, setTo] = useState<string | null>(null); const [joint, setJoint] = useState<string | null>(null); const [basis, setBasis] = useState('');
  const atEnd = (choice: Choice, ends: SegmentEnd[]) => choice.terminal.kind === 'segment' && ends.some(e => choice.terminal.kind === 'segment' && e.segment_id === choice.terminal.segment_id && e.end === choice.terminal.end);
  const assigned = new Set(breakout.fates.flatMap(f => f.kind === 'through' ? [terminalKey(f.trunk), terminalKey(f.leg)] : [terminalKey(f.terminal)]));
  const available = choices.filter(c => !assigned.has(c.value));
  const fromChoices = available.filter(c => atEnd(c, kind === 'through' ? [breakout.trunk] : [breakout.trunk, ...breakout.legs]));
  const toChoices = available.filter(c => atEnd(c, breakout.legs));
  const valid = id && !breakout.fates.some(f => f.local_id === id) && fromChoices.some(c => c.value === from) && (kind === 'joint' ? joint && joints.some(j => j.local_id === joint && j.members.some(m => terminalKey(m) === from)) : basis && (kind !== 'through' || toChoices.some(c => c.value === to)));
  return <Stack>
    {breakout.fates.map((fate, index) => <Group key={fate.local_id}><Text>{fate.local_id}: {fate.kind} · {fate.kind === 'through' ? `${terminalLabel(fate.trunk)} ↔ ${terminalLabel(fate.leg)}` : terminalLabel(fate.terminal)} · {fate.kind === 'joint' ? fate.joint_id : fate.basis}</Text><Button variant="subtle" onClick={() => onChange({ ...breakout, fates: breakout.fates.filter((_, i) => i !== index) })}>Remove fate {fate.local_id}</Button></Group>)}
    <TextInput label={`${breakout.local_id} fate ID`} value={id} onChange={e => setId(e.currentTarget.value)} /><Select label={`${breakout.local_id} fate kind`} data={['through', 'joint', 'unconnected']} value={kind} onChange={v => { setKind(v as Fate['kind']); setFrom(null); setTo(null); }} /><Select label={`${breakout.local_id} exact terminal`} data={fromChoices} value={from} onChange={setFrom} />
    {kind === 'through' && <Select label={`${breakout.local_id} uncut leg terminal`} data={toChoices} value={to} onChange={setTo} />}
    {kind === 'joint' ? <Select label={`${breakout.local_id} existing joint`} data={joints.filter(j => j.members.some(m => terminalKey(m) === from)).map(j => j.local_id)} value={joint} onChange={setJoint} /> : <TextInput label={`${breakout.local_id} fate basis`} value={basis} onChange={e => setBasis(e.currentTarget.value)} />}
    <Button disabled={!valid} onClick={() => {
      const terminal = choices.find(c => c.value === from)!.terminal as SegmentTerminal;
      const fate: Fate = kind === 'through' ? { local_id: id, kind, trunk: terminal, leg: choices.find(c => c.value === to)!.terminal as SegmentTerminal, basis } : kind === 'joint' ? { local_id: id, kind, terminal, joint_id: joint! } : { local_id: id, kind, terminal, basis };
      onChange({ ...breakout, fates: [...breakout.fates, fate] }); setId(''); setFrom(null); setTo(null);
    }}>Add fate to {breakout.local_id}</Button>
  </Stack>;
}
