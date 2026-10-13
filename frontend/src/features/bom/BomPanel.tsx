import { Alert, Button, Card, Group, MultiSelect, NumberInput, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Projection } from "../assemblies/api";
import { blankPlan, command, read, unknownCount, type Count, type Definition, type Draft, type Identity, type Inspection, type Need, type Plan, type Purpose } from "./api";

const purposes = [{ value: "assembly_contents", label: "Assembly contents" }, { value: "procurement", label: "Procurement" }, { value: "pcb_fabrication", label: "PCB fabrication" }, { value: "pcb_population", label: "PCB population" }, { value: "consumables", label: "Consumables" }];
const label = (path: string[]) => path.length ? path.join(" / ") : "Root assembly";
export function BomPanel({ projectId }: { projectId: string }) { return <Workspace key={projectId} projectId={projectId} />; }
function Workspace({ projectId }: { projectId: string }) {
  const cache = useQueryClient();
  const [name, setName] = useState("");
  const [plan, setPlan] = useState<Plan>(blankPlan);
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const definitions = useQuery({ queryKey: ["bom-definitions", projectId], queryFn: () => read<Definition[]>(`projects/${projectId}/definitions`) });
  const identity = useQuery({ queryKey: ["bom-identity", definitionId, offset], queryFn: () => read<Identity>(`catalog/definitions/${definitionId}?offset=${offset}`), enabled: !!definitionId });
  const draft = useQuery({ queryKey: ["bom-draft", draftId], queryFn: () => read<Draft>(`bom/drafts/${draftId}`), enabled: !!draftId });
  const create = useMutation({ mutationFn: () => command<Draft>("bom.create", { project_id: projectId, name, bom: plan }), onSuccess: async (data) => {
    setDefinitionId(data.definition_id); setDraftId(data.draft_id); setRevisionId(null); setOffset(0);
    await cache.invalidateQueries({ queryKey: ["bom-definitions", projectId] });
  } });
  return <Stack>
    <Title order={2}>Purpose-specific BOM planning</Title>
    <Text>Choose an exact assembly revision and make/buy decisions. Bought assemblies stop procurement expansion. Process needs are separate declarations; unknown choices and quantities remain unresolved.</Text>
    <Card withBorder><Stack><Title order={3}>New BOM plan</Title>
      <TextInput label="BOM plan name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
      <PlanEditor value={plan} onChange={setPlan} definitions={definitions.data ?? []} />
      <Button loading={create.isPending} disabled={!name.trim() || !plan.assembly_revision_id} onClick={() => create.mutate()}>Create BOM draft</Button>
      {create.isError && <Alert color="red">{create.error.message}</Alert>}
    </Stack></Card>
    {definitions.isError && <Alert color="red">{definitions.error.message}</Alert>}
    <Select label="Existing BOM plan" value={definitionId} searchable data={(definitions.data ?? []).filter(d => d.kind === "bom_plan").map(d => ({ value: d.definition_id, label: d.name }))} onChange={id => { setDefinitionId(id); setDraftId(null); setRevisionId(null); setOffset(0); }} />
    {identity.isError && <Alert color="red">{identity.error.message}</Alert>}
    {identity.data && <>
      <Select label="BOM draft" value={draftId} data={identity.data.drafts.map(d => ({ value: d.draft_id, label: `${d.draft_id} · ${d.state}` }))} onChange={setDraftId} />
      <Select label="Frozen BOM revision" value={revisionId} data={identity.data.revisions.map(r => ({ value: r.revision_id, label: `Revision ${r.number} · ${r.revision_id}` }))} onChange={setRevisionId} />
      <Group><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous BOM revisions</Button><Button disabled={Math.max(identity.data.drafts.length, identity.data.revisions.length) < 50} onClick={() => setOffset(offset + 50)}>Next BOM revisions</Button></Group>
    </>}
    {draft.isError && <Alert color="red">{draft.error.message}</Alert>}
    {draft.data && <DraftEditor key={`${draft.data.draft_id}:${draft.data.state}`} draft={draft.data} definitions={definitions.data ?? []} onSaved={async () => { await cache.invalidateQueries({ queryKey: ["bom-draft", draftId] }); }} onFrozen={async id => { setRevisionId(id); await cache.invalidateQueries({ queryKey: ["bom-draft", draftId] }); await cache.invalidateQueries({ queryKey: ["bom-identity", definitionId] }); }} />}
    {revisionId && <BomInspector key={revisionId} revisionId={revisionId} />}
  </Stack>;
}

