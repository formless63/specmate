import { Alert, Button, Card, Group, MultiSelect, NumberInput, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SbUnknown } from "../../components/sb";
import { InspectionScope, ReadOnlyNote, usePermission } from "../../lib/permissions";
import { RevisionLabel } from "../../lib/IdentityLabel";
import { revisionOptionLabel, newestFirst } from "../../lib/revision-labels";
import { SIGNAL_TYPE_LABELS, SIGNAL_TYPES, command, initialInterface, newSignal, read, type DeclaredQuantity, type Definition, type Draft, type Identity, type Inspection, type Signal, type SignalSet, type SignalType } from "./api";
import { definitionIn, referenceFromProject, useOpenNewest, useOpenProbed } from "../scope/openProbed";
import { ContinueDraftButton } from "../scope/ContinueDraftButton";
import "./signals.css";

const RETURN_TYPES: SignalType[] = ["ground_return", "shield", "chassis"];
const LEVEL_UNITS = ["V", "Vpp", "dBu", "dBV"];

/** Color family of a signal type, drawn from theme tokens in signals.css. */
function family(type: SignalType): string {
  if (type === "analog_video" || type === "sync") return "video";
  if (type === "analog_audio" || type === "digital_audio") return "audio";
  if (type === "power") return "power";
  if (RETURN_TYPES.includes(type)) return "return";
  if (type === "data" || type === "control") return "data";
  return "unknown";
}

/** The signal type as a small chip with its color family; unknown is hatched, never blank. */
export function SignalTypeChip({ type }: { type: SignalType }) {
  return <span className="sb-signal-type" data-family={family(type)} data-unknown={type === "unknown" || undefined}>{SIGNAL_TYPE_LABELS[type]}</span>;
}

/** A declared level or impedance; unknown stays visibly unknown, never zero. */
export function DeclaredValue({ value, unit, what }: { value: DeclaredQuantity; unit: string; what: string }) {
  if (value.status !== "known") return <SbUnknown what={what} />;
  const range = value.minimum !== null || value.maximum !== null ? ` (${value.minimum ?? "…"} to ${value.maximum ?? "…"})` : "";
  return <span className="sb-mono" title={value.basis ?? undefined}>{value.nominal ?? ""}{range} {unit}</span>;
}

/** Signals lens: the Library home for shared signal sets used by pinout variants. */
export function SignalSetPanel({ projectId }: { projectId: string | null }) {
  return <SignalSets key={projectId ?? "library"} projectId={projectId} />;
}

