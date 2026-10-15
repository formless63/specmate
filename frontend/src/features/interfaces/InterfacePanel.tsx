import { formatCoordinates } from "../../lib/format";
import { ReadOnlyNote, usePermission, InspectionScope } from "../../lib/permissions";
import { Alert, Button, Card, Group, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { command, read, initialInterface, unknownElectrical, type Body, type Definition, type Draft, type Identity, type Inspection, type Interface, type Mapping, type Orientation, type Pinout, type Trace } from "./api";
import { SignalSetEditor } from "./SignalSetPanel";
import { PortEditor } from "./PortPanel";
import { MatingList } from "./Mating";
import { PinoutSignalsEditor, PinoutVariantFields, PinSignalCell, PinoutVariantList } from "./PinoutSignals";

import { ContactDrawing, ContactPositionEditor, ElectricalConditionsEditor } from "./InterfaceConditions";
import { OperatingNumberInput } from "./declaration-inputs";
import { revisionOptionLabel } from "../../lib/revision-labels";
import { RevisionLabel } from "../../lib/IdentityLabel";
import { definitionIn, referenceFromProject, useOpenNewest, useOpenProbed } from "../scope/openProbed";

const kinds = [{ value: "connector_body", label: "Connector body" }, { value: "pinout", label: "Logical pinout" }, { value: "interface_map", label: "External / internal mapping" }];
/** Library interface definitions. `projectId` is optional context: new items are then also referenced by that project. */
export function InterfacePanel({ projectId = null }: { projectId?: string | null }) { return <Workspace key={projectId ?? "library"} projectId={projectId} />; }
function Workspace({ projectId }: { projectId: string | null }) {
  const cache = useQueryClient();
  const createGate = usePermission('item.create');
  const freezeGate = usePermission('design.freeze');
  const [name, setName] = useState("");
  const [value, setValue] = useState<Interface>(initialInterface("connector_body"));
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const definitions = useQuery({ queryKey: ["interface-definitions", projectId], queryFn: () => read<Definition[]>('workspace/definitions') });
  const identity = useQuery({ queryKey: ["interface-identity", definitionId, offset], queryFn: () => read<Identity>(`catalog/definitions/${definitionId}?offset=${offset}`), enabled: !!definitionId });
  const draft = useQuery({ queryKey: ["interface-draft", draftId], queryFn: () => read<Draft>(`interfaces/drafts/${draftId}`), enabled: !!draftId });
  const pick = (id: string | null) => { setDefinitionId(id); setDraftId(null); setRevisionId(null); setOffset(0); };
  const openNewest = useOpenNewest(identity.data, setDraftId, setRevisionId);
  useOpenProbed(definitionIn(definitions.data, kinds.map((k) => k.value)), (id) => { pick(id); openNewest(id); });
  const create = useMutation({ mutationFn: () => command<Draft>("interface.create", { name, interface: value }), onSuccess: async (data) => {
    setDefinitionId(data.definition_id); setDraftId(data.draft_id); setRevisionId(null); setOffset(0);
    await cache.invalidateQueries({ queryKey: ["interface-definitions", projectId] });
    await referenceFromProject(projectId, data.definition_id, "interface");
  } });
  const freeze = useMutation({ mutationFn: () => command<{ revision_id: string }>("interface.freeze", { draft_id: draftId }, draft.data?.state), onSuccess: async (data) => {
    setRevisionId(data.revision_id);
    await cache.invalidateQueries({ queryKey: ["interface-draft", draftId] });
    await cache.invalidateQueries({ queryKey: ["interface-identity", definitionId] });
  } });
  return <Stack>
    <Title order={2}>Bodies, pinouts and boundary mappings</Title>
    <Text>Physical contacts remain separate from signal roles. Placement belongs to assembly occurrences. Unknown values stay unknown; reviewed pin tables and declared paths do not establish compatibility or measured continuity.</Text>
    <Card withBorder><Stack>
      <Title order={3}>New reusable definition</Title>
      <InspectionScope permission="item.create"><TextInput label="Definition name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
      <Select label="Interface definition kind" data={kinds} value={value.kind} onChange={(v) => setValue(initialInterface(v as Interface["kind"]))} />
      <Editor value={value} onChange={setValue} definitions={definitions.data ?? []} /></InspectionScope>
      <Button disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()} {...createGate.props}>Create interface draft</Button><ReadOnlyNote permission="item.create">Creating interface drafts is unavailable.</ReadOnlyNote>
      {create.isError && <Alert color="red">{create.error.message}</Alert>}
    </Stack></Card>
    {definitions.isError && <Alert color="red">{definitions.error.message}</Alert>}
    <Select label="Existing interface definition" searchable data={(definitions.data ?? []).filter((d) => kinds.some((k) => k.value === d.kind)).map((d) => ({ value: d.definition_id, label: `${d.name} (${d.kind})` }))} value={definitionId} onChange={pick} />
    {identity.isError && <Alert color="red">{identity.error.message}</Alert>}
    {identity.data && <>
      <Select label="Edit interface draft" value={draftId} onChange={setDraftId} data={identity.data.drafts.map((d) => ({ value: d.draft_id, label: `${d.draft_id} · ${d.state}` }))} />
      <Select label="Inspect frozen interface" value={revisionId} onChange={setRevisionId} data={identity.data.revisions.map((r) => ({ value: r.revision_id, label: revisionOptionLabel(identity.data.name, r.number) }))} />
      <Group><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous revisions</Button><Button disabled={Math.max(identity.data.revisions.length, identity.data.drafts.length) < 50} onClick={() => setOffset(offset + 50)}>Next revisions</Button></Group>
    </>}
    {draft.isError && <Alert color="red">{draft.error.message}</Alert>}
    {draft.data && <><DraftEditor key={`${draft.data.draft_id}:${draft.data.state}`} draft={draft.data} definitions={definitions.data ?? []} onSaved={async () => { await cache.invalidateQueries({ queryKey: ["interface-draft", draftId] }); }} /><Button loading={freeze.isPending} onClick={() => freeze.mutate()} {...freezeGate.props}>Freeze interface revision</Button></>}
    {freeze.isError && <Alert color="red">{freeze.error.message}</Alert>}
    {revisionId && <InterfaceInspector key={revisionId} revisionId={revisionId} />}
  </Stack>;
}

