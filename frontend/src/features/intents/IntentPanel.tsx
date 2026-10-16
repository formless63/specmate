import { Alert, Badge, Button, Card, Group, MultiSelect, SegmentedControl, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { SbStatus, SbUnknown } from "../../components/sb";
import { InspectionScope, ReadOnlyNote, useCan, usePermission, type PermissionName } from "../../lib/permissions";
import { revisionOptionLabel, useRevisionLabel, newestFirst } from "../../lib/revision-labels";
import { RevisionPicker } from "../cables/RevisionPicker";
import type { CableEnd } from "../interfaces/api";
import { SignalTypeChip } from "../interfaces/SignalSetPanel";
import { definitionIn, referenceFromProject, useOpenNewest, useOpenProbed } from "../scope/openProbed";
import { ContinueDraftButton } from "../scope/ContinueDraftButton";
import {
  CONDITIONING_LABELS, REQUIREMENT_LABELS, RETURN_LABELS, command, conductorText, contactText, emptyIntent, proposalPath, read,
  type CableIntent, type Definition, type Identity, type IntentDraft, type IntentInspection, type IntentRow, type Proposal, type Requirement,
} from "./api";
import { IntentWiring, QuestionCard, type Selection } from "./IntentWiring";
import { layoutWiring, rowSignal, type Wiring } from "./wiring-model";
import "./intent-visual.css";

const ISOLATION = [{ value: "unknown", label: "unknown" }, { value: "no_unlisted_connections", label: "No connection beyond these rows" }, { value: "unlisted_allowed", label: "Other connections allowed" }];
const SHIELD = [{ value: "unknown", label: "unknown" }, { value: "bond_from", label: "Bond at the from end" }, { value: "bond_to", label: "Bond at the to end" }, { value: "bond_both", label: "Bond at both ends" }, { value: "isolated", label: "Isolated" }];
const ANSWERED_BASIS = "Answered in the intent editor";

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

/** The answer to a question is an ordinary row edit: destinations chosen, question cleared, basis kept. */
export function answerRow(row: IntentRow, ids: string[]): IntentRow {
  return { ...row, to_contact_ids: ids, question: null, pairing: "answered", basis: row.basis ?? ANSWERED_BASIS };
}

const openCount = (rows: IntentRow[]) => rows.filter((r) => r.question).length;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Steps 1-3: from end, to end, then the proposed signals drawn between the two faces. */
export function IntentEditor({ value, onChange, definitions, permission = "design.edit" }: { value: CableIntent; onChange: (v: CableIntent) => void; definitions: Definition[]; permission?: PermissionName }) {
  const from = useEnd(value.from_revision_id);
  const to = useEnd(value.to_revision_id);
  const gate = usePermission(permission);
  const proposal = useMutation({ mutationFn: () => read<Proposal>(proposalPath(value.from_revision_id, value.to_revision_id)), onSuccess: (data) => onChange({ ...value, rows: data.rows }) });
  return <Stack gap="xs">
    <div className="ibv-ends">
      <Group grow align="flex-start" wrap="wrap" gap="md">
        <Stack gap={4} miw={240}><Title order={5}>1 · From</Title>
          <EndPicker label="From end" value={value.from_revision_id} onChange={(id) => onChange({ ...value, from_revision_id: id, rows: [] })} definitions={definitions} /></Stack>
        <Stack gap={4} miw={240}><Title order={5}>2 · To</Title>
          <EndPicker label="To end" value={value.to_revision_id} onChange={(id) => onChange({ ...value, to_revision_id: id, rows: [] })} definitions={definitions} /></Stack>
      </Group>
    </div>
    {(from.isError || to.isError) && <Alert color="red">{(from.error ?? to.error)?.message}</Alert>}
    <Group gap="xs">
      <Title order={5}>3 · Signals</Title>
      <Button size="xs" variant="default" disabled={!value.from_revision_id || !value.to_revision_id} loading={proposal.isPending} onClick={() => proposal.mutate()} {...gate.props}>{value.rows.length ? "Propose rows again" : "Propose rows from the two ends"}</Button>
      {value.rows.length > 0 && <Text size="xs" c="dimmed">Pins are paired only by the same signal; everything else is a question for you.</Text>}
    </Group>
    {proposal.isError && <Alert color="red">{proposal.error.message}</Alert>}
    {(value.rows.length > 0 || (from.data && to.data)) && <IntentBench value={value} onChange={gate.allowed ? onChange : undefined} lockedReason={gate.reason} from={from.data} to={to.data} />}
  </Stack>;
}

/** Review known exact ends inside a recipe without repeating their pickers. */
export function IntentReview({ value, onChange }: { value: CableIntent; onChange?: (value: CableIntent) => void }) {
  const from = useEnd(value.from_revision_id), to = useEnd(value.to_revision_id);
  if (from.isError || to.isError) return <Alert color="red">Connection requirements are unavailable.</Alert>;
  if (!from.data || !to.data) return <Text role="status">Reading exact device ports…</Text>;
  return <IntentBench value={value} onChange={onChange} from={from.data} to={to.data} />;
}

/** Discrete meter cells over the drawing: rows, open questions (freeze gate), must-not-connect. */
function MeterCells({ wiring, rows, extra }: { wiring: Wiring; rows: IntentRow[]; extra?: ReactNode }) {
  const answered = rows.filter((r) => r.pairing === "answered").length;
  const open = wiring.open;
  return <dl className="ibv-cells">
    <div className="sb-cell"><dt className="sb-silk">Rows</dt><dd>{rows.length}</dd><p className="ibv-sub">{wiring.signals} signals · {wiring.returns} returns · {wiring.mustNotConnect} must not connect</p></div>
    <div className="sb-cell ibv-cell-open" data-open={open > 0}><dt className="sb-silk">Open questions</dt><dd>{open === 0 ? "none open" : plural(open, "open question")}</dd>
      <div className="ibv-ticks" aria-hidden="true">{Array.from({ length: open }, (_, i) => <span key={`o${i}`} className="ibv-tick" data-open />)}{Array.from({ length: answered }, (_, i) => <span key={`a${i}`} className="ibv-tick" data-answered />)}</div>
      <p className="ibv-sub">{open ? "freeze blocked" : "ready to review"}</p></div>
    <div className="sb-cell"><dt className="sb-silk">Must not connect</dt><dd>{wiring.mustNotConnect}</dd><p className="ibv-sub">{rows.filter((r) => r.requirement === "must_not_connect").map((r) => r.basis).filter(Boolean)[0] ?? "red crossed stubs"}</p></div>
    {extra}
  </dl>;
}

/**
 * The intent bench: meter cells, the wiring drawing and a side inspector. Without ``onChange``
 * it is an inspection view: questions show but cannot be answered and no field is editable.
 */
function IntentBench({ value, onChange, from, to, lockedReason, cells }: { value: CableIntent; onChange?: (v: CableIntent) => void; from?: CableEnd; to?: CableEnd; lockedReason?: string; cells?: ReactNode }) {
  const compact = useMediaQuery("(max-width: 899px)", false, { getInitialValueInEffect: false });
  const [selection, setSelection] = useState<Selection>(null);
  const wiring = useMemo(() => layoutWiring(value.rows, from, to), [value.rows, from, to]);
  const setRow = (id: string, patch: Partial<IntentRow>) => onChange?.({ ...value, rows: value.rows.map((r) => (r.row_id === id ? { ...r, ...patch } : r)) });
  const answer = onChange ? (rowId: string, ids: string[]) => onChange({ ...value, rows: value.rows.map((r) => (r.row_id === rowId ? answerRow(r, ids) : r)) }) : undefined;
  return <Stack gap="xs">
    <MeterCells wiring={wiring} rows={value.rows} extra={cells} />
    <div className="ibv-bench">
      <div className="ibv-stage"><div className="ibv-viewport">
        <IntentWiring wiring={wiring} rows={value.rows} from={from} to={to} fromCaption={`From${from ? ` · ${from.role}` : ""}`} toCaption={`To${to ? ` · ${to.role}` : ""}`}
          selection={selection} onSelect={setSelection} compact={compact} onAnswer={answer} lockedReason={lockedReason} />
      </div></div>
      <aside className="ibv-inspector" aria-label="Intent inspector">
        <SelectionInspector selection={selection} value={value} wiring={wiring} from={from} to={to} onSelect={setSelection} setRow={onChange ? setRow : undefined} onAnswer={answer} lockedReason={lockedReason} />
        {compact && wiring.open > 0 && <Stack gap={6}><Text className="sb-silk">Open questions</Text>
          {value.rows.filter((r) => r.question).map((r) => <QuestionCard key={r.row_id} row={r} source={sourceOf(r, from)} lockedReason={lockedReason} onAnswer={answer ? (ids) => answer(r.row_id, ids) : undefined} />)}</Stack>}
        {onChange ? <IntentSettings value={value} onChange={onChange} /> : <Text size="xs">Isolation: {ISOLATION.find((i) => i.value === value.isolation)?.label}. Shield: {SHIELD.find((s) => s.value === value.shield.policy)?.label}. Review: {value.review}.</Text>}
      </aside>
    </div>
    <details className="ibv-table-fallback">
      <summary className="sb-silk">Rows table</summary>
      {onChange ? <RowsEditor rows={value.rows} onChange={(rows) => onChange({ ...value, rows })} from={from} to={to} /> : <FrozenRows rows={value.rows} from={from} to={to} />}
    </details>
  </Stack>;
}

function sourceOf(row: IntentRow, from?: CableEnd): string {
  if (!row.from_contact_id) return "no source pin";
  return `from ${contactText(from?.rows.find((r) => r.contact_id === row.from_contact_id), row.from_contact_id)}`;
}

function SelectionInspector({ selection, value, wiring, from, to, onSelect, setRow, onAnswer, lockedReason }: {
  selection: Selection; value: CableIntent; wiring: Wiring; from?: CableEnd; to?: CableEnd; onSelect: (s: Selection) => void;
  setRow?: (id: string, patch: Partial<IntentRow>) => void; onAnswer?: (rowId: string, ids: string[]) => void; lockedReason?: string;
}) {
  if (!selection) return <Text size="xs" c="dimmed">Select a line, a pin or a question to inspect it. {wiring.open > 0 ? "Answer every question to unlock freezing." : ""}</Text>;
  if (!("rowId" in selection)) {
    const end = selection.side === "a" ? from : to;
    const pin = end?.rows.find((r) => r.contact_id === selection.contactId);
    const rows = value.rows.filter((r) => (selection.side === "a" ? r.from_contact_id === selection.contactId : r.to_contact_ids.includes(selection.contactId) || r.question?.options.some((o) => o.contact_id === selection.contactId)));
    return <Stack gap={6}>
      <Title order={4}>{selection.side === "a" ? "From" : "To"} pin {contactText(pin, selection.contactId)}</Title>
      <dl className="ibv-kv">
        <dt>Signal</dt><dd>{pin?.signal ? <Group gap={4} wrap="nowrap"><span>{pin.signal.name}</span><SignalTypeChip type={pin.signal.type} /></Group> : <SbUnknown what="Signal" />}</dd>
        {pin?.device?.must_not_connect && <><dt>Device</dt><dd>Must not connect{pin.device.must_not_connect_reason ? `: ${pin.device.must_not_connect_reason}` : ""}</dd></>}
      </dl>
      {rows.length === 0 ? <Text size="xs" c="dimmed">No intent row names this pin.</Text>
        : rows.map((r) => <Button key={r.row_id} size="compact-xs" variant="subtle" justify="flex-start" onClick={() => onSelect({ rowId: r.row_id })}>Row {r.row_id}{r.question ? " (open question)" : ""}</Button>)}
    </Stack>;
  }
  const row = value.rows.find((r) => r.row_id === selection.rowId);
  if (!row) return null;
  const fromRows = new Map((from?.rows ?? []).map((r) => [r.contact_id, r] as const));
  const toRows = new Map((to?.rows ?? []).map((r) => [r.contact_id, r] as const));
  const signal = rowSignal(row, new Map(wiring.a.map((p) => [p.contactId, p])), new Map(wiring.b.map((p) => [p.contactId, p])));
  return <Stack gap={6}>
    <Title order={4}>{signal?.name ?? `Row ${row.row_id}`}</Title>
    <dl className="ibv-kv">
      <dt>From</dt><dd className="sb-mono">{row.from_contact_id ? contactText(fromRows.get(row.from_contact_id), row.from_contact_id) : "none"}</dd>
      <dt>To</dt><dd className="sb-mono">{row.question ? "open question" : row.to_contact_ids.length ? row.to_contact_ids.map((c) => contactText(toRows.get(c), c)).join(", ") : "none"}</dd>
      <dt>Signal</dt><dd>{signal ? <SignalTypeChip type={signal.type} /> : <SbUnknown what="Signal" />}</dd>
      <dt>Conductor</dt><dd>{conductorText(row.conductor) ?? <SbUnknown what="Conductor" />}</dd>
      <dt>Return</dt><dd>{row.return_policy === "unknown" ? <SbUnknown what="Return" /> : RETURN_LABELS[row.return_policy]}</dd>
      <dt>Parts</dt><dd>{row.required_parts.length ? row.required_parts.map((p) => `${CONDITIONING_LABELS[p.conditioning]}${p.value ? ` ${p.value}` : ""}`).join(", ") : "none declared"}</dd>
      <dt>Pairing</dt><dd>{row.pairing.replace("_", " ")}</dd>
    </dl>
    {row.question && <QuestionCard row={row} source={sourceOf(row, from)} lockedReason={lockedReason} onAnswer={onAnswer ? (ids) => onAnswer(row.row_id, ids) : undefined} />}
    {setRow ? <>
      <Select size="xs" label="Requirement" aria-label={`Requirement of row ${row.row_id}`} value={row.requirement} data={Object.entries(REQUIREMENT_LABELS).map(([v, label]) => ({ value: v, label }))} onChange={(v) => setRow(row.row_id, { requirement: (v ?? "required") as Requirement })} />
      <TextInput size="xs" label="Basis" aria-label={`Basis of row ${row.row_id}`} placeholder={row.requirement === "must_not_connect" ? "Reason required" : "optional"} value={row.basis ?? ""} onChange={(e) => setRow(row.row_id, { basis: e.currentTarget.value || null })} />
    </> : <dl className="ibv-kv"><dt>Requirement</dt><dd>{REQUIREMENT_LABELS[row.requirement]}</dd><dt>Basis</dt><dd>{row.basis ?? "—"}</dd></dl>}
  </Stack>;
}

function IntentSettings({ value, onChange }: { value: CableIntent; onChange: (v: CableIntent) => void }) {
  return <Stack gap={4}>
    <Text className="sb-silk">Whole cable</Text>
    <Select size="xs" label="Isolation" data={ISOLATION} value={value.isolation} onChange={(v) => onChange({ ...value, isolation: (v ?? "unknown") as CableIntent["isolation"] })} />
    <Select size="xs" label="Overall shield" data={SHIELD} value={value.shield.policy} onChange={(v) => onChange({ ...value, shield: { ...value.shield, policy: (v ?? "unknown") as CableIntent["shield"]["policy"] } })} />
    <TextInput size="xs" label="Shield basis" placeholder="Required when known" value={value.shield.basis ?? ""} onChange={(e) => onChange({ ...value, shield: { ...value.shield, basis: e.currentTarget.value || null } })} />
    <TextInput size="xs" label="Description" placeholder="Optional" value={value.description ?? ""} onChange={(e) => onChange({ ...value, description: e.currentTarget.value || null })} />
    <Select size="xs" label="Review" data={[{ value: "unreviewed", label: "Unreviewed" }, { value: "reviewed", label: "Reviewed" }]} value={value.review} onChange={(v) => onChange({ ...value, review: (v ?? "unreviewed") as CableIntent["review"] })} />
    <TextInput size="xs" label="Review basis" placeholder="Required when reviewed" value={value.review_basis ?? ""} onChange={(e) => onChange({ ...value, review_basis: e.currentTarget.value || null })} />
  </Stack>;
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
        <Table.Td>{row.question ? <QuestionCell row={row} onAnswer={(ids) => set(row.row_id, answerRow(row, ids))} />
          : row.to_contact_ids.length ? <span className="sb-mono">{row.to_contact_ids.map((c) => contactText(toRows.get(c), c)).join(", ")}</span>
          : <Text size="xs" c="dimmed">none</Text>}</Table.Td>
        <Table.Td>{signal ? <Group gap={4} wrap="nowrap"><span>{signal.name}</span><SignalTypeChip type={signal.type} /></Group> : <SbUnknown what="Signal" />}</Table.Td>
        <Table.Td><Select size="xs" aria-label={`Requirement in table of row ${row.row_id}`} value={row.requirement} data={Object.entries(REQUIREMENT_LABELS).map(([value, label]) => ({ value, label }))} onChange={(v) => set(row.row_id, { requirement: (v ?? "required") as Requirement })} /></Table.Td>
        <Table.Td>{conductorText(row.conductor) ?? <SbUnknown what="Conductor" />}</Table.Td>
        <Table.Td>{row.return_policy === "unknown" ? <SbUnknown what="Return" /> : RETURN_LABELS[row.return_policy]}</Table.Td>
        <Table.Td>{row.required_parts.length ? row.required_parts.map((p, i) => <Text key={i} size="xs">{CONDITIONING_LABELS[p.conditioning]}{p.value ? ` ${p.value}` : ""}</Text>) : <Text size="xs" c="dimmed">none declared</Text>}</Table.Td>
        <Table.Td><TextInput size="xs" aria-label={`Basis in table of row ${row.row_id}`} placeholder={row.requirement === "must_not_connect" ? "Reason required" : "optional"} value={row.basis ?? ""} onChange={(e) => set(row.row_id, { basis: e.currentTarget.value || null })} /></Table.Td>
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

/** The frozen read-only table, labeled by the server. */
function FrozenRows({ rows, from, to }: { rows: IntentRow[]; from?: CableEnd; to?: CableEnd }) {
  const fromRows = new Map((from?.rows ?? []).map((r) => [r.contact_id, r] as const));
  const toRows = new Map((to?.rows ?? []).map((r) => [r.contact_id, r] as const));
  return <Table.ScrollContainer minWidth={820}><Table verticalSpacing={2} aria-label="Intent rows" className="sb-intent-table">
    <Table.Thead><Table.Tr><Table.Th>From</Table.Th><Table.Th>To</Table.Th><Table.Th>Signal</Table.Th><Table.Th>Requirement</Table.Th><Table.Th>Conductor</Table.Th><Table.Th>Return</Table.Th><Table.Th>Parts to add</Table.Th><Table.Th>Basis</Table.Th></Table.Tr></Table.Thead>
    <Table.Tbody>{rows.map((row) => {
      const source = row.from_contact_id ? fromRows.get(row.from_contact_id) : undefined;
      const signal = source?.signal ?? (row.to_contact_ids[0] ? toRows.get(row.to_contact_ids[0])?.signal : undefined);
      return <Table.Tr key={row.row_id}>
        <Table.Td className="sb-mono">{row.from_contact_id ? contactText(source, row.from_contact_id) : "none"}</Table.Td>
        <Table.Td className="sb-mono">{row.to_contact_ids.map((c) => contactText(toRows.get(c), c)).join(", ") || "none"}</Table.Td>
        <Table.Td>{signal ? <Group gap={4} wrap="nowrap"><span>{signal.name}</span><SignalTypeChip type={signal.type} /></Group> : <SbUnknown what="Signal" />}</Table.Td>
        <Table.Td>{row.requirement === "must_not_connect" ? <Badge color="red" variant="light">Must not connect</Badge> : REQUIREMENT_LABELS[row.requirement]}</Table.Td>
        <Table.Td>{conductorText(row.conductor) ?? <SbUnknown what="Conductor" />}</Table.Td>
        <Table.Td>{row.return_policy === "unknown" ? <SbUnknown what="Return" /> : RETURN_LABELS[row.return_policy]}</Table.Td>
        <Table.Td>{row.required_parts.map((p, i) => <Text key={i} size="xs">{CONDITIONING_LABELS[p.conditioning]}{p.value ? ` ${p.value}` : ""}</Text>)}</Table.Td>
        <Table.Td><Text size="xs">{row.basis ?? "—"}</Text></Table.Td>
      </Table.Tr>;
    })}</Table.Tbody>
  </Table></Table.ScrollContainer>;
}

/** A frozen intent read back on the same drawing, with the later check shown as not evaluated. */
export function IntentInspector({ revisionId }: { revisionId: string }) {
  const result = useQuery({ queryKey: ["intent-inspection", revisionId], queryFn: () => read<IntentInspection>(`interfaces/revisions/${revisionId}`) });
  const data = result.data;
  const from = useEnd(data?.interface.from_revision_id ?? "");
  const to = useEnd(data?.interface.to_revision_id ?? "");
  return <Card withBorder><Stack gap="xs">
    <Title order={3}>Frozen cable intent</Title>
    {result.isError && <Alert color="red">{result.error.message}</Alert>}
    {data && <>
      <Text size="sm">From <b>{data.intent.from.name}</b> r{data.intent.from.revision_number} ({data.intent.from.kind === "port" ? data.intent.from.device_label : "pinout variant"}) to <b>{data.intent.to.name}</b> r{data.intent.to.revision_number} ({data.intent.to.kind === "port" ? data.intent.to.device_label : "pinout variant"})</Text>
      {data.interface.description && <Text size="sm">{data.interface.description}</Text>}
      <IntentBench value={data.interface} from={from.data} to={to.data}
        cells={<div className="sb-cell"><dt className="sb-silk">Cable check</dt><dd><SbStatus led="not-evaluated" dimension="cable check" value="not evaluated" /></dd><p className="ibv-sub" title={data.intent.check.reason}>{data.intent.check.reason}</p></div>} />
    </>}
  </Stack></Card>;
}

/** Freezing waits for every question to be answered and saved; the hint says which. */
function FreezeHint({ open, dirty }: { open: number; dirty: boolean }) {
  if (open > 0) return <Text className="ibv-freeze-hint">Answer {plural(open, "open question")} to unlock freezing. A draft can be saved with questions open.</Text>;
  if (dirty) return <Text className="ibv-freeze-hint">Save the answers to unlock freezing.</Text>;
  return null;
}

/** New intent: name it, then steps 1-3. ``onFrozen`` hands the frozen revision on (for a new cable). */
export function NewIntent({ projectId, definitions, onFrozen, title = "New cable intent" }: { projectId: string | null; definitions: Definition[]; onFrozen?: (revisionId: string) => void; title?: string }) {
  const cache = useQueryClient();
  const createGate = usePermission("item.create");
  const freezeGate = usePermission("design.freeze");
  const [name, setName] = useState("");
  const [value, setValue] = useState<CableIntent>(emptyIntent);
  const [draft, setDraft] = useState<IntentDraft | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [frozen, setFrozen] = useState<string | null>(null);
  const create = useMutation({ mutationFn: (sent: CableIntent) => command<IntentDraft>("interface.create", { name, interface: sent }), onSuccess: async (data, sent) => {
    setDraft(data); setSaved(JSON.stringify(sent));
    await referenceFromProject(projectId, data.definition_id, "cable_intent");
    await cache.invalidateQueries({ queryKey: ["intent-definitions"] });
  } });
  const save = useMutation({ mutationFn: (sent: CableIntent) => command<IntentDraft>("interface.update", { draft_id: draft!.draft_id, interface: sent }, draft!.state), onSuccess: (data, sent) => { setDraft(data); setSaved(JSON.stringify(sent)); } });
  const freeze = useMutation({ mutationFn: () => command<{ revision_id: string }>("interface.freeze", { draft_id: draft!.draft_id }, draft!.state), onSuccess: (data) => { setFrozen(data.revision_id); onFrozen?.(data.revision_id); } });
  const open = openCount(value.rows);
  const dirty = saved !== JSON.stringify(value);
  return <Card withBorder><Stack gap="xs">
    <Title order={3}>{title}</Title>
    <InspectionScope permission="item.create">
      <TextInput label="Intent name" placeholder="e.g. Console to monitor RGB" value={name} onChange={(e) => setName(e.currentTarget.value)} />
      <IntentEditor value={value} onChange={setValue} definitions={definitions} permission="item.create" />
    </InspectionScope>
    <Group gap="xs">
      {!draft && <Button disabled={!name.trim() || !value.from_revision_id || !value.to_revision_id} loading={create.isPending} onClick={() => create.mutate(value)} {...createGate.props}>Save intent draft</Button>}
      {draft && <Button variant="default" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate(value)} {...createGate.props}>Save changes</Button>}
      {draft && <Button disabled={open > 0 || dirty || !!frozen} loading={freeze.isPending} onClick={() => freeze.mutate()} {...freezeGate.props}>Freeze intent</Button>}
      {draft && !frozen && <FreezeHint open={open} dirty={dirty} />}
      <ReadOnlyNote permission="item.create">Creating intents is unavailable.</ReadOnlyNote>
    </Group>
    {draft && !frozen && !dirty && (save.isSuccess || create.isSuccess) && <Text size="xs" role="status">Draft saved ({draft.state}).</Text>}
    {frozen && <Text size="sm" role="status">Intent frozen.</Text>}
    {[create, save, freeze].map((m, i) => m.isError ? <Alert key={i} color="red">{m.error.message}</Alert> : null)}
  </Stack></Card>;
}

/** Intents lens: what a cable must connect between two ends, drawn pin to pin. */
export function IntentPanel({ projectId }: { projectId: string | null }) {
  return <Intents key={projectId ?? "library"} projectId={projectId} />;
}

function Intents({ projectId }: { projectId: string | null }) {
  const cache = useQueryClient();
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const definitions = useQuery({ queryKey: ["intent-definitions", projectId], queryFn: () => read<Definition[]>("workspace/definitions") });
  const identity = useQuery({ queryKey: ["intent-identity", definitionId], queryFn: () => read<Identity>(`catalog/definitions/${definitionId}`), enabled: !!definitionId });
  const draft = useQuery({ queryKey: ["intent-draft", draftId], queryFn: () => read<IntentDraft>(`interfaces/drafts/${draftId}`), enabled: !!draftId });
  const pick = (id: string | null) => { setDefinitionId(id); setDraftId(null); setRevisionId(null); };
  const openNewest = useOpenNewest(identity.data, setDraftId, setRevisionId);
  useOpenProbed(definitionIn(definitions.data, ["cable_intent"]), (id) => { pick(id); openNewest(id); });
  const all = definitions.data ?? [];
  const intents = all.filter((d) => d.kind === "cable_intent");
  return <Stack>
    <Title order={2}>Cable intents</Title>
    <Text size="sm">What a cable must connect, signal by signal, between two ends: a device port or a pinout variant at each end. Lines are proposed only where both ends declare the same signal; anything else is a question beside its pin. Red crossed stubs mark pins that must stay unconnected. Checking a cable against an intent comes later; it is never assumed to pass.</Text>
    {definitions.isError && <Alert color="red">{definitions.error.message}</Alert>}
    <Group align="end">
      <Select label="Cable intent" searchable placeholder={intents.length ? "Choose an intent" : "No intents yet"} data={intents.map((d) => ({ value: d.definition_id, label: d.name }))} value={definitionId} onChange={pick} />
      {identity.data && <Select label="Frozen revision" value={revisionId} onChange={setRevisionId} data={newestFirst(identity.data.revisions).map((r) => ({ value: r.revision_id, label: revisionOptionLabel(identity.data.name, r.number) }))} />}
      {identity.data && identity.data.drafts.length > 0 && <Select label="Draft" value={draftId} onChange={setDraftId} data={identity.data.drafts.map((d, i) => ({ value: d.draft_id, label: `Draft ${i + 1}` }))} />}
      {identity.data && <ContinueDraftButton drafts={identity.data.drafts} revisionId={revisionId} draftId={draftId} onOpen={setDraftId} />}
    </Group>
    {identity.isError && <Alert color="red">{identity.error.message}</Alert>}
    {revisionId && <IntentInspector key={revisionId} revisionId={revisionId} />}
    {draft.isError && <Alert color="red">{draft.error.message}</Alert>}
    {draft.data && <DraftEditor key={`${draft.data.draft_id}:${draft.data.state}`} draft={draft.data} definitions={all}
      onSaved={async () => { await cache.invalidateQueries({ queryKey: ["intent-draft", draftId] }); }}
      onFrozen={async (id) => { setRevisionId(id); await cache.invalidateQueries({ queryKey: ["intent-draft", draftId] }); await cache.invalidateQueries({ queryKey: ["intent-identity", definitionId] }); }} />}
    <NewIntent projectId={projectId} definitions={all} />
  </Stack>;
}

function DraftEditor({ draft, definitions, onSaved, onFrozen }: { draft: IntentDraft; definitions: Definition[]; onSaved: () => Promise<void>; onFrozen: (revisionId: string) => Promise<void> }) {
  const editGate = usePermission("design.edit");
  const freezeGate = usePermission("design.freeze");
  const canEdit = useCan("design.edit");
  const stored = draft.content.interface ?? null;
  const [value, setValue] = useState<CableIntent>(() => stored ?? emptyIntent());
  const save = useMutation({ mutationFn: () => command("interface.update", { draft_id: draft.draft_id, interface: value }, draft.state), onSuccess: onSaved });
  const freeze = useMutation({ mutationFn: () => command<{ revision_id: string }>("interface.freeze", { draft_id: draft.draft_id }, draft.state), onSuccess: (data) => onFrozen(data.revision_id) });
  const dirty = canEdit && (!stored || JSON.stringify(stored) !== JSON.stringify(value));
  const open = openCount(stored?.rows ?? []);
  return <Card withBorder><Stack gap="xs"><Title order={3}>Edit intent draft</Title>
    <InspectionScope permission="design.edit"><IntentEditor value={value} onChange={setValue} definitions={definitions} /></InspectionScope>
    <Group gap="xs">
      <Button variant="default" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()} {...editGate.props}>Save intent draft</Button>
      <Button loading={freeze.isPending} disabled={!stored || openCount(value.rows) > 0 || open > 0 || dirty} onClick={() => freeze.mutate()} {...freezeGate.props}>Freeze intent</Button>
      <FreezeHint open={Math.max(open, openCount(value.rows))} dirty={dirty} />
      <ReadOnlyNote permission="design.edit">Saving intents is unavailable.</ReadOnlyNote>
      <ReadOnlyNote permission="design.freeze">Freezing intents is unavailable.</ReadOnlyNote>
    </Group>
    {[save, freeze].map((m, i) => m.isError ? <Alert key={i} color="red">{m.error.message}</Alert> : null)}
  </Stack></Card>;
}
