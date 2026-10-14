import { Alert, Button, Card, Checkbox, Group, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { read } from './api';
import { revisionOptionLabel } from "../../lib/revision-labels";
import { RevisionLabel } from "../../lib/IdentityLabel";

export type Declaration = { amount_mm: string | null; basis: 'unknown' | 'human_declaration'; explanation: string | null };
export type Allowance = { kind: 'slack' | 'preparation' | 'trim'; amount_mm: string | null; explanation: string; scope: 'whole_length' | 'endpoint'; endpoint_id: string | null };
export type Model = { source: 'route' | 'finished' | 'stock_cut'; allowances: Allowance[]; review: 'unreviewed' | 'reviewed'; review_basis: string | null };
export type Prepared = { declaration: Declaration; model: Model | null };
export type LengthPlan = { route: Declaration; finished: Prepared; stock_cut: Prepared; conductor_cuts: (Prepared & { element_path: string })[] };
export type LengthRow = { target: string; declaration: Declaration; model: Model | null; suggested_mm: string | null; status: string; declaration_matches_suggestion: boolean | null; stock_revision_id: string; element_path?: string; element_kind?: string };
export type Projection = { rows: LengthRow[] };
export type Impact = { before_revision_id: string; after_revision_id: string; before_sha256: string; after_sha256: string; route_changed: boolean; preparation_review_required: boolean; document_review_required: boolean; stock_revision_changed: boolean; changes: { target: string; before: LengthRow | null; after: LengthRow | null }[]; sections: ImpactSection[] };
export type ImpactSection = { section: string; status: 'changed' | 'uncomparable'; reviews: ('preparation' | 'documents')[]; summary: string; details: Record<string, unknown>[] };
const shown = (value: unknown) => value == null ? 'none' : String(value);
function sectionDetail(section: ImpactSection, detail: Record<string, unknown>): string {
  if (section.section === 'terminations') return `${shown(detail.element_path)} at ${shown(detail.endpoint_id)}: contact ${shown(detail.before_contact_id)} → ${shown(detail.after_contact_id)}`;
  if (section.section === 'labels') return `${shown(detail.endpoint_id)}: ${shown(detail.before)} → ${shown(detail.after)}`;
  if (section.section === 'connectors') return `End ${shown(detail.endpoint_id)}: body or pinout pin changed`;
  if (section.section === 'lengths') return shown(detail.target);
  if ('field' in detail) return `Field ${shown(detail.field)}`;
  return '';
}
export function ImpactSections({ sections }: { sections: ImpactSection[] }) {
  if (!sections.length) return <Text>No document-affecting section changed between these revisions.</Text>;
  return <Table.ScrollContainer minWidth={560}><Table aria-label="Changed document sections"><Table.Thead><Table.Tr><Table.Th>Section</Table.Th><Table.Th>Comparison</Table.Th><Table.Th>Review required</Table.Th><Table.Th>Change</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{sections.map(section => <Table.Tr key={section.section}>
    <Table.Td>{section.section}</Table.Td>
    <Table.Td>{section.status}</Table.Td>
    <Table.Td>{section.reviews.join(', ')}</Table.Td>
    <Table.Td><Text size="sm">{section.summary}</Text>{section.details.map((detail, index) => { const text = sectionDetail(section, detail); return text ? <Text key={index} size="xs">{text}</Text> : null; })}</Table.Td>
  </Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer>;
}
const unknown = (): Declaration => ({ amount_mm: null, basis: 'unknown', explanation: null });
const prepared = (): Prepared => ({ declaration: unknown(), model: null });
export const emptyLengths = (): LengthPlan => ({ route: unknown(), finished: prepared(), stock_cut: prepared(), conductor_cuts: [] });

function DeclarationEditor({ label, value, onChange }: { label: string; value: Declaration; onChange: (v: Declaration) => void }) {
  return <Group align="end"><TextInput label={`${label} declared mm`} description="Blank means unknown; exact decimal text." value={value.amount_mm ?? ''} onChange={e => onChange({ ...value, amount_mm: e.currentTarget.value || null, basis: e.currentTarget.value ? 'human_declaration' : 'unknown' })} /><TextInput label={`${label} declaration basis`} value={value.explanation ?? ''} onChange={e => onChange({ ...value, explanation: e.currentTarget.value || null })} /></Group>;
}
function PreparedEditor({ label, value, sources, endpoints, onChange }: { label: string; value: Prepared; sources: string[]; endpoints: string[]; onChange: (v: Prepared) => void }) {
  const model = value.model;
  const changeModel = (next: Model) => onChange({ ...value, model: next });
  return <Card withBorder><Stack gap="xs"><Title order={5}>{label}</Title>
    <DeclarationEditor label={label} value={value.declaration} onChange={declaration => onChange({ ...value, declaration })} />
    <Checkbox label={`${label} explicit length model`} checked={!!model} onChange={e => onChange({ ...value, model: e.currentTarget.checked ? { source: 'route', allowances: [], review: 'unreviewed', review_basis: null } : null })} />
    {model && <><Select label={`${label} model source`} data={sources} value={model.source} onChange={source => changeModel({ ...model, source: source as Model['source'] })} />
      <Text size="sm">Uses the source's modeled suggestion when a model exists, otherwise its declaration. Unknown or unreviewed models stay unknown. Slack and preparation add; trim subtracts. Empty allowance list explicitly adds zero.</Text>
      {model.allowances.map((allowance, index) => {
        const update = (next: Allowance) => changeModel({ ...model, allowances: model.allowances.map((a, i) => i === index ? next : a) });
        const prefix = `${label} allowance ${index + 1}`;
        return <Card key={index} withBorder><Stack gap="xs"><Select label={`${prefix} kind`} data={['slack', 'preparation', 'trim']} value={allowance.kind} onChange={kind => update({ ...allowance, kind: kind as Allowance['kind'] })} />
          <TextInput label={`${prefix} mm`} value={allowance.amount_mm ?? ''} onChange={e => update({ ...allowance, amount_mm: e.currentTarget.value || null })} />
          <TextInput label={`${prefix} basis`} value={allowance.explanation} onChange={e => update({ ...allowance, explanation: e.currentTarget.value })} />
          <Select label={`${prefix} scope`} data={['whole_length', 'endpoint']} value={allowance.scope} onChange={scope => update({ ...allowance, scope: scope as Allowance['scope'], endpoint_id: null })} />
          {allowance.scope === 'endpoint' && <Select label={`${prefix} endpoint`} data={endpoints} value={allowance.endpoint_id} onChange={endpoint_id => update({ ...allowance, endpoint_id })} />}
          <Button variant="subtle" onClick={() => changeModel({ ...model, allowances: model.allowances.filter((_, i) => i !== index) })}>Remove {prefix}</Button>
        </Stack></Card>;
      })}
      <Button variant="light" onClick={() => changeModel({ ...model, allowances: [...model.allowances, { kind: 'slack', amount_mm: null, explanation: '', scope: 'whole_length', endpoint_id: null }] })}>Add {label} allowance</Button>
      <Select label={`${label} model review`} data={['unreviewed', 'reviewed']} value={model.review} onChange={review => changeModel({ ...model, review: review as Model['review'] })} />
      <TextInput label={`${label} model review basis`} value={model.review_basis ?? ''} onChange={e => changeModel({ ...model, review_basis: e.currentTarget.value || null })} />
    </>}
  </Stack></Card>;
}
export function LengthsEditor({ value, onChange, choices, endpoints }: { value: LengthPlan | null | undefined; onChange: (v: LengthPlan | null) => void; choices: { value: string; label: string }[]; endpoints: string[] }) {
  const [path, setPath] = useState<string | null>(null);
  return <Stack><Title order={4}>Routing and preparation lengths</Title><Text>Human declarations and reviewed model suggestions are separate. No geometry route, prepend interpretation, physical clearance or qualification is inferred. Saving a route never applies a suggested cut.</Text>
    <Checkbox label="Record independent cable lengths" checked={!!value} onChange={e => onChange(e.currentTarget.checked ? emptyLengths() : null)} />
    {value && <><DeclarationEditor label="Route" value={value.route} onChange={route => onChange({ ...value, route })} />
      <PreparedEditor label="Finished" value={value.finished} sources={['route']} endpoints={endpoints} onChange={finished => onChange({ ...value, finished })} />
      <PreparedEditor label="Stock cut" value={value.stock_cut} sources={['route', 'finished']} endpoints={endpoints} onChange={stock_cut => onChange({ ...value, stock_cut })} />
      {value.conductor_cuts.map((cut, index) => <Stack key={cut.element_path}><PreparedEditor label={`Conductor ${cut.element_path}`} value={cut} sources={['route', 'finished', 'stock_cut']} endpoints={endpoints} onChange={next => onChange({ ...value, conductor_cuts: value.conductor_cuts.map((row, i) => i === index ? { ...next, element_path: cut.element_path } : row) })} /><Button variant="subtle" onClick={() => onChange({ ...value, conductor_cuts: value.conductor_cuts.filter((_, i) => i !== index) })}>Remove length for {cut.element_path}</Button></Stack>)}
      <Select label="Conductor cut stock feature" data={choices.filter(choice => !value.conductor_cuts.some(c => c.element_path === choice.value))} value={path} onChange={setPath} />
      <Button disabled={!path || !choices.some(c => c.value === path) || value.conductor_cuts.some(c => c.element_path === path)} onClick={() => { if (path) { onChange({ ...value, conductor_cuts: [...value.conductor_cuts, { ...prepared(), element_path: path }] }); setPath(null); } }}>Add conductor cut length</Button>
    </>}
  </Stack>;
}
const amount = (value: string | null | undefined) => value == null ? 'unknown' : `${value} mm`;
export function LengthInspection({ projection }: { projection: Projection }) {
  return <Stack><Title order={4}>Declared lengths and model suggestions</Title><Text>Suggestions require manual review and never replace declarations. Geometry routes and prepend remain unsupported; clearance and physical qualification are not evaluated.</Text>
    <Table><Table.Thead><Table.Tr><Table.Th>Length identity</Table.Th><Table.Th>Human declaration</Table.Th><Table.Th>Reviewed model suggestion</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{projection.rows.map(row => <Table.Tr key={row.target}>
      <Table.Td>{row.target}<Text size="xs"><RevisionLabel id={row.stock_revision_id} role="Stock" />{row.element_kind ? ` · ${row.element_kind} · ${row.element_path}` : ''}</Text></Table.Td>
      <Table.Td>{amount(row.declaration.amount_mm)}<Text size="sm">{row.declaration.basis}: {row.declaration.explanation ?? 'unknown basis'}</Text></Table.Td>
      <Table.Td>{amount(row.suggested_mm)} · {row.status}{row.declaration_matches_suggestion === false && <Alert color="orange">Declaration differs from model suggestion.</Alert>}{row.model && <><Text>Source: {row.model.source}; {row.model.review}: {row.model.review_basis ?? 'unknown review basis'}</Text>{row.model.allowances.map((a, i) => <Text key={i}>{a.kind} {amount(a.amount_mm)} · {a.scope}{a.endpoint_id ? ` ${a.endpoint_id}` : ''} · {a.explanation}</Text>)}</>}</Table.Td>
    </Table.Tr>)}</Table.Tbody></Table>
  </Stack>;
}
export function LengthImpactView({ afterRevision, name, revisions }: { afterRevision: string; name?: string; revisions: { revision_id: string; number: number }[] }) {
  const [before, setBefore] = useState<string | null>(null);
  const result = useQuery({ queryKey: ['cable-length-impact', before, afterRevision], queryFn: () => read<Impact>(`cables/length-impact?before_revision_id=${encodeURIComponent(before ?? '')}&after_revision_id=${encodeURIComponent(afterRevision)}`), enabled: !!before, retry: false });
  return <Card withBorder><Stack><Title order={4}>Preparation and document impacts</Title><Select label="Compare lengths from frozen revision" data={revisions.filter(r => r.revision_id !== afterRevision).map(r => ({ value: r.revision_id, label: revisionOptionLabel(name, r.number) }))} value={before} onChange={setBefore} />
    <Button disabled={!before} loading={result.isFetching} onClick={() => result.refetch()}>Refresh length impact access</Button>
    {result.isError && <Alert color="red">{result.error.message}</Alert>}
    {result.data && !result.isError && !result.isFetching && <><Text>Route changed: {String(result.data.route_changed)}. Preparation review required: {String(result.data.preparation_review_required)}. Document review required: {String(result.data.document_review_required)}.</Text><Text>Stock revision changed: {String(result.data.stock_revision_changed)}. No stock facts or cut declarations were written by this comparison.</Text><Text size="xs"><RevisionLabel id={result.data.before_revision_id} role="Before" sha256={result.data.before_sha256} />; <RevisionLabel id={result.data.after_revision_id} role="after" sha256={result.data.after_sha256} /></Text>
      {result.data.changes.map(change => <Text key={change.target}>{change.target}: declared {amount(change.before?.declaration.amount_mm)} → {amount(change.after?.declaration.amount_mm)}; suggestion {amount(change.before?.suggested_mm)} → {amount(change.after?.suggested_mm)}</Text>)}
      {!result.data.changes.length && <Text>No length-plan changes.</Text>}
      <ImpactSections sections={result.data.sections} />
    </>}
  </Stack></Card>;
}
