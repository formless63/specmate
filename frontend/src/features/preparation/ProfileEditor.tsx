import { Button, Card, Group, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import type { StockElement } from '../../../../packages/section-layout/src';
import { SbQuantity, SbUnknown } from "../../components/sb";
import type { Source } from '../workshop-profiles/api';
import { emptyFormula, type Formula, type Profile } from './api';
import { RevisionLabel } from "../../lib/IdentityLabel";

export function conductiveChoices(node: StockElement, prefix = ''): { value: string; label: string }[] {
  const path = prefix ? `${prefix}.${node.id}` : node.id;
  return node.kind === 'group' ? node.children.flatMap(child => conductiveChoices(child, path)) : ['conductor', 'shield', 'drain'].includes(node.kind) ? [{ value: path, label: `${path} · ${node.kind}` }] : [];
}
export function SourceEditor({ label, source, onChange }: { label: string; source: Source | null; onChange: (s: Source | null) => void }) {
  return <Stack gap="xs"><Select label={`${label} source kind`} value={source?.kind ?? 'unknown'} data={['unknown', 'citation', 'source_file']} onChange={kind => onChange(kind === 'citation' ? { kind, citation: '' } : kind === 'source_file' ? { kind, bundle_revision_id: '', path: '', locator: '', sha256: '', rights: '' } : null)} />
    {source?.kind === 'citation' && <TextInput label={`${label} unverified citation`} value={source.citation} onChange={e => onChange({ ...source, citation: e.currentTarget.value })} />}
    {source?.kind === 'source_file' && (['bundle_revision_id', 'path', 'sha256', 'rights', 'locator'] as const).map(field => <TextInput key={field} label={`${label} source ${field}`} value={source[field]} onChange={e => onChange({ ...source, [field]: e.currentTarget.value })} />)}
  </Stack>;
}
export function FormulaInspection({ formula }: { formula: Formula }) {
  return <Stack gap="xs"><Text fw={600}>{formula.local_id} · {formula.label} · {formula.target}{formula.element_path ? ` · ${formula.element_path}` : ''}</Text><Text>Input {formula.input_length}, {formula.input_basis}; {formula.review}: {formula.review_basis ?? <SbUnknown what="basis" />}</Text>
    {!formula.allowances.length && <Text>No allowances: explicitly add zero.</Text>}
    {formula.allowances.map(a => <Stack key={a.local_id} gap={0}><Text>{a.local_id}: {a.kind} <SbQuantity value={a.amount_mm} unit="mm" /> · {a.scope} · {a.basis}</Text>{a.source?.kind === 'citation' && <Text>Unverified citation: {a.source.citation}</Text>}{a.source?.kind === 'source_file' && <Text><RevisionLabel kind="source" id={a.source.bundle_revision_id} role="Registered evidence" /> · {a.source.path} · {a.source.sha256} · rights {a.source.rights} · {a.source.locator}</Text>}</Stack>)}
  </Stack>;
}
export function ProfileEditor({ value, onChange, choices }: { value: Profile; onChange: (p: Profile) => void; choices: { value: string; label: string }[] }) {
  const change = (index: number, formula: Formula) => onChange({ ...value, formulas: value.formulas.map((f, i) => i === index ? formula : f) });
  return <Stack><Text>These engineering formulas are separate from illustrative workshop cutbacks and leads. Blank allowances remain unknown. Slack and preparation add; trim subtracts. Profile ends A/B do not infer connector associations.</Text>
    {value.formulas.map((f, i) => { const label = `Formula ${i + 1}`; return <Card key={i} withBorder><Stack><Title order={4}>{label}</Title>
      <Group><TextInput label={`${label} stable ID`} value={f.local_id} onChange={e => change(i, { ...f, local_id: e.currentTarget.value })} /><TextInput label={`${label} label`} value={f.label} onChange={e => change(i, { ...f, label: e.currentTarget.value })} /></Group>
      <Select label={`${label} target`} data={['stock_piece', 'conductive_feature']} value={f.target} onChange={target => change(i, { ...f, target: target as Formula['target'], element_path: null })} />
      {f.target === 'conductive_feature' && <Select label={`${label} exact stock feature`} data={choices} value={f.element_path} onChange={element_path => change(i, { ...f, element_path })} />}
      <Select label={`${label} input length`} data={['route', 'finished', 'stock_cut', ...(f.target === 'conductive_feature' ? ['conductor_cut'] : [])]} value={f.input_length} onChange={input_length => change(i, { ...f, input_length: input_length as Formula['input_length'] })} />
      <Select label={`${label} input basis`} data={['declaration', 'model_suggestion']} value={f.input_basis} onChange={input_basis => change(i, { ...f, input_basis: input_basis as Formula['input_basis'] })} />
      <Text size="sm">Harness sections expose their planned stock-cut declaration. An unavailable input stays unknown; no alternative length is substituted.</Text>
      {f.allowances.map((a, j) => { const prefix = `${label} allowance ${j + 1}`; const update = (next: typeof a) => change(i, { ...f, allowances: f.allowances.map((item, index) => index === j ? next : item) }); return <Card key={j} withBorder><Stack gap="xs">
        <TextInput label={`${prefix} stable ID`} value={a.local_id} onChange={e => update({ ...a, local_id: e.currentTarget.value })} />
        <Select label={`${prefix} kind`} data={['slack', 'preparation', 'trim']} value={a.kind} onChange={kind => update({ ...a, kind: kind as typeof a.kind })} />
        <Select label={`${prefix} scope`} data={['whole_piece', 'end_a', 'end_b']} value={a.scope} onChange={scope => update({ ...a, scope: scope as typeof a.scope })} />
        <TextInput label={`${prefix} mm`} description="Exact decimal; blank means unknown, zero is explicit." value={a.amount_mm ?? ''} onChange={e => update({ ...a, amount_mm: e.currentTarget.value || null })} />
        <TextInput label={`${prefix} basis`} value={a.basis} onChange={e => update({ ...a, basis: e.currentTarget.value })} />
        <SourceEditor label={prefix} source={a.source} onChange={source => update({ ...a, source })} />
        <Button onClick={() => change(i, { ...f, allowances: f.allowances.filter((_, index) => index !== j) })}>Remove {prefix}</Button>
      </Stack></Card>; })}
      <Button onClick={() => change(i, { ...f, allowances: [...f.allowances, { local_id: `allowance-${f.allowances.length + 1}`, kind: 'preparation', scope: 'whole_piece', amount_mm: null, basis: '', source: null }] })}>Add {label} allowance</Button>
      <Select label={`${label} review`} data={['unreviewed', 'reviewed']} value={f.review} onChange={review => change(i, { ...f, review: review as Formula['review'] })} />
      <TextInput label={`${label} review basis`} value={f.review_basis ?? ''} onChange={e => change(i, { ...f, review_basis: e.currentTarget.value || null })} />
      <Button variant="subtle" onClick={() => onChange({ ...value, formulas: value.formulas.filter((_, index) => index !== i) })}>Remove {label}</Button>
    </Stack></Card>; })}
    <Button onClick={() => onChange({ ...value, formulas: [...value.formulas, emptyFormula(value.formulas.length + 1)] })}>Add cut formula</Button>
  </Stack>;
}
