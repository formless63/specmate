import { Alert, Button, Group, Select, Stack, Table, Text, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { AssociationForm } from '../pcb/PopulationEditor';
import { associationTargets, getIntake, type NativeReport, type Population, type PopulationReview } from '../pcb/api';
import { RevisionLabel } from '../../lib/IdentityLabel';

export function PopulationChoices({ value, report, editable, onChange }: { value: Population; report: NativeReport; editable: boolean; onChange: (value: Population) => void }) {
  const [chosen, setChosen] = useState<string | null>(null); const [name, setName] = useState(''); const [page, setPage] = useState(0);
  const option = value.options.find(row => row.local_id === chosen) ?? value.options[0];
  const update = (component: string, patch: { status?: 'populate' | 'omit' | null; basis?: string | null }) => {
    if (!editable || !option) return;
    const old = option.decisions.find(row => row.component_id === component) ?? { component_id: component, status: null, basis: null };
    const next = { ...old, ...patch }; if (next.status === null) next.basis = null;
    onChange({ ...value, options: value.options.map(row => row.local_id === option.local_id ? { ...row, decisions: [...row.decisions.filter(item => item.component_id !== component), next] } : row) });
  };
  return <Stack gap="xs"><Text size="xs">Option decisions are separate from native DNP flags. Unknown remains unresolved; neither a source flag nor a review establishes manufacture or compatibility.</Text>
    <Select size="xs" label="Population option" value={option?.local_id ?? null} data={value.options.map(row => ({ value: row.local_id, label: row.name }))} onChange={id => { setChosen(id); setPage(0); }} />
    {option && <><Table.ScrollContainer minWidth={300}><Table verticalSpacing={4}><Table.Thead><Table.Tr><Table.Th>Component / source DNP</Table.Th><Table.Th>Decision / basis</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{report.components.slice(page * 25, page * 25 + 25).map(component => {
      const decision = option.decisions.find(row => row.component_id === component.id);
      return <Table.Tr key={component.id}><Table.Td>{component.reference}<Text size="xs">{component.value || 'Value unknown'} · DNP {component.dnp ? 'set' : 'unset'} in source</Text></Table.Td><Table.Td><Select size="xs" disabled={!editable} aria-label={`${component.reference} population decision`} value={decision?.status ?? 'unknown'} data={['unknown', 'populate', 'omit']} onChange={status => update(component.id, { status: status === 'unknown' ? null : status as 'populate' | 'omit' })} /><TextInput size="xs" disabled={!editable || !decision?.status} aria-label={`${component.reference} decision basis`} value={decision?.basis ?? ''} onChange={event => update(component.id, { basis: event.currentTarget.value || null })} /></Table.Td></Table.Tr>;
    })}</Table.Tbody></Table></Table.ScrollContainer><Group gap="xs"><Button size="xs" variant="quiet" disabled={!page} onClick={() => setPage(value => value - 1)}>Previous components</Button><Button size="xs" variant="quiet" disabled={(page + 1) * 25 >= report.components.length} onClick={() => setPage(value => value + 1)}>More components</Button></Group></>}
    {editable && <><TextInput size="xs" label="New population option" value={name} onChange={event => setName(event.currentTarget.value)} /><Group gap="xs"><Button size="xs" disabled={!name.trim()} onClick={() => {
      const stem = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 45); const base = /^[a-z]/.test(stem) ? stem : 'option'; let id = base; let number = 2; while (value.options.some(row => row.local_id === id)) id = `${base}-${number++}`;
      onChange({ ...value, options: [...value.options, { local_id: id, name: name.trim(), decisions: report.components.map(component => ({ component_id: component.id, status: null, basis: null })) }] }); setChosen(id); setName('');
    }}>Add option</Button><Button size="xs" variant="quiet" disabled={!option || value.options.length <= 1} onClick={() => { onChange({ ...value, options: value.options.filter(row => row.local_id !== option?.local_id) }); setChosen(null); }}>Remove selected option</Button></Group></>}
  </Stack>;
}