function SignalSets({ projectId }: { projectId: string | null }) {
  const cache = useQueryClient();
  const createGate = usePermission("item.create");
  const freezeGate = usePermission("design.freeze");
  const [name, setName] = useState("");
  const [value, setValue] = useState<SignalSet>(() => initialInterface("signal_set") as SignalSet);
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const definitions = useQuery({ queryKey: ["signal-set-definitions", projectId], queryFn: () => read<Definition[]>("workspace/definitions") });
  const identity = useQuery({ queryKey: ["signal-set-identity", definitionId], queryFn: () => read<Identity>(`catalog/definitions/${definitionId}`), enabled: !!definitionId });
  const draft = useQuery({ queryKey: ["signal-set-draft", draftId], queryFn: () => read<Draft>(`interfaces/drafts/${draftId}`), enabled: !!draftId });
  const pick = (id: string | null) => { setDefinitionId(id); setDraftId(null); setRevisionId(null); };
  // A Library row or deep link opens that set: its newest draft, else its latest frozen revision.
  const openNewest = useOpenNewest(identity.data, setDraftId, setRevisionId);
  useOpenProbed(definitionIn(definitions.data, ["signal_set"]), (id) => { pick(id); openNewest(id); });
  const create = useMutation({ mutationFn: () => command<Draft>("interface.create", { name, interface: value }), onSuccess: async (data) => {
    setDefinitionId(data.definition_id); setDraftId(data.draft_id); setRevisionId(null);
    await referenceFromProject(projectId, data.definition_id, "signal set");
    await cache.invalidateQueries({ queryKey: ["signal-set-definitions", projectId] });
  } });
  const freeze = useMutation({ mutationFn: () => command<{ revision_id: string }>("interface.freeze", { draft_id: draftId }, draft.data?.state), onSuccess: async (data) => {
    setRevisionId(data.revision_id);
    await cache.invalidateQueries({ queryKey: ["signal-set-draft", draftId] });
    await cache.invalidateQueries({ queryKey: ["signal-set-identity", definitionId] });
  } });
  const sets = (definitions.data ?? []).filter((d) => d.kind === "signal_set");
  return <Stack>
    <Title order={2}>Signals</Title>
    <Text size="sm">A signal set names what travels through a contact: its type, which signals a ground returns, and declared level and impedance. Pinout variants pick signals from an exact frozen set. Equal names in two sets are different signals; blank values stay unknown.</Text>
    {definitions.isError && <Alert color="red">{definitions.error.message}</Alert>}
    <Group align="end">
      <Select label="Signal set" searchable placeholder={sets.length ? "Choose a set" : "No signal sets yet"} data={sets.map((d) => ({ value: d.definition_id, label: d.name }))} value={definitionId} onChange={pick} />
      {identity.data && <ContinueDraftButton drafts={identity.data.drafts} revisionId={revisionId} draftId={draftId} onOpen={setDraftId} />}
      {identity.data && <Select label="Frozen revision" value={revisionId} onChange={setRevisionId} data={newestFirst(identity.data.revisions).map((r) => ({ value: r.revision_id, label: revisionOptionLabel(identity.data.name, r.number) }))} />}
      {identity.data && identity.data.drafts.length > 0 && <Select label="Draft" value={draftId} onChange={setDraftId} data={identity.data.drafts.map((d, i) => ({ value: d.draft_id, label: `Draft ${i + 1}` }))} />}
    </Group>
    {identity.isError && <Alert color="red">{identity.error.message}</Alert>}
    {revisionId && <SignalSetInspector key={revisionId} revisionId={revisionId} />}
    {draft.isError && <Alert color="red">{draft.error.message}</Alert>}
    {draft.data && <><SignalSetDraft key={`${draft.data.draft_id}:${draft.data.state}`} draft={draft.data} onSaved={async () => { await cache.invalidateQueries({ queryKey: ["signal-set-draft", draftId] }); }} />
      <Group><Button loading={freeze.isPending} onClick={() => freeze.mutate()} {...freezeGate.props}>Freeze signal set</Button><ReadOnlyNote permission="design.freeze">Freezing signal sets is unavailable.</ReadOnlyNote></Group></>}
    {freeze.isError && <Alert color="red">{freeze.error.message}</Alert>}
    <Card withBorder><Stack gap="xs">
      <Title order={3}>New signal set</Title>
      <InspectionScope permission="item.create">
        <TextInput label="Signal set name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <SignalSetEditor value={value} onChange={setValue} />
      </InspectionScope>
      <Group><Button disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()} {...createGate.props}>Create signal set draft</Button><ReadOnlyNote permission="item.create">Creating signal sets is unavailable.</ReadOnlyNote></Group>
      {create.isError && <Alert color="red">{create.error.message}</Alert>}
    </Stack></Card>
  </Stack>;
}

function SignalSetDraft({ draft, onSaved }: { draft: Draft; onSaved: () => Promise<void> }) {
  const editGate = usePermission("design.edit");
  const [value, setValue] = useState<SignalSet>(() => (draft.content.interface as SignalSet | undefined) ?? (initialInterface("signal_set") as SignalSet));
  const save = useMutation({ mutationFn: () => command("interface.update", { draft_id: draft.draft_id, interface: value }, draft.state), onSuccess: onSaved });
  return <Card withBorder><Stack gap="xs"><Title order={3}>Edit signal set draft</Title>
    <InspectionScope permission="design.edit"><SignalSetEditor value={value} onChange={setValue} /></InspectionScope>
    <Group><Button loading={save.isPending} onClick={() => save.mutate()} {...editGate.props}>Save signal set draft</Button><ReadOnlyNote permission="design.edit">Saving signal sets is unavailable.</ReadOnlyNote></Group>
    {save.isError && <Alert color="red">{save.error.message}</Alert>}
  </Stack></Card>;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/\+/g, "plus ").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
}