function DraftEditor({ draft, definitions, onSaved }: { draft: Draft; definitions: Definition[]; onSaved: () => Promise<void> }) {
  const editGate = usePermission('design.edit');
  const [value, setValue] = useState(() => draft.content.interface ?? initialInterface(draft.kind));
  const save = useMutation({ mutationFn: () => command("interface.update", { draft_id: draft.draft_id, interface: value }, draft.state), onSuccess: onSaved });
  return <Card withBorder><Stack><Title order={3}>Edit draft</Title><Text size="sm">{draft.state}</Text><InspectionScope permission="design.edit"><Editor value={value} onChange={setValue} definitions={definitions} /></InspectionScope><Button loading={save.isPending} onClick={() => save.mutate()} {...editGate.props}>Save interface draft</Button><ReadOnlyNote permission="design.edit">Saving interface drafts is unavailable.</ReadOnlyNote>{save.isError && <Alert color="red">{save.error.message}</Alert>}</Stack></Card>;
}
function Editor({ value, onChange, definitions }: { value: Interface; onChange: (v: Interface) => void; definitions: Definition[] }) {
  if (value.kind === "connector_body") return <BodyEditor value={value} onChange={onChange} definitions={definitions} />;
  if (value.kind === "pinout") return <PinoutEditor value={value} onChange={onChange} definitions={definitions} />;
  if (value.kind === "signal_set") return <SignalSetEditor value={value} onChange={onChange} />;
  if (value.kind === "port") return <PortEditor value={value} onChange={onChange} definitions={definitions} />;
  return <MappingEditor value={value} onChange={onChange} definitions={definitions} />;
}
function OrientationEditor({ value, onChange }: { value: Orientation; onChange: (v: Orientation) => void }) {
  return <Group align="end"><Select label="Viewing side" value={value.viewing_side} data={["unknown", "mating", "termination"]} onChange={(v) => onChange(v === "unknown" ? { viewing_side: "unknown", rotation_degrees: null, datum: null } : { ...value, viewing_side: v as Orientation["viewing_side"] })} /><TextInput label="Orientation datum" disabled={value.viewing_side === "unknown"} value={value.datum ?? ""} onChange={(e) => onChange({ ...value, datum: e.currentTarget.value || null })} /><OperatingNumberInput label="Rotation degrees (blank = unknown)" min={0} max={359.999} disabled={value.viewing_side === "unknown"} value={value.rotation_degrees ?? ""} onChange={(v) => onChange({ ...value, rotation_degrees: v })} /></Group>;
}
function BodyEditor({ value, onChange, definitions }: { value: Body; onChange: (v: Body) => void; definitions: Definition[] }) {
  const [contactId, setContactId] = useState("");
  return <Stack><Group><TextInput label="Body family (blank = unknown)" value={value.family ?? ""} onChange={(e) => onChange({ ...value, family: e.currentTarget.value || null })} /><Select label="Mating role" value={value.mating_role} data={["unknown", "plug", "receptacle", "hermaphroditic"]} onChange={(v) => onChange({ ...value, mating_role: v ?? "unknown" })} /></Group><OrientationEditor value={value.drawing_orientation} onChange={(v) => onChange({ ...value, drawing_orientation: v })} />
    {value.contacts.map((contact, i) => <Group key={contact.contact_id}><Text>{contact.contact_id}</Text><TextInput label={`Contact ${contact.contact_id} number (blank = unknown)`} value={contact.number ?? ""} onChange={e => onChange({ ...value, contacts: value.contacts.map((c, j) => j === i ? { ...c, number: e.currentTarget.value || null } : c) })} /><ContactPositionEditor contactId={contact.contact_id} value={contact.position_mm} onChange={position_mm => onChange({ ...value, contacts: value.contacts.map((c, j) => j === i ? { ...c, position_mm } : c) })} /><TextInput label="Contact label" value={contact.label} onChange={(e) => onChange({ ...value, contacts: value.contacts.map((c, j) => j === i ? { ...c, label: e.currentTarget.value } : c) })} /><Select label="Physical role" value={contact.physical_role} data={["contact", "shell", "key"]} onChange={(v) => onChange({ ...value, contacts: value.contacts.map((c, j) => j === i ? { ...c, physical_role: v as typeof c.physical_role } : c) })} /><Button variant="subtle" onClick={() => onChange({ ...value, contacts: value.contacts.filter((_, j) => j !== i) })}>Remove contact {contact.contact_id}</Button></Group>)}
    <MatesEditor value={value} onChange={onChange} definitions={definitions} />
    <Group align="end"><TextInput label="New physical contact ID" value={contactId} onChange={(e) => setContactId(e.currentTarget.value)} /><Button disabled={!contactId || value.contacts.some((c) => c.contact_id === contactId)} onClick={() => { onChange({ ...value, contacts: [...value.contacts, { contact_id: contactId, physical_role: "contact", label: "", position_mm: null }] }); setContactId(""); }}>Add contact</Button></Group>
  </Stack>;
}