function DraftEditor({ draft, definitions, onSaved, onFrozen }: { draft: Draft; definitions: Definition[]; onSaved: () => Promise<void>; onFrozen: (id: string) => Promise<void> }) {
  const [value, setValue] = useState(draft.content.bom ?? blankPlan());
  const [dirty, setDirty] = useState(false);
  const save = useMutation({ mutationFn: () => command("bom.update", { draft_id: draft.draft_id, bom: value }, draft.state), onSuccess: onSaved });
  const freeze = useMutation({ mutationFn: () => command<{ revision_id: string }>("bom.freeze", { draft_id: draft.draft_id }, draft.state), onSuccess: result => onFrozen(result.revision_id) });
  return <Card withBorder><Stack><Title order={3}>Edit BOM draft</Title>
    <PlanEditor value={value} definitions={definitions} onChange={next => { setValue(next); setDirty(true); }} />
    <Group><Button loading={save.isPending} onClick={() => save.mutate()}>Save BOM draft</Button><Button disabled={dirty || !draft.content.bom} loading={freeze.isPending} onClick={() => freeze.mutate()}>Freeze BOM revision</Button></Group>
    {dirty && <Text>Save your edits before freezing.</Text>}
    {save.isError && <Alert color="red">{save.error.message}</Alert>}{freeze.isError && <Alert color="red">{freeze.error.message}</Alert>}
  </Stack></Card>;
}

function RevisionPicker({ title, definitions, value, onChange }: { title: string; definitions: Definition[]; value: string; onChange: (id: string) => void }) {
  const [definition, setDefinition] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const identity = useQuery({ queryKey: ["bom-picker", definition, offset], queryFn: () => read<Identity>(`catalog/definitions/${definition}?offset=${offset}`), enabled: !!definition });
  return <Stack gap="xs"><Select label={`${title} definition`} searchable value={definition} data={definitions.map(d => ({ value: d.definition_id, label: `${d.name} (${d.kind})` }))} onChange={id => { setDefinition(id); setOffset(0); }} />
    <Select label={`${title} exact revision`} value={value || null} data={(identity.data?.revisions ?? []).map(r => ({ value: r.revision_id, label: `Revision ${r.number} · ${r.revision_id}` }))} onChange={id => { if (id) onChange(id); }} />
    {value && <Text size="xs">Pinned: {value}</Text>}
    {identity.isError && <Alert color="red">{identity.error.message}</Alert>}
    {identity.data && <Group><Button size="xs" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous {title} revisions</Button><Button size="xs" disabled={identity.data.revisions.length < 50} onClick={() => setOffset(offset + 50)}>Next {title} revisions</Button></Group>}
  </Stack>;
}

function CountInput({ title, value, onChange }: { title: string; value: Count; onChange: (value: Count) => void }) {
  return <NumberInput label={title} description="Whole items only. Blank means unknown." min={1} max={1000000} allowDecimal={false} value={value.amount ?? ""} onChange={n => onChange(typeof n === "number" ? { status: "known", amount: n, unit: "ea" } : unknownCount())} />;
}

