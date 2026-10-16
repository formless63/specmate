import { DefinitionSelect } from '../../components/library/DefinitionSelect';
import { Alert, Button, Group, Select, Stack, Table, Text, TextInput } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { SbUnknown } from "../../components/sb";
import { RevisionLabel } from "../../lib/IdentityLabel";
import { revisionOptionLabel, newestFirst } from "../../lib/revision-labels";
import { read, unknownElectrical, type Assignment, type Contact, type Definition, type Identity, type Inspection, type PinSignal, type Pinout, type PinoutRole, type PinoutVariant, type Signal } from "./api";
import { SignalTypeChip } from "./SignalSetFields";
import "./signals.css";
import { SUGGESTED_ROLE } from "../pinout-editor/model";

const ROLES: { value: PinoutRole; label: string }[] = [
  { value: "unknown", label: "Role unknown" }, { value: "source", label: "Source" }, { value: "sink", label: "Sink" }, { value: "bidirectional", label: "Bidirectional" },
];


/** Variant label, application role and standard: what makes a pinout a named variant of its body. */
export function PinoutVariantFields({ value, onChange }: { value: Pinout; onChange: (v: Pinout) => void }) {
  return <Group align="end">
    <TextInput label="Variant name" description="For example the device or application this pin table belongs to" value={value.variant_label ?? ""} onChange={(e) => onChange({ ...value, variant_label: e.currentTarget.value || null })} />
    <Select label="Variant role" value={value.role ?? "unknown"} data={ROLES} onChange={(v) => onChange({ ...value, role: (v ?? "unknown") as PinoutRole })} />
    <TextInput label="Standard (blank = not stated)" value={value.standard ?? ""} onChange={(e) => onChange({ ...value, standard: e.currentTarget.value || null })} />
  </Group>;
}

/** Named pinout variants of one body, listed together. Listing them never claims interchangeability. */
export function PinoutVariantList({ variants, title, currentBody }: { variants: PinoutVariant[]; title: string; currentBody?: string }) {
  return <Stack gap={4}>
    <Text className="sb-silk">{title}</Text>
    {variants.length === 0 ? <Text size="sm" c="dimmed">No frozen pinout variants of this body yet.</Text> : <div className="sb-variant-list">{variants.map((v) => <div className="sb-variant" key={v.definition_id} aria-current={currentBody ? v.same_body_revision : undefined}>
      <Text fw={600} size="sm">{v.variant_label ?? v.name}</Text>
      <Text size="xs" c="dimmed">{v.role === "unknown" ? "Role unknown" : v.role} · {v.standard ?? "standard not stated"}</Text>
      <Text size="xs" c="dimmed">{v.name} r{v.number}{currentBody && !v.same_body_revision ? " · pins an earlier body revision" : ""}</Text>
    </div>)}</div>}
    <Text size="xs" c="dimmed">Variants of one body are not electrically interchangeable; compatibility is not evaluated.</Text>
  </Stack>;
}

/** One contact's typed signal in a frozen pinout: name with type chip, a conditional list, or unknown. */
export function PinSignalCell({ row }: { row: PinSignal | undefined }) {
  if (!row || row.status === "unknown") return <SbUnknown what="Signal" />;
  if (row.status === "conditional") return <Stack gap={2}><Text size="xs" c="dimmed">Depends on a condition; unknown until one is selected</Text>
    {row.alternatives.map((a) => <Group gap={6} key={a.choice}><Text size="xs" className="sb-mono">{a.condition_key}={a.choice}</Text>{a.signal_ref ? <><Text size="sm">{a.signal_ref.name}</Text><SignalTypeChip type={a.signal_ref.type} /></> : <Text size="sm">{a.signal ?? a.role}</Text>}</Group>)}
  </Stack>;
  const signal = row.signal!;
  return <Group gap={6} wrap="nowrap"><Text size="sm">{signal.name}</Text><SignalTypeChip type={signal.type} /><Text size="xs" c="dimmed">{signal.set_name} r{signal.set_revision_number}</Text></Group>;
}

export function firstSetRevision(value: Pinout): string | null {
  for (const a of value.assignments ?? []) {
    if (a.electrical.signal_ref) return a.electrical.signal_ref.signal_set_revision_id;
    for (const alt of a.alternatives ?? []) if (alt.signal_ref) return alt.signal_ref.signal_set_revision_id;
  }
  return null;
}

/**
 * Pin table with signals picked by name from one exact frozen signal set. Each contact shows the
 * signal name and its type; contacts without a typed signal stay unknown.
 */
