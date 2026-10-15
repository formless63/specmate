import { Alert, Badge, Button, Card, Group, MultiSelect, SegmentedControl, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { SbStatus, SbUnknown } from "../../components/sb";
import { InspectionScope, ReadOnlyNote, usePermission } from "../../lib/permissions";
import { revisionOptionLabel, useRevisionLabel } from "../../lib/revision-labels";
import { RevisionPicker } from "../cables/RevisionPicker";
import type { CableEnd } from "../interfaces/api";
import { SignalTypeChip } from "../interfaces/SignalSetPanel";
import { definitionIn, referenceFromProject, useOpenNewest, useOpenProbed } from "../scope/openProbed";
import { ContinueDraftButton } from "../scope/ContinueDraftButton";
import {
  CONDITIONING_LABELS, REQUIREMENT_LABELS, RETURN_LABELS, command, conductorText, contactText, emptyIntent, proposalPath, read,
  type CableIntent, type Definition, type Identity, type IntentDraft, type IntentInspection, type IntentRow, type Proposal, type Requirement,
} from "./api";

const ISOLATION = [{ value: "unknown", label: "unknown" }, { value: "no_unlisted_connections", label: "No connection beyond these rows" }, { value: "unlisted_allowed", label: "Other connections allowed" }];
const SHIELD = [{ value: "unknown", label: "unknown" }, { value: "bond_from", label: "Bond at the from end" }, { value: "bond_to", label: "Bond at the to end" }, { value: "bond_both", label: "Bond at both ends" }, { value: "isolated", label: "Isolated" }];

/** One intent end: a device port or a bare pinout variant (for example a standard input's expectations). */
function EndPicker({ label, value, onChange, definitions }: { label: string; value: string; onChange: (id: string) => void; definitions: Definition[] }) {
  const known = useRevisionLabel(value || null).data;
  const [kind, setKind] = useState<"port" | "pinout">(known?.readable && known.kind === "pinout" ? "pinout" : "port");
  // A saved end names its own kind once its label is read.
  const knownKind = known?.readable && (known.kind === "port" || known.kind === "pinout") ? known.kind : null;
  useEffect(() => { if (knownKind) setKind(knownKind); }, [knownKind]);
  return <Stack gap={4}>
    <SegmentedControl size="xs" w="fit-content" aria-label={`${label} kind`} value={kind} onChange={(v) => { setKind(v as "port" | "pinout"); onChange(""); }}
      data={[{ value: "port", label: "Device port" }, { value: "pinout", label: "Pinout variant" }]} />
    <RevisionPicker label={label} title={kind === "port" ? "Device port" : "Pinout variant"} kind={kind} value={value} onChange={onChange} definitions={definitions} />
  </Stack>;
}

function useEnd(revisionId: string) {
  return useQuery({ queryKey: ["intent-end", revisionId], queryFn: () => read<CableEnd>(`interfaces/revisions/${revisionId}/end`), enabled: !!revisionId });
}

/** Steps 1-3: from end, to end, then the proposed signal rows with their questions. */
export function IntentEditor({ value, onChange, definitions }: { value: CableIntent; onChange: (v: CableIntent) => void; definitions: Definition[] }) {
  const from = useEnd(value.from_revision_id);
  const to = useEnd(value.to_revision_id);
  const proposal = useMutation({ mutationFn: () => read<Proposal>(proposalPath(value.from_revision_id, value.to_revision_id)), onSuccess: (data) => onChange({ ...value, rows: data.rows }) });
  const open = value.rows.filter((r) => r.question).length;
  return <Stack gap="xs">
    <Title order={5}>1 · From</Title>
    <EndPicker label="From end" value={value.from_revision_id} onChange={(id) => onChange({ ...value, from_revision_id: id, rows: [] })} definitions={definitions} />
    {from.data && <EndLine end={from.data} />}
    <Title order={5}>2 · To</Title>
    <EndPicker label="To end" value={value.to_revision_id} onChange={(id) => onChange({ ...value, to_revision_id: id, rows: [] })} definitions={definitions} />
    {to.data && <EndLine end={to.data} />}
    {(from.isError || to.isError) && <Alert color="red">{(from.error ?? to.error)?.message}</Alert>}
    <Title order={5}>3 · Signals</Title>
    <Group gap="xs">
      <Button size="xs" variant="default" disabled={!value.from_revision_id || !value.to_revision_id} loading={proposal.isPending} onClick={() => proposal.mutate()}>{value.rows.length ? "Propose rows again" : "Propose rows from the two ends"}</Button>
      {value.rows.length > 0 && <Text size="xs" c="dimmed">Pins are paired only by the same signal; everything else is a question for you.</Text>}
    </Group>
    {proposal.isError && <Alert color="red">{proposal.error.message}</Alert>}
    {open > 0 && <Alert color="yellow" title={`${open} open question${open === 1 ? "" : "s"}`}>Answer each question below before reviewing or freezing the intent. A draft can be saved with questions open.</Alert>}
    {value.rows.length > 0 && <RowsEditor rows={value.rows} onChange={(rows) => onChange({ ...value, rows })} from={from.data} to={to.data} />}
    <Group align="end" gap="xs" wrap="wrap">
      <Select size="xs" label="Isolation" data={ISOLATION} value={value.isolation} onChange={(v) => onChange({ ...value, isolation: (v ?? "unknown") as CableIntent["isolation"] })} />
      <Select size="xs" label="Overall shield" data={SHIELD} value={value.shield.policy} onChange={(v) => onChange({ ...value, shield: { ...value.shield, policy: (v ?? "unknown") as CableIntent["shield"]["policy"] } })} />
      <TextInput size="xs" label="Shield basis" placeholder="Required when known" value={value.shield.basis ?? ""} onChange={(e) => onChange({ ...value, shield: { ...value.shield, basis: e.currentTarget.value || null } })} />
    </Group>
    <Group align="end" gap="xs" wrap="wrap">
      <TextInput size="xs" label="Description" placeholder="Optional" value={value.description ?? ""} onChange={(e) => onChange({ ...value, description: e.currentTarget.value || null })} />
      <Select size="xs" label="Review" data={[{ value: "unreviewed", label: "Unreviewed" }, { value: "reviewed", label: "Reviewed" }]} value={value.review} onChange={(v) => onChange({ ...value, review: (v ?? "unreviewed") as CableIntent["review"] })} />
      <TextInput size="xs" label="Review basis" placeholder="Required when reviewed" value={value.review_basis ?? ""} onChange={(e) => onChange({ ...value, review_basis: e.currentTarget.value || null })} />
    </Group>
  </Stack>;
}

function EndLine({ end }: { end: CableEnd }) {
  return <Text size="xs" c="dimmed">{end.kind === "port" ? `Device ${end.device_label ?? "unknown"}` : "Pinout variant"} · {end.variant_label ?? "variant unnamed"} · role {end.role} · {end.rows.length} contacts</Text>;
}

function RowsEditor({ rows, onChange, from, to }: { rows: IntentRow[]; onChange: (rows: IntentRow[]) => void; from?: CableEnd; to?: CableEnd }) {
  const fromRows = new Map((from?.rows ?? []).map((r) => [r.contact_id, r] as const));
  const toRows = new Map((to?.rows ?? []).map((r) => [r.contact_id, r] as const));
  const set = (id: string, patch: Partial<IntentRow>) => onChange(rows.map((r) => (r.row_id === id ? { ...r, ...patch } : r)));
  return <Table.ScrollContainer minWidth={980}><Table verticalSpacing={4} aria-label="Intent rows" className="sb-intent-table">
    <Table.Thead><Table.Tr><Table.Th>From</Table.Th><Table.Th>To</Table.Th><Table.Th>Signal</Table.Th><Table.Th>Requirement</Table.Th><Table.Th>Conductor</Table.Th><Table.Th>Return</Table.Th><Table.Th>Parts to add</Table.Th><Table.Th>Basis</Table.Th></Table.Tr></Table.Thead>
    <Table.Tbody>{rows.map((row) => {
      const source = row.from_contact_id ? fromRows.get(row.from_contact_id) : undefined;
      const signal = source?.signal ?? (row.to_contact_ids[0] ? toRows.get(row.to_contact_ids[0])?.signal : undefined);
      return <Table.Tr key={row.row_id} data-question={row.question ? true : undefined}>
        <Table.Td className="sb-mono">{row.from_contact_id ? contactText(source, row.from_contact_id) : <Text size="xs" c="dimmed">none</Text>}</Table.Td>
        <Table.Td>{row.question ? <QuestionCell row={row} onAnswer={(ids) => set(row.row_id, { to_contact_ids: ids, question: null, pairing: "answered", basis: row.basis ?? "Answered in the intent editor" })} />
          : row.to_contact_ids.length ? <span className="sb-mono">{row.to_contact_ids.map((c) => contactText(toRows.get(c), c)).join(", ")}</span>
          : <Text size="xs" c="dimmed">none</Text>}</Table.Td>
        <Table.Td>{signal ? <Group gap={4} wrap="nowrap"><span>{signal.name}</span><SignalTypeChip type={signal.type} /></Group> : <SbUnknown what="Signal" />}</Table.Td>
        <Table.Td><Select size="xs" aria-label={`Requirement of row ${row.row_id}`} value={row.requirement} data={Object.entries(REQUIREMENT_LABELS).map(([value, label]) => ({ value, label }))} onChange={(v) => set(row.row_id, { requirement: (v ?? "required") as Requirement })} /></Table.Td>
        <Table.Td>{conductorText(row.conductor) ?? <SbUnknown what="Conductor" />}</Table.Td>
        <Table.Td>{row.return_policy === "unknown" ? <SbUnknown what="Return" /> : RETURN_LABELS[row.return_policy]}</Table.Td>
        <Table.Td>{row.required_parts.length ? row.required_parts.map((p, i) => <Text key={i} size="xs">{CONDITIONING_LABELS[p.conditioning]}{p.value ? ` ${p.value}` : ""}</Text>) : <Text size="xs" c="dimmed">none declared</Text>}</Table.Td>
        <Table.Td><TextInput size="xs" aria-label={`Basis of row ${row.row_id}`} placeholder={row.requirement === "must_not_connect" ? "Reason required" : "optional"} value={row.basis ?? ""} onChange={(e) => set(row.row_id, { basis: e.currentTarget.value || null })} /></Table.Td>
      </Table.Tr>;
    })}</Table.Tbody>
  </Table></Table.ScrollContainer>;
}

function QuestionCell({ row, onAnswer }: { row: IntentRow; onAnswer: (ids: string[]) => void }) {
  const [chosen, setChosen] = useState<string[]>([]);
  const question = row.question!;
  return <Stack gap={4} maw={320}>
    <SbStatus led="review" dimension="question" value={question.kind === "several_destinations" ? "which contact" : question.kind === "name_and_type_only" ? "name match only" : "depends on condition"} />
    <Text size="xs">{question.text}</Text>
    {question.options.length > 0 && <MultiSelect size="xs" aria-label={`Answer for row ${row.row_id}`} placeholder="Choose contacts" data={question.options.map((o) => ({ value: o.contact_id, label: o.label }))} value={chosen} onChange={setChosen} />}
    {question.options.length === 0 && <Text size="xs" c="dimmed">No destination contact is offered: set the requirement, then answer with none.</Text>}
    <Button size="compact-xs" variant="default" w="fit-content" disabled={question.options.length > 0 && chosen.length === 0} onClick={() => onAnswer(chosen)}>Answer</Button>
  </Stack>;
}

/** A frozen intent read back by labels, with the later check shown as not evaluated. */
export function IntentInspector({ revisionId }: { revisionId: string }) {
  const result = useQuery({ queryKey: ["intent-inspection", revisionId], queryFn: () => read<IntentInspection>(`interfaces/revisions/${revisionId}`) });
  const data = result.data;
  return <Card withBorder><Stack gap="xs">
    <Title order={3}>Frozen cable intent</Title>
    {result.isError && <Alert color="red">{result.error.message}</Alert>}
    {data && <>
      <Text size="sm">From <b>{data.intent.from.name}</b> r{data.intent.from.revision_number} ({data.intent.from.kind === "port" ? data.intent.from.device_label : "pinout variant"}) to <b>{data.intent.to.name}</b> r{data.intent.to.revision_number} ({data.intent.to.kind === "port" ? data.intent.to.device_label : "pinout variant"})</Text>
      {data.interface.description && <Text size="sm">{data.interface.description}</Text>}
      <Group gap="xs"><SbStatus led="not-evaluated" dimension="cable check" value="not evaluated" /><Text size="xs" c="dimmed">{data.intent.check.reason}</Text></Group>
      <Table.ScrollContainer minWidth={820}><Table verticalSpacing={2} aria-label="Intent rows" className="sb-intent-table">
        <Table.Thead><Table.Tr><Table.Th>From</Table.Th><Table.Th>To</Table.Th><Table.Th>Signal</Table.Th><Table.Th>Requirement</Table.Th><Table.Th>Conductor</Table.Th><Table.Th>Return</Table.Th><Table.Th>Parts to add</Table.Th><Table.Th>Basis</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{data.intent.rows.map((row) => <Table.Tr key={row.row_id}>
          <Table.Td className="sb-mono">{row.from_label ?? "none"}</Table.Td><Table.Td className="sb-mono">{row.to_labels.join(", ") || "none"}</Table.Td>
          <Table.Td>{row.signal ? <Group gap={4} wrap="nowrap"><span>{row.signal.name}</span><SignalTypeChip type={row.signal.type} /></Group> : <SbUnknown what="Signal" />}</Table.Td>
          <Table.Td>{row.requirement === "must_not_connect" ? <Badge color="red" variant="light">Must not connect</Badge> : REQUIREMENT_LABELS[row.requirement]}</Table.Td>
          <Table.Td>{conductorText(row.conductor) ?? <SbUnknown what="Conductor" />}</Table.Td>
          <Table.Td>{row.return_policy === "unknown" ? <SbUnknown what="Return" /> : RETURN_LABELS[row.return_policy]}</Table.Td>
          <Table.Td>{row.required_parts.map((p, i) => <Text key={i} size="xs">{CONDITIONING_LABELS[p.conditioning]}{p.value ? ` ${p.value}` : ""}</Text>)}</Table.Td>
          <Table.Td><Text size="xs">{row.basis ?? "—"}</Text></Table.Td>
        </Table.Tr>)}</Table.Tbody>
      </Table></Table.ScrollContainer>
      <Text size="xs">Isolation: {ISOLATION.find((i) => i.value === data.interface.isolation)?.label}. Shield: {SHIELD.find((s) => s.value === data.interface.shield.policy)?.label}. Review: {data.interface.review}.</Text>
    </>}
  </Stack></Card>;
}

/** New intent: name it, then steps 1-3. ``onFrozen`` hands the frozen revision on (for a new cable). */
export function NewIntent({ projectId, definitions, onFrozen, title = "New cable intent" }: { projectId: string | null; definitions: Definition[]; onFrozen?: (revisionId: string) => void; title?: string }) {
  const cache = useQueryClient();
  const createGate = usePermission("item.create");
  const freezeGate = usePermission("design.freeze");
  const [name, setName] = useState("");
  const [value, setValue] = useState<CableIntent>(emptyIntent);
  const [draft, setDraft] = useState<IntentDraft | null>(null);
  const [frozen, setFrozen] = useState<string | null>(null);
  const create = useMutation({ mutationFn: () => command<IntentDraft>("interface.create", { name, interface: value }), onSuccess: async (data) => {
    setDraft(data);
    await referenceFromProject(projectId, data.definition_id, "cable_intent");
    await cache.invalidateQueries({ queryKey: ["intent-definitions"] });
  } });
  const save = useMutation({ mutationFn: () => command<IntentDraft>("interface.update", { draft_id: draft!.draft_id, interface: value }, draft!.state), onSuccess: setDraft });
  const freeze = useMutation({ mutationFn: () => command<{ revision_id: string }>("interface.freeze", { draft_id: draft!.draft_id }, draft!.state), onSuccess: (data) => { setFrozen(data.revision_id); onFrozen?.(data.revision_id); } });
  const open = value.rows.filter((r) => r.question).length;
  return <Card withBorder><Stack gap="xs">
    <Title order={3}>{title}</Title>
    <InspectionScope permission="item.create">
      <TextInput label="Intent name" placeholder="e.g. Console to monitor RGB" value={name} onChange={(e) => setName(e.currentTarget.value)} />
      <IntentEditor value={value} onChange={setValue} definitions={definitions} />
    </InspectionScope>
    <Group gap="xs">
      {!draft && <Button disabled={!name.trim() || !value.from_revision_id || !value.to_revision_id} loading={create.isPending} onClick={() => create.mutate()} {...createGate.props}>Save intent draft</Button>}
      {draft && <Button variant="default" loading={save.isPending} onClick={() => save.mutate()} {...createGate.props}>Save changes</Button>}
      {draft && <Button disabled={open > 0 || !!frozen} loading={freeze.isPending} onClick={() => freeze.mutate()} {...freezeGate.props}>Freeze intent</Button>}
      <ReadOnlyNote permission="item.create">Creating intents is unavailable.</ReadOnlyNote>
    </Group>
    {draft && open > 0 && <Text size="xs" c="dimmed">Saved as a draft; freezing waits for the open questions.</Text>}
    {draft && !frozen && (save.isSuccess || create.isSuccess) && <Text size="xs" role="status">Draft saved ({draft.state}).</Text>}
    {frozen && <Text size="sm" role="status">Intent frozen.</Text>}
    {[create, save, freeze].map((m, i) => m.isError ? <Alert key={i} color="red">{m.error.message}</Alert> : null)}
  </Stack></Card>;
}

/** Intents lens: what a cable must connect between two ends, row by row. */
export function IntentPanel({ projectId }: { projectId: string | null }) {
  return <Intents key={projectId ?? "library"} projectId={projectId} />;
}

function Intents({ projectId }: { projectId: string | null }) {
  const cache = useQueryClient();
  const freezeGate = usePermission("design.freeze");
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const definitions = useQuery({ queryKey: ["intent-definitions", projectId], queryFn: () => read<Definition[]>("workspace/definitions") });
  const identity = useQuery({ queryKey: ["intent-identity", definitionId], queryFn: () => read<Identity>(`catalog/definitions/${definitionId}`), enabled: !!definitionId });
  const draft = useQuery({ queryKey: ["intent-draft", draftId], queryFn: () => read<IntentDraft>(`interfaces/drafts/${draftId}`), enabled: !!draftId });
  const pick = (id: string | null) => { setDefinitionId(id); setDraftId(null); setRevisionId(null); };
  const openNewest = useOpenNewest(identity.data, setDraftId, setRevisionId);
  useOpenProbed(definitionIn(definitions.data, ["cable_intent"]), (id) => { pick(id); openNewest(id); });
  const freeze = useMutation({ mutationFn: () => command<{ revision_id: string }>("interface.freeze", { draft_id: draftId }, draft.data?.state), onSuccess: async (data) => {
    setRevisionId(data.revision_id);
    await cache.invalidateQueries({ queryKey: ["intent-draft", draftId] });
    await cache.invalidateQueries({ queryKey: ["intent-identity", definitionId] });
  } });
  const all = definitions.data ?? [];
  const intents = all.filter((d) => d.kind === "cable_intent");
  const openQuestions = draft.data?.content.interface?.rows.filter((r) => r.question).length ?? 0;
  return <Stack>
    <Title order={2}>Cable intents</Title>
    <Text size="sm">What a cable must connect, signal by signal, between two ends: a device port or a pinout variant at each end. Rows are proposed only where both ends declare the same signal; anything else is a question for you. Must-not-connect rows record pins that must stay unconnected. Checking a cable against an intent comes later; it is never assumed to pass.</Text>
    {definitions.isError && <Alert color="red">{definitions.error.message}</Alert>}
    <Group align="end">
      <Select label="Cable intent" searchable placeholder={intents.length ? "Choose an intent" : "No intents yet"} data={intents.map((d) => ({ value: d.definition_id, label: d.name }))} value={definitionId} onChange={pick} />
      {identity.data && <Select label="Frozen revision" value={revisionId} onChange={setRevisionId} data={identity.data.revisions.map((r) => ({ value: r.revision_id, label: revisionOptionLabel(identity.data.name, r.number) }))} />}
      {identity.data && identity.data.drafts.length > 0 && <Select label="Draft" value={draftId} onChange={setDraftId} data={identity.data.drafts.map((d, i) => ({ value: d.draft_id, label: `Draft ${i + 1}` }))} />}
      {identity.data && <ContinueDraftButton drafts={identity.data.drafts} revisionId={revisionId} draftId={draftId} onOpen={setDraftId} />}
    </Group>
    {identity.isError && <Alert color="red">{identity.error.message}</Alert>}
    {revisionId && <IntentInspector key={revisionId} revisionId={revisionId} />}
    {draft.isError && <Alert color="red">{draft.error.message}</Alert>}
    {draft.data && <><DraftEditor key={`${draft.data.draft_id}:${draft.data.state}`} draft={draft.data} definitions={all} onSaved={async () => { await cache.invalidateQueries({ queryKey: ["intent-draft", draftId] }); }} />
      <Group><Button loading={freeze.isPending} disabled={!draft.data.content.interface || openQuestions > 0} onClick={() => freeze.mutate()} {...freezeGate.props}>Freeze intent</Button>
        {openQuestions > 0 && <Text size="xs" c="dimmed">{openQuestions} open questions</Text>}<ReadOnlyNote permission="design.freeze">Freezing intents is unavailable.</ReadOnlyNote></Group></>}
    {freeze.isError && <Alert color="red">{freeze.error.message}</Alert>}
    <NewIntent projectId={projectId} definitions={all} />
  </Stack>;
}

function DraftEditor({ draft, definitions, onSaved }: { draft: IntentDraft; definitions: Definition[]; onSaved: () => Promise<void> }) {
  const editGate = usePermission("design.edit");
  const [value, setValue] = useState<CableIntent>(() => draft.content.interface ?? emptyIntent());
  const save = useMutation({ mutationFn: () => command("interface.update", { draft_id: draft.draft_id, interface: value }, draft.state), onSuccess: onSaved });
  return <Card withBorder><Stack gap="xs"><Title order={3}>Edit intent draft</Title>
    <InspectionScope permission="design.edit"><IntentEditor value={value} onChange={setValue} definitions={definitions} /></InspectionScope>
    <Group><Button loading={save.isPending} onClick={() => save.mutate()} {...editGate.props}>Save intent draft</Button><ReadOnlyNote permission="design.edit">Saving intents is unavailable.</ReadOnlyNote></Group>
    {save.isError && <Alert color="red">{save.error.message}</Alert>}
  </Stack></Card>;
}