/** Declared mating partners: an exact partner body revision, contact correspondence and review. Never inferred from family names. */
function MatesEditor({ value, onChange, definitions }: { value: Body; onChange: (v: Body) => void; definitions: Definition[] }) {
  const [partner, setPartner] = useState("");
  const [correspondence, setCorrespondence] = useState<"same_contact_id" | "explicit">("same_contact_id");
  const [pairs, setPairs] = useState<{ this: string; other: string }[]>([]);
  const [mine, setMine] = useState<string | null>(null);
  const [theirs, setTheirs] = useState("");
  const [review, setReview] = useState<"unreviewed" | "reviewed">("unreviewed");
  const [basis, setBasis] = useState("");
  const mates = value.mates_with ?? [];
  return <Stack gap="xs"><Text className="sb-silk">Mates with</Text>
    {mates.map((m, i) => <Group key={m.body_revision_id} gap={6}><Text size="sm"><RevisionLabel id={m.body_revision_id} role="Partner" /></Text><Text size="sm">{m.correspondence === "same_contact_id" ? "same contact IDs" : `${m.pairs.length} explicit pairs`} · {m.review}{m.basis ? ` · ${m.basis}` : ""}</Text>
      <Button size="compact-xs" variant="subtle" onClick={() => onChange({ ...value, mates_with: mates.filter((_, j) => j !== i) })}>Remove partner</Button></Group>)}
    <RevisionPicker label="Mating partner body" kind="connector_body" value={partner} onChange={setPartner} definitions={definitions} />
    <Group align="end">
      <Select label="Contact correspondence" value={correspondence} data={[{ value: "same_contact_id", label: "Same contact IDs" }, { value: "explicit", label: "Explicit pairs" }]} onChange={(v) => setCorrespondence((v ?? "same_contact_id") as typeof correspondence)} />
      <Select label="Mating review" value={review} data={["unreviewed", "reviewed"]} onChange={(v) => setReview((v ?? "unreviewed") as typeof review)} />
      <TextInput label="Mating basis" value={basis} onChange={(e) => setBasis(e.currentTarget.value)} />
    </Group>
    {correspondence === "explicit" && <Group align="end">
      {pairs.map((p) => <Text key={p.this} size="sm" className="sb-mono">{p.this}→{p.other}</Text>)}
      <Select label="This body contact" value={mine} onChange={setMine} data={value.contacts.filter((c) => c.physical_role !== "key" && !pairs.some((p) => p.this === c.contact_id)).map((c) => c.contact_id)} />
      <TextInput label="Partner contact ID" value={theirs} onChange={(e) => setTheirs(e.currentTarget.value)} />
      <Button size="xs" variant="default" disabled={!mine || !theirs} onClick={() => { if (mine) setPairs([...pairs, { this: mine, other: theirs }]); setMine(null); setTheirs(""); }}>Add pair</Button>
    </Group>}
    <Group><Button size="xs" variant="default" disabled={!partner || (review === "reviewed" && !basis) || (correspondence === "explicit" && !pairs.length) || mates.some((m) => m.body_revision_id === partner)} onClick={() => {
      onChange({ ...value, mates_with: [...mates, { body_revision_id: partner, correspondence, pairs: correspondence === "explicit" ? pairs : [], review, basis: basis || null }] });
      setPartner(""); setPairs([]); setBasis(""); setReview("unreviewed");
    }}>Add mating partner</Button></Group>
  </Stack>;
}