export function PinoutSignalsEditor({ value, onChange, definitions, contacts, setRevision: controlled, onSetRevision, selected, onSelect, hideConditions }: {
  value: Pinout; onChange: (v: Pinout) => void; definitions?: Definition[]; contacts: Contact[];
  /** Optional controlled signal set revision (shared with the face editor). */
  setRevision?: string | null; onSetRevision?: (id: string | null) => void;
  /** Optional pin selection shared with an inspector: the contact cell becomes a button. */
  selected?: string | null; onSelect?: (contactId: string | null) => void; hideConditions?: boolean;
}) {
  const [setDefinition, setSetDefinition] = useState<string | null>(null);
  const [ownPick, setOwnPick] = useState<string | null>(null);
  const picked = onSetRevision ? controlled ?? null : ownPick;
  const setPicked = onSetRevision ?? setOwnPick;
  const setRevision = picked ?? firstSetRevision(value);
  const identity = useQuery({ queryKey: ["signal-set-identity", setDefinition], queryFn: () => read<Identity>(`catalog/definitions/${setDefinition}`), enabled: !!setDefinition });
  const set = useQuery({ queryKey: ["interface-inspect", setRevision], queryFn: () => read<Inspection>(`interfaces/revisions/${setRevision}`), enabled: !!setRevision });
  const signals: Signal[] = set.data?.interface.kind === "signal_set" ? set.data.interface.signals : [];
  const byKey = new Map(signals.map((s) => [s.key, s]));
  const conditions = value.conditions ?? [];
  const assignment = (contactId: string): Assignment | undefined => value.assignments.find((a) => a.contact_id === contactId);
  const put = (contactId: string, next: (a: Assignment) => Assignment | null) => {
    const current = assignment(contactId) ?? { contact_id: contactId, electrical: unknownElectrical(), alternatives: [] };
    const updated = next(current);
    const rest = value.assignments.filter((a) => a.contact_id !== contactId);
    const ordered = updated ? [...rest, updated] : rest;
    const order = new Map(contacts.map((c, i) => [c.contact_id, i]));
    onChange({ ...value, assignments: ordered.sort((a, b) => (order.get(a.contact_id) ?? 1e9) - (order.get(b.contact_id) ?? 1e9)) });
  };
  const pick = (contactId: string, key: string | null) => put(contactId, (a) => {
    const signal = key ? byKey.get(key) : undefined;
    const role = a.electrical.role === "unknown" && signal ? SUGGESTED_ROLE[signal.type] ?? "unknown" : a.electrical.role;
    return { ...a, alternatives: [], electrical: { ...a.electrical, role, signal_ref: signal && setRevision ? { signal_set_revision_id: setRevision, key: signal.key } : null } };
  });
  const pinContacts = contacts.filter((c) => c.physical_role !== "key");
  const options = signals.map((s) => ({ value: s.key, label: s.name }));
  return <Stack gap="xs">
    <Text className="sb-silk">Pin signals</Text>
    <Group align="end">
      <DefinitionSelect label="Signal set" kind="signal_set" definitions={definitions} value={setDefinition} onChange={(v) => { setSetDefinition(v); setPicked(null); }} />
      {identity.data && <Select label="Signal set revision" value={picked} onChange={setPicked} data={newestFirst(identity.data.revisions).map((r) => ({ value: r.revision_id, label: revisionOptionLabel(identity.data.name, r.number) }))} />}
      {setRevision && <Text size="xs"><RevisionLabel id={setRevision} role="Signals from" /></Text>}
    </Group>
    {set.isError && <Alert color="red">{set.error.message}</Alert>}
    {!hideConditions && <ConditionsEditor value={value} onChange={onChange} />}
    {pinContacts.length === 0 ? <Text size="sm" c="dimmed">Choose the physical body to list its contacts.</Text> : <Table.ScrollContainer minWidth={640}><Table withTableBorder verticalSpacing={4} className="sb-signal-table">
      <Table.Thead><Table.Tr><Table.Th>Contact</Table.Th><Table.Th>Label</Table.Th><Table.Th>Signal</Table.Th><Table.Th>Type</Table.Th><Table.Th>Pin role</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{pinContacts.map((c) => {
        const a = assignment(c.contact_id);
        const ref = a?.electrical.signal_ref;
        const signal = ref ? byKey.get(ref.key) : undefined;
        const foreign = ref && ref.signal_set_revision_id !== setRevision;
        const alternatives = a?.alternatives ?? [];
        return <Table.Tr key={c.contact_id} data-selected={selected === c.contact_id || undefined}>
          <Table.Td className="sb-mono">{onSelect ? <button type="button" className="pwb-row-pick" aria-pressed={selected === c.contact_id} aria-label={`Select pin ${c.number ?? c.contact_id}`} onClick={() => onSelect(selected === c.contact_id ? null : c.contact_id)}>{c.number ?? c.contact_id}</button> : c.number ?? c.contact_id}</Table.Td>
          <Table.Td>{c.label || (c.physical_role === "shell" ? "Shell" : "—")}</Table.Td>
          <Table.Td>{alternatives.length > 0 ? <ConditionalCell assignment={a!} options={options} byKey={byKey} conditions={conditions} onChange={(next) => put(c.contact_id, () => next)} setRevision={setRevision} />
            : <Group gap={4} wrap="nowrap"><Select size="xs" searchable clearable aria-label={`Signal on contact ${c.number ?? c.contact_id}`} placeholder={setRevision ? "unknown" : "Choose a signal set"} disabled={!setRevision} value={foreign ? null : ref?.key ?? null} data={options} onChange={(key) => pick(c.contact_id, key)} />
              {conditions.length > 0 && <Button size="compact-xs" variant="subtle" onClick={() => put(c.contact_id, (x) => ({ ...x, electrical: { ...x.electrical, signal_ref: null }, alternatives: conditions[0]!.choices.map((choice) => ({ condition_key: conditions[0]!.key, choice: choice.key, signal_ref: null, signal: null, role: "unknown", basis: value.review_basis ?? "" })) }))}>Conditional</Button>}</Group>}
            {foreign && <Text size="xs" c="dimmed">From another signal set revision</Text>}</Table.Td>
          <Table.Td>{signal ? <SignalTypeChip type={signal.type} /> : alternatives.length ? <Text size="xs" c="dimmed">per condition</Text> : <SbUnknown what="Type" />}</Table.Td>
          <Table.Td><Text size="sm">{a?.electrical.role ?? "unknown"}</Text></Table.Td>
        </Table.Tr>;
      })}</Table.Tbody>
    </Table></Table.ScrollContainer>}
  </Stack>;
}

