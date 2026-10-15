import { RecordNavigation } from "../make/RecordNavigation";
import { ReadOnlyNote, usePermission, InspectionScope } from "../../lib/permissions";
import { Alert, Button, Card, Checkbox, Group, MultiSelect, NumberInput, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { FromPreference, usePreferenceDefaults } from "../preferences/usePreferenceDefaults";
import type { Projection } from "../assemblies/api";
import { blankPlan, command, read, unknownCount, unknownDemand, type DemandQuantity, type Waste, type Count, type Definition, type Draft, type Identity, type Inspection, type Need, type Plan, type Purpose } from "./api";
import { revisionOptionLabel, newestFirst } from "../../lib/revision-labels";
import { SbQuantity } from "../../components/sb";
import { RevisionLabel } from "../../lib/IdentityLabel";
import { definitionIn, referenceFromProject, useOpenNewest, useOpenProbed } from "../scope/openProbed";
import { ContinueDraftButton } from "../scope/ContinueDraftButton";

const purposes = [{ value: "assembly_contents", label: "Assembly contents" }, { value: "procurement", label: "Procurement" }, { value: "pcb_fabrication", label: "PCB fabrication" }, { value: "pcb_population", label: "PCB population" }, { value: "consumables", label: "Consumables" }];
const label = (path: string[]) => path.length ? path.join(" / ") : "Root assembly";
/** Library BOM plans. `projectId` is optional context: new plans are then also referenced by that project. */
export function BomPanel({ projectId = null, workspaceId }: { projectId?: string | null; workspaceId?: string | null }) { return <Workspace key={projectId ?? "library"} projectId={projectId} workspaceId={workspaceId} />; }
function Workspace({ projectId, workspaceId }: { projectId: string | null; workspaceId?: string | null }) {
  const cache = useQueryClient();
  const createGate = usePermission('item.create');
  const [name, setName] = useState("");
  const [plan, setPlan] = useState<Plan>(blankPlan);
  const [newSourceDenied, setNewSourceDenied] = useState(false);
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const definitions = useQuery({ queryKey: ["bom-definitions", projectId], queryFn: () => read<Definition[]>('workspace/definitions') });
  const identity = useQuery({ queryKey: ["bom-identity", definitionId, offset], queryFn: () => read<Identity>(`catalog/definitions/${definitionId}?offset=${offset}`), enabled: !!definitionId });
  const draft = useQuery({ queryKey: ["bom-draft", draftId], queryFn: () => read<Draft>(`bom/drafts/${draftId}`), enabled: !!draftId });
  const create = useMutation({ mutationFn: () => command<Draft>("bom.create", { name, bom: plan }), onSuccess: async (data) => {
    setDefinitionId(data.definition_id); setDraftId(data.draft_id); setRevisionId(null); setOffset(0);
    await cache.invalidateQueries({ queryKey: ["bom-definitions", projectId] });
    await referenceFromProject(projectId, data.definition_id, "BOM plan");
  } });
  const pick = (id: string | null) => { setDefinitionId(id); setDraftId(null); setRevisionId(null); setOffset(0); };
  const openNewest = useOpenNewest(identity.data, setDraftId, setRevisionId);
  useOpenProbed(definitionIn(definitions.data, ["bom_plan"]), (id) => { pick(id); openNewest(id); });
  const draftBlocked = definitions.isError || identity.isError || draft.isError;
  return <Stack>
    <Title order={2}>Purpose-specific BOM planning</Title>
    <Text>Choose an exact assembly revision and make/buy decisions. Bought assemblies stop procurement expansion. Process needs are separate declarations; unknown choices and quantities remain unresolved.</Text>
    <details open={!definitionId}><summary style={{ cursor: "pointer" }}>New BOM plan</summary>
    <Card withBorder mt="xs"><Stack><Title order={3}>New BOM plan</Title>
      <InspectionScope permission="item.create"><TextInput label="BOM plan name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
      <PlanEditor value={plan} onChange={setPlan} onAuthorityChange={setNewSourceDenied} definitions={definitions.data ?? []} workspaceId={workspaceId} /></InspectionScope>
      <Button loading={create.isPending} disabled={newSourceDenied || !name.trim() || !plan.assembly_revision_id} onClick={() => create.mutate()} {...createGate.props}>Create BOM draft</Button><ReadOnlyNote permission="item.create">Creating BOM drafts is unavailable.</ReadOnlyNote>
      {create.isError && <Alert color="red">{create.error.message}</Alert>}
    </Stack></Card>
    </details>
    {definitions.isError && <Alert color="red">{definitions.error.message}</Alert>}
    {identity.isError && <Alert color="red">{identity.error.message}</Alert>}
    <RecordNavigation name={(definitions.data ?? []).find(item => item.definition_id === definitionId)?.name ?? "BOM plan"} selected={definitionId}>
    <Select label="Existing BOM plan" value={definitionId} searchable data={(definitions.data ?? []).filter(d => d.kind === "bom_plan").map(d => ({ value: d.definition_id, label: d.name }))} onChange={pick} />
    {identity.data && !identity.isError && <>
      <Select label="BOM draft" value={draftId} data={identity.data.drafts.map(d => ({ value: d.draft_id, label: `${d.draft_id} · ${d.state}` }))} onChange={setDraftId} />
      {identity.data && <ContinueDraftButton drafts={identity.data.drafts} revisionId={revisionId} draftId={draftId} onOpen={setDraftId} />}
      <Select label="Frozen BOM revision" value={revisionId} data={newestFirst(identity.data.revisions).map((r) => ({ value: r.revision_id, label: revisionOptionLabel(identity.data.name, r.number) }))} onChange={setRevisionId} />
      <Group><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous BOM revisions</Button><Button disabled={Math.max(identity.data.drafts.length, identity.data.revisions.length) < 50} onClick={() => setOffset(offset + 50)}>Next BOM revisions</Button></Group>
    </>}
    </RecordNavigation>
    {draft.isError && <Alert color="red">{draft.error.message}</Alert>}
    {draftBlocked && <Button variant="subtle" onClick={() => { void definitions.refetch(); if (definitionId) void identity.refetch(); if (draftId) void draft.refetch(); }}>Refresh BOM access</Button>}
    {draft.data && <div hidden={draftBlocked} inert={draftBlocked || undefined}><DraftEditor key={draft.data.draft_id} blocked={draftBlocked} draft={draft.data} workspaceId={workspaceId} definitions={definitions.data ?? []} onSaved={async () => { await cache.invalidateQueries({ queryKey: ["bom-draft", draftId] }); }} onFrozen={async id => { setRevisionId(id); await cache.invalidateQueries({ queryKey: ["bom-draft", draftId] }); await cache.invalidateQueries({ queryKey: ["bom-identity", definitionId] }); }} /></div>}
    {revisionId && <BomInspector key={revisionId} revisionId={revisionId} />}
  </Stack>;
}

function DraftEditor({ draft, blocked, definitions, workspaceId, onSaved, onFrozen }: { draft: Draft; blocked: boolean; workspaceId?: string | null; definitions: Definition[]; onSaved: () => Promise<void>; onFrozen: (id: string) => Promise<void> }) {
  const editGate = usePermission('design.edit');
  const freezeGate = usePermission('design.freeze');
  const [base, setBase] = useState(draft);
  const [sourceDenied, setSourceDenied] = useState(false);
  const [value, setValue] = useState(draft.content.bom ?? blankPlan());
  const [dirty, setDirty] = useState(false);
  const save = useMutation({ mutationFn: () => command<Draft>("bom.update", { draft_id: base.draft_id, bom: value }, base.state), onSuccess: async saved => { setBase(saved); setDirty(false); await onSaved(); } });
  const freeze = useMutation({ mutationFn: () => command<{ revision_id: string; draft?: Draft }>("bom.freeze", { draft_id: base.draft_id }, base.state), onSuccess: result => { if (result.draft) setBase(previous => ({ ...previous, ...result.draft })); return onFrozen(result.revision_id); } });
  const pending = save.isPending || freeze.isPending;
  return <Card withBorder><Stack><Title order={3}>Edit BOM draft</Title>
    <fieldset disabled={pending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
    <InspectionScope permission="design.edit"><PlanEditor value={value} definitions={definitions} workspaceId={workspaceId} onAuthorityChange={setSourceDenied} blocked={blocked || pending} onChange={next => { setValue(next); setDirty(true); }} /></InspectionScope>
    <Group><Button disabled={pending || blocked || sourceDenied} loading={save.isPending} onClick={() => save.mutate()} {...editGate.props}>Save BOM draft</Button><Button disabled={pending || blocked || sourceDenied || dirty || !base.content.bom} loading={freeze.isPending} onClick={() => freeze.mutate()} {...freezeGate.props}>Freeze BOM revision</Button><ReadOnlyNote permission="design.edit">Saving and freezing BOM drafts are unavailable.</ReadOnlyNote></Group>
    </fieldset>
    {dirty && <Text>Save your edits before freezing.</Text>}
    {save.isError && <Alert color="red">{save.error.message}</Alert>}{freeze.isError && <Alert color="red">{freeze.error.message}</Alert>}
  </Stack></Card>;
}

function RevisionPicker({ title, definitions, value, onChange, blocked = false }: { blocked?: boolean; title: string; definitions: Definition[]; value: string; onChange: (id: string) => void }) {
  const [definition, setDefinition] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const identity = useQuery({ queryKey: ["bom-picker", definition, offset], queryFn: () => read<Identity>(`catalog/definitions/${definition}?offset=${offset}`), enabled: !!definition });
  return <Stack gap="xs"><Select label={`${title} definition`} searchable disabled={blocked} dropdownOpened={blocked ? false : undefined} value={definition} data={definitions.map(d => ({ value: d.definition_id, label: `${d.name} (${d.kind})` }))} onChange={id => { setDefinition(id); setOffset(0); }} />
    <Select label={`${title} exact revision`} disabled={blocked} dropdownOpened={blocked ? false : undefined} value={value || null} data={newestFirst(identity.isError ? [] : identity.data?.revisions ?? []).map((r) => ({ value: r.revision_id, label: revisionOptionLabel(identity.data?.name, r.number) }))} onChange={id => { if (id) onChange(id); }} />
    {value && <Text size="xs">Pinned: {value}</Text>}
    {identity.isError && <Alert color="red">{identity.error.message}</Alert>}
    {identity.data && <Group><Button size="xs" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous {title} revisions</Button><Button size="xs" disabled={identity.data.revisions.length < 50} onClick={() => setOffset(offset + 50)}>Next {title} revisions</Button></Group>}
  </Stack>;
}

function CountInput({ title, value, onChange }: { title: string; value: Count; onChange: (value: Count) => void }) {
  return <NumberInput label={title} description="Whole items only. Blank means unknown." min={1} max={1000000} allowDecimal={false} value={value.amount ?? ""} onChange={n => onChange(typeof n === "number" ? { status: "known", amount: n, unit: "ea" } : unknownCount())} />;
}

function DemandInput({ title, value, onChange }: { title: string; value: DemandQuantity; onChange: (value: DemandQuantity) => void }) {
  return <Group align="start"><TextInput label={title} description="Exact decimal amount. Blank means unknown; no percentage or rounding." value={value.amount ?? ""} onChange={e => onChange({ ...value, status: e.currentTarget.value === "" ? "unknown" : "known", amount: e.currentTarget.value === "" ? null : e.currentTarget.value })} />
    <Select label={`${title} unit`} value={value.unit} data={["ea", "m", "cm", "mm", "kg", "g"]} onChange={unit => onChange({ ...value, unit: unit as DemandQuantity["unit"] })} /></Group>;
}
function WasteInput({ title, value, unit, onChange }: { title: string; value?: Waste | null; unit: DemandQuantity["unit"]; onChange: (value: Waste | null) => void }) {
  return <Stack gap="xs"><Checkbox label={`Declare additive waste for ${title}`} checked={!!value} onChange={e => onChange(e.currentTarget.checked ? { quantity: unknownDemand(unit), basis: "" } : null)} />
    {value ? <><DemandInput title={`${title} additive waste per root assembly`} value={value.quantity} onChange={quantity => onChange({ ...value, quantity })} /><TextInput label={`${title} waste basis`} value={value.basis} onChange={e => onChange({ ...value, basis: e.currentTarget.value })} /></> : <Text size="sm">Waste not evaluated. Gross required demand remains unknown; declare zero explicitly when justified.</Text>}</Stack>;
}

function PlanEditor({ value, definitions, onChange, workspaceId, onAuthorityChange, blocked = false }: { blocked?: boolean; onAuthorityChange?: (denied: boolean) => void; value: Plan; definitions: Definition[]; onChange: (value: Plan) => void; workspaceId?: string | null }) {
  const root = useQuery({ queryKey: ["bom-root", value.assembly_revision_id], queryFn: () => read<{ snapshot_id: string }>(`revisions/${value.assembly_revision_id}`), enabled: !!value.assembly_revision_id });
  const tree = useQuery({ queryKey: ["bom-tree", root.data?.snapshot_id], queryFn: () => read<Projection>(`assemblies/snapshots/${root.data?.snapshot_id}`), enabled: !!root.data });
  const sourceDenied = root.isError || tree.isError;
  const choicesBlocked = blocked || sourceDenied;
  useEffect(() => onAuthorityChange?.(sourceDenied), [sourceDenied, onAuthorityChange]);
  const contexts = [{ path: [] as string[], revision_id: value.assembly_revision_id }, ...(tree.data?.occurrences ?? []).map(n => ({ path: n.address.path, revision_id: n.revision_id }))];
  const [context, setContext] = useState("[]");
  const [need, setNeed] = useState<Need>({ local_id: "", context_path: [], revision_id: "", purpose: "consumables", quantity: unknownDemand(), basis: "" });
  // The default length unit pre-fills only the unit of a new need; its amount stays unknown.
  const preferredUnit = usePreferenceDefaults(workspaceId).text("default_length_unit");
  const lengthUnit = (["m", "cm", "mm"] as const).find(unit => unit === preferredUnit) ?? null;
  const [unitFromPreference, setUnitFromPreference] = useState(false);
  const [unitTouched, setUnitTouched] = useState(false);
  useEffect(() => { if (lengthUnit && !unitTouched) { setNeed(current => ({ ...current, quantity: { ...current.quantity, unit: lengthUnit } })); setUnitFromPreference(true); } }, [lengthUnit, unitTouched]);
  return <Stack>
    {sourceDenied && <Alert color="red">BOM source access must be confirmed before retained plan values can be shown. <Button variant="subtle" onClick={() => { void root.refetch(); if (root.data) void tree.refetch(); }}>Refresh BOM sources</Button></Alert>}
    {root.isError && <Alert color="red">{root.error.message}</Alert>}{tree.isError && <Alert color="red">{tree.error.message}</Alert>}
    <div hidden={sourceDenied} inert={sourceDenied || undefined}><Stack>
    <RevisionPicker blocked={choicesBlocked} title="Root assembly" definitions={definitions.filter(d => d.kind === "assembly")} value={value.assembly_revision_id} onChange={id => onChange({ ...blankPlan(), assembly_revision_id: id, quantity: value.quantity })} />
    <CountInput title="Planned assembly quantity" value={value.quantity} onChange={quantity => onChange({ ...value, quantity })} />
    {tree.data && <>
      <MultiSelect disabled={choicesBlocked} dropdownOpened={choicesBlocked ? false : undefined} label="Occurrence scope" description="Empty selects the whole root. Select disjoint branches; ancestor decisions still apply." value={value.scope_paths.map(p => JSON.stringify(p))} data={contexts.slice(1).map(c => ({ value: JSON.stringify(c.path), label: label(c.path) }))} onChange={paths => onChange({ ...value, scope_paths: paths.map(p => JSON.parse(p) as string[]) })} />
      <Title order={4}>Explicit make/buy policy</Title>
      {contexts.map(c => { const existing = value.policies.find(p => JSON.stringify(p.path) === JSON.stringify(c.path)); return <Card withBorder key={JSON.stringify(c.path)}><Stack gap="xs"><Text>{label(c.path)}</Text><Text size="xs"><RevisionLabel id={c.revision_id} /></Text>
        <Select label={`Decision for ${label(c.path)}`} data={["unknown", "make", "buy"]} value={existing?.decision ?? "unknown"} onChange={decision => { const next = { path: c.path, revision_id: c.revision_id, decision: decision as "make" | "buy" | "unknown", basis: existing?.basis ?? "" }; onChange({ ...value, policies: [...value.policies.filter(p => JSON.stringify(p.path) !== JSON.stringify(c.path)), next] }); }} />
        <TextInput label={`Decision basis for ${label(c.path)}`} value={existing?.basis ?? ""} onChange={e => onChange({ ...value, policies: [...value.policies.filter(p => JSON.stringify(p.path) !== JSON.stringify(c.path)), { path: c.path, revision_id: c.revision_id, decision: existing?.decision ?? "unknown", basis: e.currentTarget.value }] })} />
      </Stack></Card>; })}
      <Title order={4}>Occurrence material demand</Title><Text>Each declaration is for this exact occurrence in one root assembly, including repeated occurrences. Structural contents remain one item per occurrence. Units alone do not establish stock compatibility. No amount is inferred from geometry.</Text>
      {contexts.map(c => { const existing = value.occurrence_demands?.find(d => JSON.stringify(d.path) === JSON.stringify(c.path)); const update = (change: Partial<NonNullable<Plan["occurrence_demands"]>[number]>) => onChange({ ...value, occurrence_demands: (value.occurrence_demands ?? []).map(d => JSON.stringify(d.path) === JSON.stringify(c.path) ? { ...d, ...change } : d) }); return <Card withBorder key={`demand:${JSON.stringify(c.path)}`}><Stack gap="xs">
        <Checkbox label={`Declare material demand for ${label(c.path)}`} checked={!!existing} onChange={e => onChange({ ...value, occurrence_demands: e.currentTarget.checked ? [...(value.occurrence_demands ?? []), { path: c.path, revision_id: c.revision_id, quantity: unknownDemand(), basis: "", waste: null }] : (value.occurrence_demands ?? []).filter(d => JSON.stringify(d.path) !== JSON.stringify(c.path)) })} />
        {existing && <><DemandInput title={`${label(c.path)} net demand per root assembly`} value={existing.quantity} onChange={quantity => update({ quantity })} /><TextInput label={`${label(c.path)} demand basis`} value={existing.basis} onChange={e => update({ basis: e.currentTarget.value })} /><WasteInput title={label(c.path)} value={existing.waste} unit={existing.quantity.unit} onChange={waste => update({ waste })} /></>}
      </Stack></Card>; })}
      <Title order={4}>Supplemental process needs</Title><Text>Declare fabrication, population or consumable demand that is not already a retained child. Needs only apply under explicit make decisions. They do not change assembly contents. Each quantity and additive waste amount is per one root assembly at the chosen context.</Text>
      <Select disabled={choicesBlocked} dropdownOpened={choicesBlocked ? false : undefined} label="Need context" value={context} data={contexts.map(c => ({ value: JSON.stringify(c.path), label: label(c.path) }))} onChange={c => setContext(c ?? "[]")} />
      <TextInput label="Need stable ID" value={need.local_id} onChange={e => setNeed({ ...need, local_id: e.currentTarget.value })} />
      <RevisionPicker blocked={choicesBlocked} title="Need item" definitions={definitions} value={need.revision_id} onChange={id => setNeed({ ...need, revision_id: id })} />
      <Select label="Need purpose" data={purposes.slice(2)} value={need.purpose} onChange={p => setNeed({ ...need, purpose: p as Need["purpose"] })} />
      <Group align="flex-end" gap="xs"><DemandInput title="Need net demand per root assembly" value={need.quantity} onChange={quantity => { if (quantity.unit !== need.quantity.unit) { setUnitTouched(true); setUnitFromPreference(false); } setNeed({ ...need, quantity }); }} />
        {unitFromPreference && need.quantity.unit === lengthUnit && <FromPreference what="need quantity unit" onClear={() => { setUnitTouched(true); setUnitFromPreference(false); setNeed({ ...need, quantity: { ...need.quantity, unit: "ea" } }); }} />}</Group>
      <WasteInput title="Need" value={need.waste} unit={need.quantity.unit} onChange={waste => setNeed({ ...need, waste })} />
      <TextInput label="Need basis" value={need.basis} onChange={e => setNeed({ ...need, basis: e.currentTarget.value })} />
      <Button disabled={!need.local_id || !need.revision_id || !need.basis} onClick={() => onChange({ ...value, needs: [...value.needs, { ...need, context_path: JSON.parse(context) as string[] }] })}>Add process need</Button>
      {value.needs.map((n, i) => <Group key={`${n.local_id}:${i}`}><Stack gap="xs"><Text>{n.local_id} · {label(n.context_path)} · {n.purpose} · <SbQuantity value={n.quantity.amount} unit={n.quantity.unit} /> per root assembly</Text><Text size="xs">{n.basis}</Text><Text size="xs">Additive waste: {n.waste ? <><SbQuantity value={n.waste.quantity.amount} unit={n.waste.quantity.unit} /> per root · {n.waste.basis}</> : "not evaluated"}</Text></Stack><Button size="xs" onClick={() => onChange({ ...value, needs: value.needs.filter((_, j) => i !== j) })}>Remove {n.local_id}</Button></Group>)}
    </>}
    </Stack></div>
  </Stack>;
}

export function BomInspector({ revisionId }: { revisionId: string }) {
  const [purpose, setPurpose] = useState<Purpose>("procurement");
  const result = useQuery({ queryKey: ["bom-inspect", revisionId, purpose], queryFn: () => read<Inspection>(`bom/revisions/${revisionId}?purpose=${purpose}`) });
  return <Card withBorder><Stack><Title order={3}>Frozen BOM purpose view</Title>
    <Select label="BOM purpose" value={purpose} data={purposes} onChange={p => setPurpose(p as Purpose)} />
    {result.isError && <Alert color="red">{result.error.message}</Alert>}
    {result.data && <><Text><RevisionLabel id={result.data.revision_id} role="Plan" /></Text><Text><RevisionLabel id={result.data.bom.assembly_revision_id} role="Assembly" /></Text><Text>Status: {result.data.status}. Physical qualification: not evaluated.</Text>
      <Table><Table.Thead><Table.Tr><Table.Th>Occurrence / need</Table.Th><Table.Th>Exact item</Table.Th><Table.Th>Net / structural quantity</Table.Th><Table.Th>Additive waste / gross required</Table.Th><Table.Th>Reason</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{result.data.rows.map((r, i) => <Table.Tr key={i}><Table.Td>{label(r.address.path)}{r.need_id ? ` · ${r.need_id}` : ""}</Table.Td><Table.Td>{r.name}<Text size="xs"><RevisionLabel id={r.revision_id} /></Text></Table.Td><Table.Td><SbQuantity value={r.quantity.amount} unit={r.quantity.unit} /><Text size="xs">{r.demand_basis}</Text>{r.per_root_quantity && <Text size="xs">Per root: <SbQuantity value={r.per_root_quantity.amount} unit={r.per_root_quantity.unit} /></Text>}{r.structural_quantity && <Text size="xs">Structural: <SbQuantity value={r.structural_quantity.amount} unit="ea" /></Text>}{r.net_quantity && <Text size="xs">Net demand: <SbQuantity value={r.net_quantity.amount} unit={r.net_quantity.unit} /></Text>}</Table.Td><Table.Td>{r.waste_quantity ? <>Waste: <SbQuantity value={r.waste_quantity.amount} unit={r.waste_quantity.unit} /><Text size="xs">{r.waste_status} · {r.waste_basis}</Text>{r.per_root_waste && <Text size="xs">Allowance per root: <SbQuantity value={r.per_root_waste.amount} unit={r.per_root_waste.unit} /></Text>}<Text>Gross: <SbQuantity value={r.required_quantity?.amount} unit={r.required_quantity?.unit ?? r.quantity.unit} /></Text></> : "Waste not evaluated"}</Table.Td><Table.Td>{r.reason}<Text size="xs">{r.basis}</Text></Table.Td></Table.Tr>)}</Table.Tbody></Table>
      {!result.data.rows.length && <Text>No included rows for this purpose and scope. Check boundaries and unresolved decisions below.</Text>}
      {result.data.boundaries.map((b, i) => <Text key={i}>Boundary: {label(b.address.path)} · {b.decision}</Text>)}
      {result.data.unresolved.map((u, i) => <Alert color="yellow" key={i}>{label(u.address.path)}{u.need_id ? ` · ${u.need_id}` : ""}: {u.reason}</Alert>)}
      {result.data.excluded_needs.map(n => <Text key={n.need_id}>Excluded process need: {n.need_id} · {n.reason}</Text>)}
      {result.data.limitations.map(l => <Text size="sm" key={l}>{l}</Text>)}
    </>}
  </Stack></Card>;
}