function PlanEditor({ value, definitions, onChange }: { value: Plan; definitions: Definition[]; onChange: (value: Plan) => void }) {
  const root = useQuery({ queryKey: ["bom-root", value.assembly_revision_id], queryFn: () => read<{ snapshot_id: string }>(`revisions/${value.assembly_revision_id}`), enabled: !!value.assembly_revision_id });
  const tree = useQuery({ queryKey: ["bom-tree", root.data?.snapshot_id], queryFn: () => read<Projection>(`assemblies/snapshots/${root.data?.snapshot_id}`), enabled: !!root.data });
  const contexts = [{ path: [] as string[], revision_id: value.assembly_revision_id }, ...(tree.data?.occurrences ?? []).map(n => ({ path: n.address.path, revision_id: n.revision_id }))];
  const [context, setContext] = useState("[]");
  const [need, setNeed] = useState<Need>({ local_id: "", context_path: [], revision_id: "", purpose: "consumables", quantity: unknownCount(), basis: "" });
  return <Stack>
    <RevisionPicker title="Root assembly" definitions={definitions.filter(d => d.kind === "assembly")} value={value.assembly_revision_id} onChange={id => onChange({ ...blankPlan(), assembly_revision_id: id, quantity: value.quantity })} />
    <CountInput title="Planned assembly quantity" value={value.quantity} onChange={quantity => onChange({ ...value, quantity })} />
    {root.isError && <Alert color="red">{root.error.message}</Alert>}{tree.isError && <Alert color="red">{tree.error.message}</Alert>}
    {tree.data && <>
      <MultiSelect label="Occurrence scope" description="Empty selects the whole root. Select disjoint branches; ancestor decisions still apply." value={value.scope_paths.map(p => JSON.stringify(p))} data={contexts.slice(1).map(c => ({ value: JSON.stringify(c.path), label: label(c.path) }))} onChange={paths => onChange({ ...value, scope_paths: paths.map(p => JSON.parse(p) as string[]) })} />
      <Title order={4}>Explicit make/buy policy</Title>
      {contexts.map(c => { const existing = value.policies.find(p => JSON.stringify(p.path) === JSON.stringify(c.path)); return <Card withBorder key={JSON.stringify(c.path)}><Stack gap="xs"><Text>{label(c.path)}</Text><Text size="xs">{c.revision_id}</Text>
        <Select label={`Decision for ${label(c.path)}`} data={["unknown", "make", "buy"]} value={existing?.decision ?? "unknown"} onChange={decision => { const next = { path: c.path, revision_id: c.revision_id, decision: decision as "make" | "buy" | "unknown", basis: existing?.basis ?? "" }; onChange({ ...value, policies: [...value.policies.filter(p => JSON.stringify(p.path) !== JSON.stringify(c.path)), next] }); }} />
        <TextInput label={`Decision basis for ${label(c.path)}`} value={existing?.basis ?? ""} onChange={e => onChange({ ...value, policies: [...value.policies.filter(p => JSON.stringify(p.path) !== JSON.stringify(c.path)), { path: c.path, revision_id: c.revision_id, decision: existing?.decision ?? "unknown", basis: e.currentTarget.value }] })} />
      </Stack></Card>; })}
      <Title order={4}>Supplemental process needs</Title><Text>Declare fabrication, population or consumable demand that is not already a retained child. Needs only apply under explicit make decisions. They do not change assembly contents.</Text>
      <Select label="Need context" value={context} data={contexts.map(c => ({ value: JSON.stringify(c.path), label: label(c.path) }))} onChange={c => setContext(c ?? "[]")} />
      <TextInput label="Need stable ID" value={need.local_id} onChange={e => setNeed({ ...need, local_id: e.currentTarget.value })} />
      <RevisionPicker title="Need item" definitions={definitions} value={need.revision_id} onChange={id => setNeed({ ...need, revision_id: id })} />
      <Select label="Need purpose" data={purposes.slice(2)} value={need.purpose} onChange={p => setNeed({ ...need, purpose: p as Need["purpose"] })} />
      <CountInput title="Need quantity per assembly" value={need.quantity} onChange={quantity => setNeed({ ...need, quantity })} />
      <TextInput label="Need basis" value={need.basis} onChange={e => setNeed({ ...need, basis: e.currentTarget.value })} />
      <Button disabled={!need.local_id || !need.revision_id || !need.basis} onClick={() => onChange({ ...value, needs: [...value.needs, { ...need, context_path: JSON.parse(context) as string[] }] })}>Add process need</Button>
      {value.needs.map((n, i) => <Group key={`${n.local_id}:${i}`}><Text>{n.local_id} · {label(n.context_path)} · {n.purpose} · {n.quantity.amount ?? "unknown"} ea</Text><Button size="xs" onClick={() => onChange({ ...value, needs: value.needs.filter((_, j) => i !== j) })}>Remove {n.local_id}</Button></Group>)}
    </>}
  </Stack>;
}

export function BomInspector({ revisionId }: { revisionId: string }) {
  const [purpose, setPurpose] = useState<Purpose>("procurement");
  const result = useQuery({ queryKey: ["bom-inspect", revisionId, purpose], queryFn: () => read<Inspection>(`bom/revisions/${revisionId}?purpose=${purpose}`) });
  return <Card withBorder><Stack><Title order={3}>Frozen BOM purpose view</Title>
    <Select label="BOM purpose" value={purpose} data={purposes} onChange={p => setPurpose(p as Purpose)} />
    {result.isError && <Alert color="red">{result.error.message}</Alert>}
    {result.data && <><Text>Plan revision: {result.data.revision_id}</Text><Text>Assembly revision: {result.data.bom.assembly_revision_id}</Text><Text>Status: {result.data.status}. Physical qualification: not evaluated.</Text>
      <Table><Table.Thead><Table.Tr><Table.Th>Occurrence / need</Table.Th><Table.Th>Exact item</Table.Th><Table.Th>Quantity</Table.Th><Table.Th>Reason</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{result.data.rows.map((r, i) => <Table.Tr key={i}><Table.Td>{label(r.address.path)}{r.need_id ? ` · ${r.need_id}` : ""}</Table.Td><Table.Td>{r.name}<Text size="xs">{r.revision_id}</Text></Table.Td><Table.Td>{r.quantity.amount ?? "unknown"} ea</Table.Td><Table.Td>{r.reason}<Text size="xs">{r.basis}</Text></Table.Td></Table.Tr>)}</Table.Tbody></Table>
      {!result.data.rows.length && <Text>No included rows for this purpose and scope. Check boundaries and unresolved decisions below.</Text>}
      {result.data.boundaries.map((b, i) => <Text key={i}>Boundary: {label(b.address.path)} · {b.decision}</Text>)}
      {result.data.unresolved.map((u, i) => <Alert color="yellow" key={i}>{label(u.address.path)}{u.need_id ? ` · ${u.need_id}` : ""}: {u.reason}</Alert>)}
      {result.data.excluded_needs.map(n => <Text key={n.need_id}>Excluded process need: {n.need_id} · {n.reason}</Text>)}
      {result.data.limitations.map(l => <Text size="sm" key={l}>{l}</Text>)}
    </>}
  </Stack></Card>;
}