/** One pin whose meaning depends on a named condition: a signal per choice. */
function ConditionalCell({ assignment, options, byKey, conditions, onChange, setRevision }: { assignment: Assignment; options: { value: string; label: string }[]; byKey: Map<string, Signal>; conditions: NonNullable<Pinout["conditions"]>; onChange: (a: Assignment | null) => void; setRevision: string | null }) {
  const alternatives = assignment.alternatives ?? [];
  const condition = conditions.find((c) => c.key === alternatives[0]?.condition_key);
  return <Stack gap={2}>
    <Text size="xs" c="dimmed">Depends on {condition?.name ?? alternatives[0]?.condition_key}</Text>
    {alternatives.map((alt, i) => <Group key={alt.choice} gap={4} wrap="nowrap"><Text size="xs" className="sb-mono" w={70}>{condition?.choices.find((c) => c.key === alt.choice)?.name ?? alt.choice}</Text>
      <Select size="xs" searchable clearable aria-label={`Signal when ${alt.choice}`} placeholder="unknown" value={alt.signal_ref?.key ?? null} data={options} onChange={(key) => {
        const signal = key ? byKey.get(key) : undefined;
        onChange({ ...assignment, alternatives: alternatives.map((x, j) => j === i ? { ...x, signal_ref: signal && setRevision ? { signal_set_revision_id: setRevision, key: signal.key } : null, role: signal ? SUGGESTED_ROLE[signal.type] ?? "unknown" : "unknown" } : x) });
      }} />{alt.signal_ref && byKey.get(alt.signal_ref.key) && <SignalTypeChip type={byKey.get(alt.signal_ref.key)!.type} />}</Group>)}
    <Button size="compact-xs" variant="subtle" onClick={() => onChange({ ...assignment, alternatives: [] })}>Not conditional</Button>
  </Stack>;
}

/** Named device conditions (for example a regional variant) that conditional pins depend on. */
export function ConditionsEditor({ value, onChange }: { value: Pinout; onChange: (v: Pinout) => void }) {
  const [name, setName] = useState("");
  const [choices, setChoices] = useState("");
  const conditions = value.conditions ?? [];
  const key = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
  const parsed = choices.split(",").map((c) => c.trim()).filter(Boolean);
  return <Stack gap={4}>
    {conditions.map((c) => <Group key={c.key} gap={6}><Text size="sm">Condition {c.name}:</Text><Text size="sm" c="dimmed">{c.choices.map((x) => x.name).join(" / ")}</Text>
      <Button size="compact-xs" variant="subtle" onClick={() => onChange({ ...value, conditions: conditions.filter((x) => x.key !== c.key), assignments: value.assignments.map((a) => ({ ...a, alternatives: (a.alternatives ?? []).filter((alt) => alt.condition_key !== c.key) })) })}>Remove condition {c.name}</Button></Group>)}
    <Group align="end">
      <TextInput size="xs" label="New condition" placeholder="e.g. Device region" value={name} onChange={(e) => setName(e.currentTarget.value)} />
      <TextInput size="xs" label="Choices (comma separated)" placeholder="e.g. Region A, Region B" value={choices} onChange={(e) => setChoices(e.currentTarget.value)} />
      <Button size="xs" variant="default" disabled={!key(name) || parsed.length < 2 || conditions.some((c) => c.key === key(name))} onClick={() => {
        onChange({ ...value, conditions: [...conditions, { key: key(name), name: name.trim(), choices: parsed.map((c) => ({ key: key(c), name: c })) }] });
        setName(""); setChoices("");
      }}>Add condition</Button>
    </Group>
    {value.assignments.some((a) => (a.alternatives ?? []).some((alt) => !alt.basis)) && <Text size="xs" c="red">Conditional pin meanings use the pin table review basis; enter one before saving.</Text>}
  </Stack>;
}
