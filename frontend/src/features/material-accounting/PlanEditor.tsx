import { Button, Card, Checkbox, Group, NumberInput, Select, Stack, Text, Textarea, TextInput, Title } from '@mantine/core';
import type { DemandQuantity } from '../bom/api';
import { unknownDemand } from '../bom/api';
import { SourceEditor } from '../preparation/ProfileEditor';
import { ReferenceChoice, type ReferenceSelection, type ReferenceSelections } from './ReferenceChoice';
import { emptyExtent, type Definition, type Extent, type Plan, type Reconciliation } from './api';

function ExtentEditor({ label, value, onChange }: { label: string; value: Extent; onChange: (v: Extent) => void }) {
  return <Stack gap="xs"><TextInput label={`${label} mm per piece`} description="Exact decimal; blank is unknown and zero is deliberate." value={value.amount_mm ?? ''} onChange={e => onChange({ ...value, amount_mm: e.currentTarget.value || null })} /><TextInput label={`${label} basis`} value={value.basis} onChange={e => onChange({ ...value, basis: e.currentTarget.value })} /><SourceEditor label={label} source={value.source} onChange={source => onChange({ ...value, source })} /></Stack>;
}
function DemandEditor({ label, value, onChange }: { label: string; value: DemandQuantity; onChange: (v: DemandQuantity) => void }) {
  return <Group><TextInput label={label} description="Exact decimal; blank is unknown." value={value.amount ?? ''} onChange={e => onChange({ ...value, status: e.currentTarget.value ? 'known' : 'unknown', amount: e.currentTarget.value || null })} /><Select label={`${label} unit`} value={value.unit} data={['ea', 'mm', 'cm', 'm', 'g', 'kg']} onChange={unit => onChange({ ...value, unit: unit as DemandQuantity['unit'] })} /></Group>;
}
function ActualEditor({ label, value, unit, onChange }: { label: string; value: Reconciliation | null; unit: DemandQuantity['unit']; onChange: (v: Reconciliation | null) => void }) {
  return <Stack><Checkbox label={`Record actual reconciliation for ${label}`} checked={!!value} onChange={e => onChange(e.currentTarget.checked ? { consumption_ids: [], retained: unknownDemand(unit), waste: unknownDemand(unit), basis: '', source: null } : null)} />{value && <>
    <Text>Entire batch observations, independent of planned quantity. Reference existing consumption events; later authorized returns reduce the issue. Recording this sheet leaves stock unchanged.</Text>
    <Textarea label={`${label} consumption event IDs`} description="One exact existing event ID per line; an event may appear once in this sheet." value={value.consumption_ids.join('\n')} onChange={e => onChange({ ...value, consumption_ids: e.currentTarget.value.split(/\s+/).filter(Boolean) })} />
    <DemandEditor label={`${label} actual retained batch amount`} value={value.retained} onChange={retained => onChange({ ...value, retained })} />
    <DemandEditor label={`${label} actual discarded batch amount`} value={value.waste} onChange={waste => onChange({ ...value, waste })} />
    <TextInput label={`${label} reconciliation basis`} value={value.basis} onChange={e => onChange({ ...value, basis: e.currentTarget.value })} /><SourceEditor label={`${label} reconciliation`} source={value.source} onChange={source => onChange({ ...value, source })} />
  </>}</Stack>;
}
export function PlanEditor({ value, definitions, onChange, references, onReference, generation, onDenied }: { value: Plan; definitions: Definition[]; onChange: (v: Plan) => void; references: ReferenceSelections; onReference: (label: string, selection: ReferenceSelection) => void; generation: number; onDenied: () => void }) {
  const referenceProps = (label: string) => ({ selection: references[label] ?? { definition: null, offset: 0 }, onSelection: (selection: ReferenceSelection) => onReference(label, selection), generation, onDenied });
  return <Stack>
    <ReferenceChoice {...referenceProps("Material subject")} label="Material subject" kinds={['cable', 'harness']} value={value.subject_revision_id} definitions={definitions} onChange={subject_revision_id => onChange({ ...value, subject_revision_id })} />
    <NumberInput label="Planned material subject quantity" description="Blank stays unknown. Whole subjects only." min={1} max={1000000} allowDecimal={false} value={value.quantity ?? ''} onChange={q => onChange({ ...value, quantity: typeof q === 'number' ? q : null })} />
    <Select label="Material make or buy decision" value={value.decision} data={['unknown', 'make', 'buy']} onChange={decision => onChange({ ...value, decision: decision as Plan['decision'] })} /><TextInput label="Material decision basis" value={value.decision_basis} onChange={e => onChange({ ...value, decision_basis: e.currentTarget.value })} />
    <Text>Bought subjects stop stock and consumable procurement. Physical harness sections are counted once even when several segments share them. Installed material is independent of route, finished and cut declarations.</Text>
    {value.pieces.map((piece, i) => { const label = `Piece ${i + 1}`; const update = (next: typeof piece) => onChange({ ...value, pieces: value.pieces.map((p, j) => j === i ? next : p) }); return <Card withBorder key={i}><Stack><Title order={4}>{label}</Title>
      <TextInput label={`${label} physical section ID`} description="Blank for a cable's one piece; exact retained section ID for a harness." value={piece.section_id ?? ''} onChange={e => update({ ...piece, section_id: e.currentTarget.value || null })} />
      <ExtentEditor label={`${label} installed material`} value={piece.installed} onChange={installed => update({ ...piece, installed })} />
      <Select label={`${label} cut basis`} value={piece.cut_basis} data={['declaration', 'preparation_suggestion']} onChange={cut_basis => update({ ...piece, cut_basis: cut_basis as typeof piece.cut_basis })} />
      <ReferenceChoice {...referenceProps(`${label} preparation profile`)} label={`${label} preparation profile`} kinds={['preparation_profile']} value={piece.profile_revision_id ?? ''} definitions={definitions} onChange={id => update({ ...piece, profile_revision_id: id || null })} />
      <Text>Cut already includes selected slack, end preparation and trim. Procurement adds only extra waste beyond the cut. Surplus inside the cut is not assumed to be scrap.</Text>
      <ExtentEditor label={`${label} extra waste beyond cut`} value={piece.extra_waste} onChange={extra_waste => update({ ...piece, extra_waste })} />
      <ActualEditor label={label} value={piece.reconciliation} unit="mm" onChange={reconciliation => update({ ...piece, reconciliation })} />
      <Button variant="subtle" onClick={() => onChange({ ...value, pieces: value.pieces.filter((_, j) => j !== i) })}>Remove {label}</Button>
    </Stack></Card>; })}
    <Button onClick={() => onChange({ ...value, pieces: [...value.pieces, { section_id: null, installed: emptyExtent(), cut_basis: 'declaration', profile_revision_id: null, extra_waste: emptyExtent(), reconciliation: null }] })}>Add physical material piece</Button>
    <Title order={4}>Separate process consumables</Title>
    {value.consumables.map((need, i) => { const label = `Consumable ${i + 1}`; const update = (next: typeof need) => onChange({ ...value, consumables: value.consumables.map((n, j) => j === i ? next : n) }); return <Card withBorder key={i}><Stack>
      <TextInput label={`${label} stable ID`} value={need.local_id} onChange={e => update({ ...need, local_id: e.currentTarget.value })} />
      <TextInput label={`${label} exact item revision`} value={need.revision_id} onChange={e => update({ ...need, revision_id: e.currentTarget.value })} />
      <DemandEditor label={`${label} net demand per subject`} value={need.quantity} onChange={quantity => update({ ...need, quantity })} />
      <Checkbox label={`${label} declare additive waste`} checked={!!need.waste} onChange={e => update({ ...need, waste: e.currentTarget.checked ? { quantity: unknownDemand(need.quantity.unit), basis: '' } : null })} />
      {need.waste && <><DemandEditor label={`${label} additive waste per subject`} value={need.waste.quantity} onChange={quantity => update({ ...need, waste: { quantity, basis: need.waste!.basis } })} /><TextInput label={`${label} waste basis`} value={need.waste.basis} onChange={e => update({ ...need, waste: { quantity: need.waste!.quantity, basis: e.currentTarget.value } })} /></>}
      <TextInput label={`${label} basis`} value={need.basis} onChange={e => update({ ...need, basis: e.currentTarget.value })} /><SourceEditor label={label} source={need.source} onChange={source => update({ ...need, source })} />
      <ActualEditor label={label} value={need.reconciliation} unit={need.quantity.unit} onChange={reconciliation => update({ ...need, reconciliation })} />
      <Button variant="subtle" onClick={() => onChange({ ...value, consumables: value.consumables.filter((_, j) => j !== i) })}>Remove {label}</Button>
    </Stack></Card>; })}
    <Button onClick={() => onChange({ ...value, consumables: [...value.consumables, { local_id: `need-${value.consumables.length + 1}`, revision_id: '', quantity: unknownDemand('g'), waste: null, basis: '', source: null, reconciliation: null }] })}>Add process consumable</Button>
    <Checkbox label="Include exact per-end instructions" checked={!!value.end_preparation} onChange={e => onChange({ ...value, end_preparation: e.currentTarget.checked ? { cable_revision_id: value.subject_revision_id, profile_revision_id: '', a_endpoint_id: '', b_endpoint_id: '', mapping_basis: '', mapping_review: 'unreviewed' } : null })} />
    {value.end_preparation && <Card withBorder><Stack><Text>Map the exact cable endpoints explicitly. Strip and lead dimensions remain instructions; they are not additional procurement quantities.</Text>{(['cable_revision_id', 'profile_revision_id', 'a_endpoint_id', 'b_endpoint_id', 'mapping_basis'] as const).map(field => <TextInput key={field} label={`Material end preparation ${field}`} value={value.end_preparation![field]} onChange={e => onChange({ ...value, end_preparation: { ...value.end_preparation!, [field]: e.currentTarget.value } })} />)}<Select label="Material end mapping review" value={value.end_preparation.mapping_review} data={['unreviewed', 'reviewed']} onChange={review => onChange({ ...value, end_preparation: { ...value.end_preparation!, mapping_review: review as 'unreviewed' | 'reviewed' } })} /></Stack></Card>}
  </Stack>;
}