/** Dense signal table editor: one row per signal. */
export function SignalSetEditor({ value, onChange }: { value: SignalSet; onChange: (v: SignalSet) => void }) {
  const [name, setName] = useState("");
  const key = slug(name);
  const change = (i: number, patch: Partial<Signal>) => onChange({ ...value, signals: value.signals.map((s, j) => j === i ? { ...s, ...patch } : s) });
  const returnable = value.signals.filter((s) => !RETURN_TYPES.includes(s.type));
  return <Stack gap="xs">
    <TextInput label="Description" value={value.description ?? ""} onChange={(e) => onChange({ ...value, description: e.currentTarget.value || null })} />
    <Table.ScrollContainer minWidth={900}><Table withTableBorder verticalSpacing={4} className="sb-signal-table">
      <Table.Thead><Table.Tr><Table.Th>Name</Table.Th><Table.Th>Type</Table.Th><Table.Th>Return of</Table.Th><Table.Th>Level</Table.Th><Table.Th>Unit</Table.Th><Table.Th>Impedance (ohm)</Table.Th><Table.Th>Basis</Table.Th><Table.Th /></Table.Tr></Table.Thead>
      <Table.Tbody>{value.signals.map((signal, i) => <Table.Tr key={signal.key}>
        <Table.Td><TextInput size="xs" aria-label={`Name of ${signal.key}`} value={signal.name} onChange={(e) => change(i, { name: e.currentTarget.value })} /><Text className="sb-mono" size="xs" c="dimmed">{signal.key}</Text></Table.Td>
        <Table.Td><Select size="xs" aria-label={`Type of ${signal.name}`} value={signal.type} data={SIGNAL_TYPES.map((t) => ({ value: t, label: SIGNAL_TYPE_LABELS[t] }))} onChange={(t) => change(i, { type: (t ?? "unknown") as SignalType, return_for: RETURN_TYPES.includes((t ?? "unknown") as SignalType) ? signal.return_for : [] })} /></Table.Td>
        <Table.Td>{RETURN_TYPES.includes(signal.type) ? <MultiSelect size="xs" aria-label={`Signals returned by ${signal.name}`} value={signal.return_for} data={returnable.map((s) => ({ value: s.key, label: s.name }))} onChange={(keys) => change(i, { return_for: keys })} /> : <Text size="xs" c="dimmed">Not a return</Text>}</Table.Td>
        <Table.Td><QuantityInput label={`Level of ${signal.name}`} value={signal.level} onChange={(level) => change(i, { level: { ...level, basis: level.status === "known" ? signal.basis : null, unit: level.status === "known" ? (signal.level.unit && signal.level.unit !== "unknown" ? signal.level.unit : "V") : "unknown" } })} /></Table.Td>
        <Table.Td><Select size="xs" aria-label={`Level unit of ${signal.name}`} disabled={signal.level.status !== "known"} value={signal.level.status === "known" ? signal.level.unit ?? "V" : null} placeholder="unknown" data={LEVEL_UNITS} onChange={(unit) => change(i, { level: { ...signal.level, unit: unit ?? "V" } })} /></Table.Td>
        <Table.Td><QuantityInput label={`Impedance of ${signal.name}`} value={signal.impedance} onChange={(impedance) => change(i, { impedance: { ...impedance, basis: impedance.status === "known" ? signal.basis : null, unit: "ohm" } })} /></Table.Td>
        <Table.Td><TextInput size="xs" aria-label={`Basis for ${signal.name}`} placeholder="Required for known values" value={signal.basis ?? ""} onChange={(e) => {
          const basis = e.currentTarget.value || null;
          change(i, { basis, level: signal.level.status === "known" ? { ...signal.level, basis } : signal.level, impedance: signal.impedance.status === "known" ? { ...signal.impedance, basis } : signal.impedance });
        }} /></Table.Td>
        <Table.Td><Button size="xs" variant="subtle" aria-label={`Remove ${signal.name}`} onClick={() => onChange({ ...value, signals: value.signals.filter((_, j) => j !== i).map((s) => ({ ...s, return_for: s.return_for.filter((k) => k !== signal.key), differential_with: s.differential_with === signal.key ? null : s.differential_with })) })}>Remove</Button></Table.Td>
      </Table.Tr>)}</Table.Tbody>
    </Table></Table.ScrollContainer>
    <Group align="end">
      <TextInput label="New signal name" value={name} onChange={(e) => setName(e.currentTarget.value)} description={key ? `Key ${key}` : undefined} />
      <Button disabled={!key || value.signals.some((s) => s.key === key || s.name.trim().toLowerCase() === name.trim().toLowerCase())} onClick={() => { onChange({ ...value, signals: [...value.signals, newSignal(key, name.trim())] }); setName(""); }}>Add signal</Button>
    </Group>
  </Stack>;
}