function RevisionPicker({ label, kind, value, onChange, definitions }: { label: string; kind: string; value: string; onChange: (v: string) => void; definitions: Definition[] }) {
  const [definition, setDefinition] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const identity = useQuery({ queryKey: ["interface-reference", definition, offset], queryFn: () => read<Identity>(`catalog/definitions/${definition}?offset=${offset}`), enabled: !!definition });
  return <Stack gap="xs"><Select label={`${label} definition`} searchable value={definition} data={definitions.filter((d) => d.kind === kind).map((d) => ({ value: d.definition_id, label: d.name }))} onChange={(v) => { setDefinition(v); setOffset(0); }} /><Select label={`${label} revision`} value={value || null} onChange={(v) => onChange(v ?? "")} data={(identity.data?.revisions ?? []).map((r) => ({ value: r.revision_id, label: revisionOptionLabel(identity.data?.name, r.number) }))} />{identity.data && <Group><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Earlier {label} revisions</Button><Button disabled={identity.data.revisions.length < 50} onClick={() => setOffset(offset + 50)}>Later {label} revisions</Button></Group>}<TextInput label={`${label} exact revision ID`} description="An accessible revision from another project can also be supplied." value={value} onChange={(e) => onChange(e.currentTarget.value)} />{identity.isError && <Alert color="red">{identity.error.message}</Alert>}</Stack>;
}
function PinoutEditor({ value, onChange, definitions }: { value: Pinout; onChange: (v: Pinout) => void; definitions: Definition[] }) {
  const [contactId, setContactId] = useState<string | null>(null);
  const body = useQuery({ queryKey: ["interface-body", value.body_revision_id], queryFn: () => read<Inspection>(`interfaces/revisions/${value.body_revision_id}`), enabled: !!value.body_revision_id });
  const contacts = body.data?.interface.kind === "connector_body" ? body.data.interface.contacts : [];
  return <Stack><RevisionPicker label="Physical body" kind="connector_body" value={value.body_revision_id} onChange={(v) => onChange({ ...value, body_revision_id: v })} definitions={definitions} />{body.isError && <Alert color="red">{body.error.message}</Alert>}
    <PinoutVariantFields value={value} onChange={onChange} />
    {body.data?.pinout_variants && <PinoutVariantList variants={body.data.pinout_variants} title="Pinout variants of this body" />}
    <OrientationEditor value={value.orientation} onChange={(v) => onChange({ ...value, orientation: v })} />
    <Group><Select label="Pin table review" value={value.review} data={["unreviewed", "reviewed"]} onChange={(v) => onChange({ ...value, review: v as Pinout["review"] })} /><TextInput label="Review basis" value={value.review_basis ?? ""} onChange={(e) => onChange({ ...value, review_basis: e.currentTarget.value || null })} /></Group>
    <PinoutSignalsEditor value={value} onChange={onChange} definitions={definitions} contacts={contacts} />
    {value.assignments.map((assignment, i) => {
      const change = (patch: Partial<typeof assignment.electrical>) => onChange({ ...value, assignments: value.assignments.map((a, j) => j === i ? { ...a, electrical: { ...a.electrical, ...patch } } : a) });
      return <Card withBorder key={assignment.contact_id}><Stack><Text fw={600}>Contact {assignment.contact_id}</Text><Group><TextInput label="Signal note" value={assignment.electrical.signal ?? ""} onChange={(e) => change({ signal: e.currentTarget.value || null })} /><Select label="Logical role" value={assignment.electrical.role} data={["unknown", "signal", "power", "return", "shield", "chassis", "unused"]} onChange={(v) => change({ role: v ?? "unknown" })} /><Select label="Direction from device" value={assignment.electrical.direction} data={["unknown", "input", "output", "bidirectional", "passive"]} onChange={(v) => change({ direction: v ?? "unknown" })} /></Group><Group>
        {([['voltage_min_v', 'Minimum voltage (V)'], ['voltage_max_v', 'Maximum voltage (V)'], ['current_max_a', 'Maximum current (A)']] as const).map(([key, label]) => <OperatingNumberInput key={key} label={`${label}; blank = unknown`} value={assignment.electrical[key] ?? ""} onChange={(v) => change({ [key]: v })} />)}
      </Group><Group>{([['protocol', 'Protocol'], ['condition', 'Applicable condition'], ['basis', 'Declaration basis']] as const).map(([key, label]) => <TextInput key={key} label={label} value={assignment.electrical[key] ?? ""} onChange={(e) => change({ [key]: e.currentTarget.value || null })} />)}</Group><ElectricalConditionsEditor value={assignment.electrical} onChange={change} /><Button variant="subtle" onClick={() => onChange({ ...value, assignments: value.assignments.filter((_, j) => j !== i) })}>Remove assignment {assignment.contact_id}</Button></Stack></Card>;
    })}
    <Group align="end"><Select label="Physical contact to assign" data={contacts.filter((c) => c.physical_role !== "key" && !value.assignments.some((a) => a.contact_id === c.contact_id)).map((c) => ({ value: c.contact_id, label: c.contact_id }))} value={contactId} onChange={setContactId} /><Button disabled={!contactId} onClick={() => { if (contactId) onChange({ ...value, assignments: [...value.assignments, { contact_id: contactId, electrical: unknownElectrical() }] }); setContactId(null); }}>Assign contact</Button></Group>
  </Stack>;
}
function MappingEditor({ value, onChange, definitions }: { value: Mapping; onChange: (v: Mapping) => void; definitions: Definition[] }) {
  const [contactId, setContactId] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [localId, setLocalId] = useState("");
  const [feature, setFeature] = useState("");
  const [condition, setCondition] = useState("");
  const [basis, setBasis] = useState("");
  const pins = useQuery({ queryKey: ["mapping-pins", value.external_pinout_revision_id], queryFn: () => read<Inspection>(`interfaces/revisions/${value.external_pinout_revision_id}`), enabled: !!value.external_pinout_revision_id });
  const revision = useQuery({ queryKey: ["mapping-assembly-revision", value.assembly_revision_id], queryFn: () => read<{ snapshot_id: string }>(`revisions/${value.assembly_revision_id}`), enabled: !!value.assembly_revision_id });
  const assembly = useQuery({ queryKey: ["mapping-assembly", revision.data?.snapshot_id], queryFn: () => read<{ occurrences: { address: { path: string[] }; revision_id: string; name: string; display_ref: string }[] }>(`assemblies/snapshots/${revision.data?.snapshot_id}`), enabled: !!revision.data?.snapshot_id });
  const selected = assembly.data?.occurrences.find((o) => JSON.stringify(o.address.path) === path);
  return <Stack><RevisionPicker label="Assembly" kind="assembly" value={value.assembly_revision_id} onChange={(v) => { setPath(null); onChange({ ...value, assembly_revision_id: v }); }} definitions={definitions} /><RevisionPicker label="External pinout" kind="pinout" value={value.external_pinout_revision_id} onChange={(v) => { setContactId(null); onChange({ ...value, external_pinout_revision_id: v }); }} definitions={definitions} />
    {[pins.error, revision.error, assembly.error].filter(Boolean).map((error, i) => <Alert key={i} color="red">{error?.message}</Alert>)}
    {value.passages.map((p, i) => <Card key={p.local_id} withBorder><Text>{p.external_contact_id} → {p.internal.path.join(" / ")} · {p.internal.feature_id}</Text><Text size="sm"><RevisionLabel id={p.internal.revision_id} role="Pinned" />. Condition: {p.condition ?? "unknown"}. Basis: {p.basis}</Text><Button variant="subtle" onClick={() => onChange({ ...value, passages: value.passages.filter((_, j) => j !== i) })}>Remove passage {p.local_id}</Button></Card>)}
    <TextInput label="Passage stable ID" value={localId} onChange={(e) => setLocalId(e.currentTarget.value)} />
    <Select label="External contact" value={contactId} onChange={setContactId} data={(pins.data?.contacts ?? []).filter((c) => c.physical_role !== "key").map((c) => ({ value: c.contact_id, label: c.contact_id }))} />
    <Select label="Exact internal occurrence" value={path} onChange={setPath} data={(assembly.data?.occurrences ?? []).map((o) => ({ value: JSON.stringify(o.address.path), label: `${o.address.path.join(" / ")} · ${o.name} (${o.display_ref})` }))} />
    {selected && <Text size="sm"><RevisionLabel id={selected.revision_id} role="Internal" /></Text>}
    <TextInput label="Internal terminal feature ID" description="Body/pinout contacts are checked. Other board feature identifiers remain declared and not evaluated." value={feature} onChange={(e) => setFeature(e.currentTarget.value)} />
    <TextInput label="Passage condition (blank = unknown)" value={condition} onChange={(e) => setCondition(e.currentTarget.value)} /><TextInput label="Passage declaration basis" value={basis} onChange={(e) => setBasis(e.currentTarget.value)} />
    <Button disabled={!localId || !contactId || !selected || !feature || !basis} onClick={() => { if (selected && contactId) { onChange({ ...value, passages: [...value.passages, { local_id: localId, external_contact_id: contactId, kind: "declared_passage", internal: { path: selected.address.path, revision_id: selected.revision_id, feature_id: feature }, condition: condition || null, basis }] }); setLocalId(""); setFeature(""); } }}>Add declared passage</Button>
  </Stack>;
}
export function InterfaceInspector({ revisionId }: { revisionId: string }) {
  const [contactId, setContactId] = useState("");
  const [traced, setTraced] = useState("");
  const [viewSide, setViewSide] = useState<"mating" | "termination" | null>(null);
  const inspected = useQuery({ queryKey: ["interface-inspect", revisionId], queryFn: () => read<Inspection>(`interfaces/revisions/${revisionId}`) });
  const tracedPath = useQuery({ queryKey: ["interface-trace", revisionId, traced], queryFn: () => read<Trace>(`interfaces/revisions/${revisionId}/trace?contact_id=${encodeURIComponent(traced)}`), enabled: !!traced });
  return <Card withBorder><Stack><Title order={3}>Frozen interface inspection</Title><Text size="sm"><RevisionLabel id={revisionId} /></Text>
    {inspected.isError && <Alert color="red">{inspected.error.message}</Alert>}
    <Button disabled={inspected.isFetching} onClick={() => void inspected.refetch()}>Refresh interface authority</Button>
    {inspected.data && !inspected.isError && !inspected.isFetching && <><Text>Compatibility: {inspected.data.compatibility}</Text>
      {inspected.data.interface.kind === "connector_body" && <><Text>Body family: {inspected.data.interface.family ?? "unknown"}; mating role: {inspected.data.interface.mating_role}</Text>{inspected.data.pinout_variants && <PinoutVariantList variants={inspected.data.pinout_variants} title="Pinout variants" currentBody={revisionId} />}{inspected.data.mates_with && <MatingList mates={inspected.data.mates_with} matedBy={inspected.data.mated_by ?? []} />}<Text>Viewing side: {inspected.data.interface.drawing_orientation.viewing_side}</Text>{inspected.data.interface.contacts.map((c) => <Text key={c.contact_id}>{c.contact_id}: {c.physical_role} · number {c.number ?? "unknown"} · {c.label || "unlabelled"} · source x,y {formatCoordinates(c.position_mm)} mm</Text>)}</>}
      {inspected.data.interface.kind === "pinout" && <><Text><RevisionLabel id={inspected.data.interface.body_revision_id} role="Body" /></Text><Text>Variant: {inspected.data.interface.variant_label ?? "unnamed"} · role {inspected.data.interface.role ?? "unknown"} · standard {inspected.data.interface.standard ?? "not stated"}</Text><Text>Pin table: {inspected.data.interface.review}; viewing side: {inspected.data.interface.orientation.viewing_side}</Text><Table><Table.Thead><Table.Tr><Table.Th>Physical contact</Table.Th><Table.Th>Typed signal</Table.Th><Table.Th>Signal note</Table.Th><Table.Th>Role</Table.Th><Table.Th>Direction</Table.Th><Table.Th>Polarity</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{inspected.data.contacts?.map((c) => <Table.Tr key={c.contact_id}><Table.Td>{c.contact_id} ({c.physical_role})</Table.Td><Table.Td><PinSignalCell row={inspected.data.signals?.[c.contact_id]} /></Table.Td><Table.Td>{c.electrical?.signal ?? "—"}</Table.Td><Table.Td>{c.electrical?.role ?? "unknown"}</Table.Td><Table.Td>{c.electrical?.direction ?? "unknown"}</Table.Td><Table.Td>{c.electrical?.polarity ?? "unknown"} · {c.electrical?.polarity_basis ?? "unknown basis"}</Table.Td></Table.Tr>)}</Table.Tbody></Table></>}
      {inspected.data.contact_view && <><Select label="Contact drawing viewing side" value={viewSide ?? inspected.data.contact_view.selected_orientation.viewing_side} data={["mating", "termination"]} onChange={side => setViewSide(side as "mating" | "termination")} /><ContactDrawing view={viewSide && inspected.data.contact_views ? inspected.data.contact_views[viewSide] : inspected.data.contact_view} /></>}
      {inspected.data.contacts?.map(c => c.electrical?.conditional_ratings?.map(r => <Card withBorder key={`${c.contact_id}:${r.local_id}`}><Text>Contact {c.contact_id} conditional rating {r.local_id}: {r.minimum ?? "no minimum"} to {r.maximum} {r.dimension === "voltage" ? "V" : "A"}</Text><Text>Temperature {r.scope.temperature ? `${r.scope.temperature.minimum_c} to ${r.scope.temperature.maximum_c} C` : "unconstrained"} · mode {r.scope.mode ?? "unconstrained"} · basis {r.basis}</Text><Text>Evidence: {JSON.stringify(inspected.data.rating_evidence?.[c.contact_id]?.[r.local_id] ?? r.evidence)}</Text></Card>))}
      {inspected.data.interface.kind === "interface_map" && <><Text><RevisionLabel id={inspected.data.interface.assembly_revision_id} role="Assembly" /></Text><Text><RevisionLabel id={inspected.data.interface.external_pinout_revision_id} role="External pinout" /></Text><Group align="end"><TextInput label="External contact to trace" value={contactId} onChange={(e) => setContactId(e.currentTarget.value)} /><Button disabled={!contactId} onClick={() => setTraced(contactId)}>Trace declared path</Button></Group></>}
    </>}
    {tracedPath.isError && <Alert color="red">{tracedPath.error.message}</Alert>}
    {inspected.data && !inspected.isError && !inspected.isFetching && tracedPath.data && !tracedPath.isError && !tracedPath.isFetching && <><Text>Path: {tracedPath.data.status}. Continuity: {tracedPath.data.continuity}.</Text>{tracedPath.data.targets.map((t) => <Card withBorder key={t.passage_id}><Text>{tracedPath.data.external_contact_id} → {t.path.join(" / ")} · {t.feature_id}</Text><Text size="sm"><RevisionLabel id={t.revision_id} snapshotId={t.snapshot_id} /></Text><Text>Feature status: {t.feature_status}; condition: {t.condition ?? "unknown"}</Text><Text>Declaration: {t.basis}</Text></Card>)}</>}
  </Stack></Card>;
}