export function PopulationAssociations({ value, review, editable, active, principalKey, workspaceId, onChange, onAccessLost }: {
  value: Population; review: PopulationReview; editable: boolean; active: boolean; principalKey: string; workspaceId: string; onChange: (value: Population) => void; onAccessLost: (error: unknown) => void;
}) {
  const intake = useQuery({ queryKey: ['board-association-intake', principalKey, review.interpretation.intake_id], enabled: active, retry: false, queryFn: ({ signal }) => getIntake(review.interpretation.intake_id, signal) });
  const targets = useQuery({ queryKey: ['board-association-targets', principalKey, workspaceId], enabled: active && editable, retry: false, queryFn: ({ signal }) => associationTargets(workspaceId, signal) });
  useEffect(() => { if (intake.isError) onAccessLost(intake.error); if (targets.isError) onAccessLost(targets.error); }, [intake.isError, targets.isError, intake.error, targets.error, onAccessLost]);
  const available = active && !intake.isError && !targets.isError && intake.isSuccess && !intake.isFetching && (!editable || targets.isSuccess && !targets.isFetching);
  const retained = useRef<{ intake: NonNullable<typeof intake.data>; targets: typeof targets.data } | null>(null);
  if (available) retained.current = { intake: intake.data!, targets: targets.data };
  const status = active && !available ? intake.isError || targets.isError ? <Alert color="red">Association inputs unavailable. Retained choices are hidden.</Alert> : <Text role="status">Reading exact association inputs…</Text> : null;
  return <>{status}<Stack gap="xs" hidden={!available} inert={!available}><Text size="xs">Apply records to the working buffer, then Save population. Candidate, accepted and rejected are human review states, not compatibility.</Text>
    {value.associations.map(row => <Stack key={row.local_id} gap={2}><Text>{row.kind} · {review.report.components.find(component => component.id === row.component_id)?.reference ?? 'Unknown component'} · {row.review}</Text>
      {row.target_revision_id && <RevisionLabel id={row.target_revision_id} role="Exact target" />}{row.representation_id && <Text size="xs">Model representation {row.representation_id}</Text>}<Text size="xs">{row.basis ?? 'Basis unknown'}</Text>
      {editable && <Button size="xs" variant="quiet" onClick={() => onChange({ ...value, associations: value.associations.filter(item => item.local_id !== row.local_id) })}>Remove association {row.local_id}</Button>}
    </Stack>)}
    {editable && retained.current && <AssociationForm report={review.report} intake={retained.current.intake} population={value} targets={retained.current.targets ?? null} disabled={!editable} actionLabel="Apply association to draft" onSave={async association => { onChange({ ...value, associations: [...value.associations.filter(row => row.local_id !== association.local_id), association] }); return true; }} />}
    {targets.data?.truncated.revisions && <Text size="xs">Target revision choices reached their existing bounded limit.</Text>}{targets.data?.truncated.models && <Text size="xs">Model choices reached their existing bounded limit.</Text>}
  </Stack></>;
}

export function NativePadDetails({ report, selected, onSelect }: { report: NativeReport; selected: string | null; onSelect: (id: string | null) => void }) {
  const [page, setPage] = useState(0); const pad = report.pads.find(row => row.id === selected);
  return <Stack gap="xs"><Text size="xs">Native pad identities are scoped to this exact accepted report. Labels and net names do not establish schematic or connector correspondence.</Text>
    {pad && <><Text fw={500}>{report.components.find(row => row.id === pad.component_id)?.reference ?? 'Unknown component'} · pad {pad.terminal}</Text><Text size="xs">{pad.position.join(', ')} mm · {pad.type} · source net {pad.net || 'Unassigned'}</Text><Text size="xs">Native pad {pad.id}</Text><Button size="xs" variant="quiet" onClick={() => onSelect(null)}>Clear native pad</Button></>}
    {report.pads.slice(page * 25, page * 25 + 25).map(row => <Button size="xs" variant="quiet" key={row.id} onClick={() => onSelect(row.id)}>{report.components.find(item => item.id === row.component_id)?.reference ?? 'Unknown'} · {row.terminal} · {row.net || 'Unassigned'}</Button>)}
    <Group gap="xs"><Button size="xs" variant="quiet" disabled={!page} onClick={() => setPage(value => value - 1)}>Previous native pads</Button><Button size="xs" variant="quiet" disabled={(page + 1) * 25 >= report.pads.length} onClick={() => setPage(value => value + 1)}>More native pads</Button></Group>
  </Stack>;
}
