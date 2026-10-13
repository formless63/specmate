import { Alert, Button, Card, Group, MultiSelect, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { useQueries } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { StockElement, StockSpecification } from '../../../../packages/section-layout/src';
import type { Interface } from '../interfaces/api';
import { RevisionPicker } from './RevisionPicker';
import { read, terminalKey, terminalLabel, type Breakout, type Definition, type Fate, type Harness, type Joint, type SegmentEnd, type SegmentTerminal, type Terminal } from './api';

type Choice = { value: string; label: string; terminal: Terminal };
type Source = { content?: { stock?: StockSpecification }; interface?: Interface };
function conductive(node: StockElement, prefix = ''): string[] {
  const path = prefix ? `${prefix}.${node.id}` : node.id;
  return node.kind === 'group' ? node.children.flatMap(c => conductive(c, path)) : ['conductor', 'shield', 'drain'].includes(node.kind) ? [path] : [];
}
export function HarnessEditor({ value, onChange, definitions, onAuthorityChange }: { value: Harness; onChange: (v: Harness) => void; definitions: Definition[]; onAuthorityChange?: (denied: boolean) => void }) {
  const refs = [...new Set([...value.sections.map(s => s.stock_revision_id ? `revisions/${s.stock_revision_id}/snapshot` : ''), ...value.endpoints.flatMap(e => [e.body_revision_id, e.pinout_revision_id].map(id => id ? `interfaces/revisions/${id}` : ''))].filter(Boolean))];
  const sources = useQueries({ queries: refs.map(path => ({ queryKey: ['harness-source', path], queryFn: () => read<Source>(path) })) });
  const denied = sources.some(source => source.isError);
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
  for (const endpoint of value.endpoints) {
    const body = source(`interfaces/revisions/${endpoint.body_revision_id}`)?.interface;
    const pins = source(`interfaces/revisions/${endpoint.pinout_revision_id}`)?.interface;
    if (body?.kind !== 'connector_body' || pins?.kind !== 'pinout' || pins.body_revision_id !== endpoint.body_revision_id) continue;
    for (const contact of body.contacts.filter(c => c.physical_role !== 'key')) {
      const terminal: Terminal = { kind: 'endpoint', endpoint_id: endpoint.local_id, contact_id: contact.contact_id };
      choices.push({ value: terminalKey(terminal), label: terminalLabel(terminal), terminal });
    }
  }
  const [sectionId, setSectionId] = useState('');
  const [segmentId, setSegmentId] = useState('');
  const [segmentSection, setSegmentSection] = useState<string | null>(null);
  const [endpointId, setEndpointId] = useState('');
  return <Stack>
    {sources.filter(s => s.isError).map((s, i) => <Alert color="red" key={i}>{s.error?.message}</Alert>)}
    <Title order={4}>Physical stock sections</Title><Text>One section is one original stock piece. Several segment spans can share it without adding pieces. Planned cuts remain independent of route or finished lengths.</Text>
    {value.sections.map((section, index) => <Card key={section.local_id} withBorder><Stack><Text fw={600}>Section {section.local_id}</Text>
      <RevisionPicker label={`Section ${section.local_id} stock`} kind="wire_stock" value={section.stock_revision_id} definitions={definitions} onChange={id => onChange({ ...value, sections: value.sections.map((s, i) => i === index ? { ...s, stock_revision_id: id } : s) })} />
      <TextInput label={`Section ${section.local_id} planned cut (mm); blank = unknown`} inputMode="decimal" value={section.planned_cut_length_mm ?? ''} onChange={e => onChange({ ...value, sections: value.sections.map((s, i) => i === index ? { ...s, planned_cut_length_mm: e.currentTarget.value || null } : s) })} />
      <TextInput label={`Section ${section.local_id} cut basis`} value={section.cut_basis ?? ''} onChange={e => onChange({ ...value, sections: value.sections.map((s, i) => i === index ? { ...s, cut_basis: e.currentTarget.value || null } : s) })} />
      <Button variant="subtle" onClick={() => onChange({ ...value, sections: value.sections.filter((_, i) => i !== index) })}>Remove section {section.local_id}</Button>
    </Stack></Card>)}
    <Group><TextInput label="New physical section ID" value={sectionId} onChange={e => setSectionId(e.currentTarget.value)} /><Button disabled={!sectionId || value.sections.some(s => s.local_id === sectionId)} onClick={() => { onChange({ ...value, sections: [...value.sections, { local_id: sectionId, stock_revision_id: '', planned_cut_length_mm: null, cut_basis: null }] }); setSectionId(''); }}>Add physical section</Button></Group>
    <Title order={4}>Segment spans</Title>
    {value.segments.map((segment, index) => {
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
    <Title order={4}>Connector endpoints</Title>
    {value.endpoints.map((endpoint, index) => <Card key={endpoint.local_id} withBorder><Stack><Text>Endpoint {endpoint.local_id}</Text><RevisionPicker label={`Endpoint ${endpoint.local_id} body`} kind="connector_body" value={endpoint.body_revision_id} definitions={definitions} onChange={id => onChange({ ...value, endpoints: value.endpoints.map((e, i) => i === index ? { ...e, body_revision_id: id } : e) })} /><RevisionPicker label={`Endpoint ${endpoint.local_id} pinout`} kind="pinout" value={endpoint.pinout_revision_id} definitions={definitions} onChange={id => onChange({ ...value, endpoints: value.endpoints.map((e, i) => i === index ? { ...e, pinout_revision_id: id } : e) })} /><Button variant="subtle" onClick={() => onChange({ ...value, endpoints: value.endpoints.filter((_, i) => i !== index) })}>Remove endpoint {endpoint.local_id}</Button></Stack></Card>)}
    <Group><TextInput label="New connector endpoint ID" value={endpointId} onChange={e => setEndpointId(e.currentTarget.value)} /><Button disabled={!endpointId || value.endpoints.some(e => e.local_id === endpointId)} onClick={() => { onChange({ ...value, endpoints: [...value.endpoints, { local_id: endpointId, label: null, body_revision_id: '', pinout_revision_id: '' }] }); setEndpointId(''); }}>Add connector endpoint</Button></Group>
    <JointEditor value={value} choices={choices} denied={denied} onChange={onChange} />
    <BreakoutEditor value={value} choices={choices} denied={denied} onChange={onChange} />
    <Select label="Harness review" data={['unreviewed', 'reviewed']} value={value.review} onChange={review => onChange({ ...value, review: review as Harness['review'] })} /><TextInput label="Harness review basis" value={value.review_basis ?? ''} onChange={e => onChange({ ...value, review_basis: e.currentTarget.value || null })} />
  </Stack>;
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
