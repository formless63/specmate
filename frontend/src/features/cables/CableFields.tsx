import { IntentBindings } from "./IntentBindings";
import { LengthsEditor } from './Lengths';
import { Alert, Anchor, Group, SegmentedControl, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { loadFrozenStock } from '../wire-stock/viewer-api';
import type { Body, Inspection as InterfaceInspection } from '../interfaces/api';
import { read, type Cable, type Endpoint, type Definition } from './api';
import { RevisionPicker } from './RevisionPicker';
import { SbUnknown } from '../../components/sb';
import { connectorStack, resolveDenied, splitKey, terminalKey, type ResolvedStack } from '../end-assemblies/api';
import { SignalCell, StackDiagram, StackEditor, StackView, findTerminal, resolvedChips, targetOptions, useResolvedStacks } from '../end-assemblies/StackEditor';
import { CableSummary, endName } from './CableSummary';
import { Swatch } from '../cable-views/Swatch';
import { appearanceOf } from '../../../../packages/section-layout/src';
import { FromPreference, usePreferenceDefaults } from '../preferences/usePreferenceDefaults';
import { conductiveElements } from '../cable-workbench/model';

/** Connector bodies of each end's resolved stack, for drawing their faces. */
export function useBodies(stacks: (ResolvedStack | undefined)[]): (Body | null | undefined)[] {
  const ids = stacks.map(s => s?.body_revision_id ?? null);
  const bodies = useQueries({ queries: ids.map(id => ({
    queryKey: ['cable-body', id], queryFn: () => read<InterfaceInspection>(`interfaces/revisions/${id}`), enabled: !!id, retry: false,
  })) });
  return bodies.map(b => (b.data?.interface && (b.data.interface as { kind?: string }).kind === 'connector_body' ? b.data.interface as Body : null));
}

type Choice = { value: string; label: string; display: string; look: ReturnType<typeof appearanceOf> };
/** Conductive elements of a stock as termination rows: the stock's label and color for display, the path kept for identity. */
function elements(structure: Parameters<typeof conductiveElements>[0]): Choice[] {
  return conductiveElements(structure).map(e => ({ value: e.path, label: `${e.path} · ${e.label} (${e.kind})`, display: e.display, look: e.look }));
}

type Sources = ReturnType<typeof useCableSources>;
/**
 * Everything a cable's pinned references resolve to, read under the cable's authority: the stock,
 * every connector/board layer revision and each end's resolved stack. A denial withdraws retained choices.
 */
export function useCableSources(value: Cable, workspaceId: string | null | undefined, onAuthorityChange?: (denied: boolean) => void) {
  const stock = useQuery({ queryKey: ['cable-stock', value.stock_revision_id], queryFn: () => loadFrozenStock(value.stock_revision_id), enabled: !!value.stock_revision_id });
  const references = [...new Map(value.endpoints.flatMap(endpoint => (endpoint.stack?.layers ?? []).flatMap(layer =>
    layer.kind === 'connector' ? [{ key: 'cable-body', id: layer.body_revision_id }] : layer.kind === 'board' ? [{ key: 'cable-board', id: layer.board_revision_id }] : [],
  )).filter(reference => reference.id).map(reference => [`${reference.key}:${reference.id}`, reference])).values()];
  const sources = useQueries({ queries: references.map(reference => ({
    queryKey: [reference.key, reference.id],
    queryFn: () => read<InterfaceInspection>(`interfaces/revisions/${reference.id}`),
  })) });
  const resolved = useResolvedStacks(value.endpoints);
  const denied = stock.isError || sources.some(source => source.isError) || resolved.some(r => r.isError && resolveDenied(r.error));
  useEffect(() => onAuthorityChange?.(denied), [denied, onAuthorityChange]);
  const choices = stock.data && !denied ? elements(stock.data.structure) : [];
  // A connector-family preference only narrows the body picker by name; it never selects a body or asserts compatibility.
  const families = usePreferenceDefaults(workspaceId).list('connector_families');
  const familyKey = families.join('\u0000');
  const [family, setFamily] = useState<string | null>(null);
  const [familyFromPreference, setFamilyFromPreference] = useState(false);
  const [familyTouched, setFamilyTouched] = useState(false);
  useEffect(() => { if (familyKey && !familyTouched) { setFamily(familyKey.split('\u0000')[0] ?? null); setFamilyFromPreference(true); } }, [familyKey, familyTouched]);
  const chooseFamily = (next: string | null) => { setFamilyTouched(true); setFamilyFromPreference(false); setFamily(next); };
  return { stock, resolved, denied, choices, families, family, familyFromPreference, chooseFamily };
}

/** The whole-cable fields: stock, intent, connector family filter, lengths and review. */
export function CableFields({ value, onChange, definitions, sources, errors = {}, showReview = true, showSelections = true }: { showSelections?: boolean; showReview?: boolean; value: Cable; onChange: (value: Cable) => void; definitions?: Definition[]; sources: Sources; errors?: Record<string, string> }) {
  const setStock = useCallback((stock_revision_id: string) => onChange({ ...value, stock_revision_id }), [onChange, value]);
  const { stock, denied, choices, families, family, familyFromPreference, chooseFamily } = sources;
  return <Stack gap="sm">
    {showSelections && <><Stack gap="xs" aria-label="Stock">
      <Title order={4}>Stock</Title>
      <Text size="sm" c="dimmed">The wire material this cable is cut from.</Text>
      <RevisionPicker error={errors["cable.stock_revision_id"]} label="Stock" title="Stock" kind="wire_stock" value={value.stock_revision_id} onChange={setStock} definitions={definitions} />
      {stock.isError && <Alert color="red">{stock.error.message}</Alert>}
    </Stack>
    <Stack gap="xs" aria-label="Intent">
      <Title order={4}>Intent</Title>
      <Text size="sm" c="dimmed">What this cable must connect, if stated. Checking the cable against it comes later; it never passes by itself.</Text>
      <RevisionPicker label="Intent" title="Cable intent (optional)" kind="cable_intent" value={value.intent_revision_id ?? ''} onChange={intent => onChange({ ...value, intent_revision_id: intent || null })} definitions={definitions} />
      <IntentBindings value={value} endpoints={value.endpoints} stacks={sources.resolved.map(query => query.data)} onChange={patch => onChange({ ...value, ...patch })} />
    </Stack>
    </>}{families.length > 0 && <Group align="flex-end" gap="xs"><Select label="Connector family filter" description="Narrows connector body choices by name." clearable data={families} value={family} onChange={chooseFamily} />
      {familyFromPreference && family !== null && <FromPreference what="connector family filter" onClear={() => chooseFamily(null)} />}</Group>}
    {!denied && <LengthsEditor value={value.lengths} onChange={lengths => onChange({ ...value, lengths })} choices={choices} endpoints={value.endpoints.map(e => e.local_id)} />}
    {showReview && <Stack gap="xs" aria-label="Review">
      <Title order={4}>Review</Title>
      <Select label="Review status" data={['unreviewed', 'reviewed']} value={value.review} onChange={review => onChange({ ...value, review: review as Cable['review'] })} />
      <TextInput label="Review basis" description="Required once reviewed." value={value.review_basis ?? ''} onChange={event => onChange({ ...value, review_basis: event.currentTarget.value || null })} />
    </Stack>}
  </Stack>;
}

/** The whole cable as stacked forms (summary, cable fields, each end): the inspector's forms in one column. */
export function CableEditor({ value, onChange, definitions, onAuthorityChange, workspaceId, errors = {} }: { errors?: Record<string, string>; workspaceId?: string | null; value: Cable; onChange: (value: Cable) => void; definitions: Definition[]; onAuthorityChange?: (denied: boolean) => void }) {
  const sources = useCableSources(value, workspaceId, onAuthorityChange);
  const { stock, resolved, denied, choices, family } = sources;
  return <Stack>
    <CableSummary cable={denied ? { ...value, assignments: [] } : value} elementCount={stock.data && !denied ? choices.length : null} stacks={denied ? [] : resolved.map(r => r.data)} />
    <CableFields value={value} onChange={onChange} definitions={definitions} sources={sources} errors={errors} />
    {value.endpoints.map((_endpoint, index) => <EndCard key={index} index={index} value={value} onChange={onChange} errors={errors} family={family} definitions={definitions} choices={choices} denied={denied} resolved={resolved[index]!} />)}
  </Stack>;
}
const HIDDEN_LABEL = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' } as const;
const DEFAULT_NOTE = 'Declared in the cable editor';
const letter = (index: number) => String.fromCharCode(65 + index);
const STOCK_ENDS = [{ value: 'unknown', label: 'Stock end unknown' }, { value: 'a', label: 'Stock end A' }, { value: 'b', label: 'Stock end B' }];
export function EndCard({ index, value, onChange, errors, family, definitions, choices, denied, resolved }: { index: number; value: Cable; onChange: (value: Cable) => void; errors: Record<string, string>; family: string | null; definitions?: Definition[]; choices: Choice[]; denied: boolean; resolved: UseQueryResult<ResolvedStack> }) {
  const endpoint = value.endpoints[index]!;
  const [showId, setShowId] = useState(false);
  const [showLayers, setShowLayers] = useState(false);
  const patch = (change: Partial<Endpoint>) => onChange({ ...value, endpoints: value.endpoints.map((e, i) => i === index ? { ...e, ...change } : e) });
  const name = `Endpoint ${index + 1}`;
  const fromAssembly = endpoint.end_assembly_revision_id !== null;
  const data = denied ? undefined : resolved.data;
  return <Stack>
    <Title order={4}>{endName(endpoint)}</Title>
    <Group align="flex-end" gap="xs" wrap="wrap">
      <TextInput label={`End ${letter(index)} name (optional)`} aria-label={`Endpoint ${index + 1} label`} placeholder={`End ${letter(index)}`} value={endpoint.label ?? ''} onChange={event => patch({ label: event.currentTarget.value || null })} />
      <Select label="Uses stock end" aria-label={`${name} stock end`} description="Which end of the stock this end is on." data={STOCK_ENDS} value={endpoint.stock_end} onChange={v => patch({ stock_end: (v ?? 'unknown') as Endpoint['stock_end'] })} />
    </Group>
    <Anchor component="button" type="button" size="xs" w="fit-content" aria-expanded={showId} onClick={() => setShowId(open => !open)}>{showId ? '▾' : '▸'} Advanced: stable ID</Anchor>
    {showId && <TextInput label={`Endpoint ${index + 1} stable ID`} description="Renaming an ID retains its current assignments." value={endpoint.local_id} onChange={event => { const local_id = event.currentTarget.value; onChange({ ...value, endpoints: value.endpoints.map((e, i) => i === index ? { ...e, local_id } : e), assignments: value.assignments.map(a => a.endpoint_id === endpoint.local_id ? { ...a, endpoint_id: local_id } : a) }); }} />}
    <SegmentedControl size="xs" w="fit-content" aria-label={`${name} end source`} value={fromAssembly ? 'assembly' : endpoint.stack ? 'stack' : ''} onChange={mode => patch(mode === 'assembly' ? { end_assembly_revision_id: '', stack: null } : { end_assembly_revision_id: null, stack: connectorStack() })}
      data={[{ value: 'assembly', label: 'Reusable end assembly' }, { value: 'stack', label: 'Build this end here' }]} />
    {!fromAssembly && !endpoint.stack && <Text size="sm" c="orange" role="status">Choose an end assembly or build this end.</Text>}
    {fromAssembly && <>
      <RevisionPicker error={errors[`cable.endpoints.${index}.end_assembly_revision_id`]} label={`${name} end assembly`} title="End assembly" kind="end_assembly" nameFilter={family} value={endpoint.end_assembly_revision_id ?? ''} onChange={end_assembly_revision_id => patch({ end_assembly_revision_id })} definitions={definitions} />
      {data && <><StackDiagram layers={resolvedChips(data)} label={`${name} stack`} />
        <Anchor component="button" type="button" size="xs" w="fit-content" aria-expanded={showLayers} onClick={() => setShowLayers(open => !open)}>{showLayers ? '▾' : '▸'} Layers, pads and pins</Anchor>
        {showLayers && <StackView resolved={data} label={name} />}</>}
    </>}
    {!fromAssembly && endpoint.stack && <StackEditor label={name} value={endpoint.stack} onChange={stack => patch({ stack })} definitions={definitions} resolved={data} nameFilter={family} />}
    {resolved.isError && <Alert color={resolveDenied(resolved.error) ? 'red' : 'orange'}>{resolved.error.message}</Alert>}
    <TerminationEditor value={value} index={index} choices={choices} onChange={onChange} denied={denied} hasStock={!!value.stock_revision_id} resolved={data} />
  </Stack>;
}
/** One end's terminations as a table: the accessible fallback to landing wires in the drawing. */
function TerminationEditor({ value, index, choices, onChange, denied, hasStock, resolved }: { value: Cable; index: number; choices: Choice[]; onChange: (value: Cable) => void; denied: boolean; hasStock: boolean; resolved: ResolvedStack | undefined }) {
  const endpoint = value.endpoints[index]!;
  const [notes, setNotes] = useState<Record<string, string>>({});
  const own = denied ? [] : value.assignments.filter(a => a.endpoint_id === endpoint.local_id);
  const rows: Choice[] = [...choices, ...own.filter(a => !choices.some(c => c.value === a.element_path)).map(a => ({ value: a.element_path, label: a.element_path, display: `${a.element_path} (not in this stock)`, look: appearanceOf({ kind: 'conductor', color: null, material: null, construction: null }) }))];
  const groups = targetOptions(resolved);
  const known = new Set(groups.flatMap(g => g.items.map(i => i.value)));
  const stale = own.filter(a => !known.has(terminalKey(a))).map(a => ({ value: terminalKey(a), label: `${a.layer_id} / ${a.terminal_id} (not in this end)` }));
  const data = stale.length ? [...groups, { group: 'Not in this end', items: [...new Map(stale.map(s => [s.value, s])).values()] }] : groups;
  const name = `Endpoint ${index + 1}`;
  const assign = (path: string, target: string | null) => {
    const others = value.assignments.filter(a => !(a.endpoint_id === endpoint.local_id && a.element_path === path));
    const previous = own.find(a => a.element_path === path);
    onChange({ ...value, assignments: target ? [...others, { endpoint_id: endpoint.local_id, element_path: path, ...splitKey(target), basis: previous?.basis ?? (notes[path]?.trim() || DEFAULT_NOTE) }] : others });
  };
  const note = (path: string, text: string) => {
    if (own.some(a => a.element_path === path)) onChange({ ...value, assignments: value.assignments.map(a => a.endpoint_id === endpoint.local_id && a.element_path === path ? { ...a, basis: text } : a) });
    else setNotes(current => ({ ...current, [path]: text }));
  };
  return <Stack gap="xs">
    <Group justify="space-between"><Text fw={600} size="sm">Terminations at {endName(endpoint)}</Text><Text size="xs">{choices.length ? `${own.length} of ${choices.length} terminated` : `${own.length} terminated`}</Text></Group>
    {!denied && !hasStock && <Text size="sm" role="status">Choose a stock to list its conductors, shields and drains.</Text>}
    {!denied && hasStock && !resolved && <Text size="sm" role="status">Choose this end's layers to list its pads and pins.</Text>}
    {rows.length > 0 && <Table.ScrollContainer minWidth={560}><Table aria-label={`${name} terminations`} verticalSpacing={4}>
      <Table.Thead><Table.Tr><Table.Th>Conductor / shield / drain</Table.Th><Table.Th>Lands on</Table.Th><Table.Th>Signal</Table.Th><Table.Th>Note / source</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{rows.map(row => {
        const assignment = own.find(a => a.element_path === row.value);
        const target = assignment ? findTerminal(resolved, assignment.layer_id, assignment.terminal_id).terminal : undefined;
        return <Table.Tr key={row.value}><Table.Td title={row.value}><Swatch look={row.look} />{row.display}</Table.Td>
          <Table.Td><Select size="xs" clearable searchable label={`${name} ${row.value} target`} styles={{ label: HIDDEN_LABEL }} placeholder="unassigned" disabled={denied || !resolved} data={data} value={denied || !assignment ? null : terminalKey(assignment)} onChange={target => assign(row.value, target)} /></Table.Td>
          <Table.Td>{target ? <SignalCell terminal={target} /> : assignment ? <SbUnknown what="Signal" /> : null}</Table.Td>
          <Table.Td><TextInput size="xs" aria-label={`${name} ${row.value} termination basis`} placeholder={DEFAULT_NOTE} value={assignment ? assignment.basis : notes[row.value] ?? ''} onChange={event => note(row.value, event.currentTarget.value)} /></Table.Td></Table.Tr>;
      })}</Table.Tbody></Table></Table.ScrollContainer>}
  </Stack>;
}

/**
 * A frozen cable on the workbench (read-only drawing, probe and check), with the recorded
 * inspection tables and stock views kept below as details.
 */