/** Blank means unknown; a number makes the value known and needs the row's basis. */
function QuantityInput({ label, value, onChange }: { label: string; value: DeclaredQuantity; onChange: (v: DeclaredQuantity) => void }) {
  return <NumberInput size="xs" aria-label={`${label} (blank = unknown)`} placeholder="unknown" value={value.nominal ?? ""} onChange={(raw) => {
    const n = raw === "" ? null : Number(raw);
    onChange(n === null || !Number.isFinite(n) ? { status: "unknown", nominal: null, minimum: null, maximum: null, basis: null } : { ...value, status: "known", nominal: n });
  }} />;
}

/** A frozen signal set as a dense read-only table. */
export function SignalSetInspector({ revisionId }: { revisionId: string }) {
  const inspected = useQuery({ queryKey: ["interface-inspect", revisionId], queryFn: () => read<Inspection>(`interfaces/revisions/${revisionId}`) });
  const value = inspected.data?.interface.kind === "signal_set" ? inspected.data.interface : null;
  const names = new Map((value?.signals ?? []).map((s) => [s.key, s.name]));
  return <Card withBorder><Stack gap="xs"><Title order={3}>Frozen signal set</Title><Text size="sm"><RevisionLabel id={revisionId} /></Text>
    {inspected.isError && <Alert color="red">{inspected.error.message}</Alert>}
    {value?.description && <Text size="sm">{value.description}</Text>}
    {value && <Table.ScrollContainer minWidth={640}><Table withTableBorder verticalSpacing={4} className="sb-signal-table">
      <Table.Thead><Table.Tr><Table.Th>Signal</Table.Th><Table.Th>Type</Table.Th><Table.Th>Return of</Table.Th><Table.Th>Level</Table.Th><Table.Th>Impedance</Table.Th><Table.Th>Basis</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{value.signals.map((s) => <Table.Tr key={s.key}>
        <Table.Td className="sb-signal-name">{s.name}</Table.Td>
        <Table.Td><SignalTypeChip type={s.type} /></Table.Td>
        <Table.Td>{s.return_for.length ? s.return_for.map((k) => names.get(k) ?? k).join(", ") : "—"}</Table.Td>
        <Table.Td><DeclaredValue value={s.level} unit={s.level.unit ?? ""} what="Level" /></Table.Td>
        <Table.Td><DeclaredValue value={s.impedance} unit="ohm" what="Impedance" /></Table.Td>
        <Table.Td>{s.basis ?? s.level.basis ?? s.impedance.basis ?? (s.level.status === "known" || s.impedance.status === "known" ? <SbUnknown what="Basis" /> : "—")}</Table.Td>
      </Table.Tr>)}</Table.Tbody>
    </Table></Table.ScrollContainer>}
  </Stack></Card>;
}
