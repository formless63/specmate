import { Alert, Button, Card, Group, Select, Stack, Text, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { read, type Body, type Definition, type Inspection, type Interface, type Mapping, type Orientation, type Pinout } from './api';
import { SignalSetEditor } from './SignalSetFields';
import { ConventionEditor } from './ConventionFields';
import { PortEditor } from './PortEditor';
import { PinoutVariantFields } from './PinoutSignals';
import { PinoutWorkbench, type WorkbenchMode } from '../pinout-editor/PinoutWorkbench';
import { GeometryPicker } from '../pinout-editor/GeometryPicker';
import { ContactPositionEditor } from './InterfaceConditions';
import { BodyFace } from './BodyFace';
import { OperatingNumberInput } from './declaration-inputs';
import { RevisionLabel } from '../../lib/IdentityLabel';
import { RevisionPicker } from '../cables/RevisionPicker';

export function InterfaceEditor({ value, onChange, definitions, mode, definitionId = null, active = true }: { value: Interface; onChange: (v: Interface) => void; definitions?: Definition[]; mode: WorkbenchMode; definitionId?: string | null; active?: boolean }) {
  if (value.kind === "connector_body") return <BodyEditor value={value} onChange={onChange} definitions={definitions} />;
  if (value.kind === "pinout") return <PinoutEditor value={value} onChange={onChange} definitions={definitions} mode={mode} definitionId={definitionId} />;
  if (value.kind === "signal_set") return <SignalSetEditor value={value} onChange={onChange} />;
  if (value.kind === "port") return <PortEditor value={value} onChange={onChange} definitions={definitions} mode={mode} />;
  if (value.kind === "conductor_convention") return <ConventionEditor value={value} onChange={onChange} definitions={definitions ?? []} />;
  return <MappingEditor active={active} value={value} onChange={onChange} definitions={definitions} />;
}
function OrientationEditor({ value, onChange }: { value: Orientation; onChange: (v: Orientation) => void }) {
  return <Group align="end"><Select label="Viewing side" value={value.viewing_side} data={["unknown", "mating", "termination"]} onChange={(v) => onChange(v === "unknown" ? { viewing_side: "unknown", rotation_degrees: null, datum: null } : { ...value, viewing_side: v as Orientation["viewing_side"] })} /><TextInput label="Orientation datum" disabled={value.viewing_side === "unknown"} value={value.datum ?? ""} onChange={(e) => onChange({ ...value, datum: e.currentTarget.value || null })} /><OperatingNumberInput label="Rotation degrees (blank = unknown)" min={0} max={359.999} disabled={value.viewing_side === "unknown"} value={value.rotation_degrees ?? ""} onChange={(v) => onChange({ ...value, rotation_degrees: v })} /></Group>;
}
export function BodyEditor({ value, onChange, definitions, face = true }: { value: Body; onChange: (v: Body) => void; definitions?: Definition[]; face?: boolean }) {
  const [contactId, setContactId] = useState("");
  return <Stack>{face && <BodyFace body={value} caption="Face preview" />}<GeometryPicker body={value} onChange={onChange} /><Group><TextInput label="Body family (blank = unknown)" value={value.family ?? ""} onChange={(e) => onChange({ ...value, family: e.currentTarget.value || null })} /><Select label="Mating role" value={value.mating_role} data={["unknown", "plug", "receptacle", "hermaphroditic"]} onChange={(v) => onChange({ ...value, mating_role: v ?? "unknown" })} /></Group><OrientationEditor value={value.drawing_orientation} onChange={(v) => onChange({ ...value, drawing_orientation: v })} />
    {value.contacts.map((contact, i) => <Group key={contact.contact_id}><Text>{contact.contact_id}</Text><TextInput label={`Contact ${contact.contact_id} number (blank = unknown)`} value={contact.number ?? ""} onChange={e => onChange({ ...value, contacts: value.contacts.map((c, j) => j === i ? { ...c, number: e.currentTarget.value || null } : c) })} /><ContactPositionEditor contactId={contact.contact_id} value={contact.position_mm} onChange={position_mm => onChange({ ...value, contacts: value.contacts.map((c, j) => j === i ? { ...c, position_mm } : c) })} /><TextInput label="Contact label" value={contact.label} onChange={(e) => onChange({ ...value, contacts: value.contacts.map((c, j) => j === i ? { ...c, label: e.currentTarget.value } : c) })} /><Select label="Physical role" value={contact.physical_role} data={["contact", "shell", "key"]} onChange={(v) => onChange({ ...value, contacts: value.contacts.map((c, j) => j === i ? { ...c, physical_role: v as typeof c.physical_role } : c) })} /><Button variant="subtle" onClick={() => onChange({ ...value, contacts: value.contacts.filter((_, j) => j !== i) })}>Remove contact {contact.contact_id}</Button></Group>)}
    <MatesEditor value={value} onChange={onChange} definitions={definitions} />
    <Group align="end"><TextInput label="New physical contact ID" value={contactId} onChange={(e) => setContactId(e.currentTarget.value)} /><Button disabled={!contactId || value.contacts.some((c) => c.contact_id === contactId)} onClick={() => { onChange({ ...value, contacts: [...value.contacts, { contact_id: contactId, physical_role: "contact", label: "", position_mm: null }] }); setContactId(""); }}>Add contact</Button></Group>
  </Stack>;
}

/** Declared mating partners: an exact partner body revision, contact correspondence and review. Never inferred from family names. */
function MatesEditor({ value, onChange, definitions }: { value: Body; onChange: (v: Body) => void; definitions?: Definition[] }) {
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

export function PinoutEditor({ value, onChange, definitions, mode, definitionId, workbench = true }: { value: Pinout; onChange: (v: Pinout) => void; definitions?: Definition[]; mode: WorkbenchMode; definitionId: string | null; workbench?: boolean }) {
  const body = useQuery({ queryKey: ["interface-inspect", value.body_revision_id], queryFn: () => read<Inspection>(`interfaces/revisions/${value.body_revision_id}`), enabled: !!value.body_revision_id });
  return <Stack><RevisionPicker label="Physical body" kind="connector_body" value={value.body_revision_id} onChange={(v) => onChange({ ...value, body_revision_id: v })} definitions={definitions} />{body.isError && <Alert color="red">{body.error.message}</Alert>}
    <PinoutVariantFields value={value} onChange={onChange} />
    {workbench && <PinoutWorkbench value={value} onChange={onChange} mode={mode} definitions={definitions} definitionId={definitionId} />}
    <OrientationEditor value={value.orientation} onChange={(v) => onChange({ ...value, orientation: v })} />
    <Group><Select label="Pin table review" value={value.review} data={["unreviewed", "reviewed"]} onChange={(v) => onChange({ ...value, review: v as Pinout["review"] })} /><TextInput label="Review basis" value={value.review_basis ?? ""} onChange={(e) => onChange({ ...value, review_basis: e.currentTarget.value || null })} /></Group>
  </Stack>;
}
function MappingEditor({ value, onChange, definitions, active = true }: { active?: boolean; value: Mapping; onChange: (v: Mapping) => void; definitions?: Definition[] }) {
  const [contactId, setContactId] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [localId, setLocalId] = useState("");
  const [feature, setFeature] = useState("");
  const [condition, setCondition] = useState("");
  const [basis, setBasis] = useState("");
  const pins = useQuery({ queryKey: ["mapping-pins", value.external_pinout_revision_id], queryFn: () => read<Inspection>(`interfaces/revisions/${value.external_pinout_revision_id}`), enabled: active && !!value.external_pinout_revision_id });
  const revision = useQuery({ queryKey: ["mapping-assembly-revision", value.assembly_revision_id], queryFn: () => read<{ snapshot_id: string }>(`revisions/${value.assembly_revision_id}`), enabled: active && !!value.assembly_revision_id });
  const assembly = useQuery({ queryKey: ["mapping-assembly", revision.data?.snapshot_id], queryFn: () => read<{ occurrences: { address: { path: string[] }; revision_id: string; name: string; display_ref: string }[] }>(`assemblies/snapshots/${revision.data?.snapshot_id}`), enabled: active && !!revision.data?.snapshot_id });
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
