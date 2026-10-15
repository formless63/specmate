import { Alert, Button, Card, Group, Stack, Table, Text, Title, UnstyledButton } from "@mantine/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { SbStatus, type SbLed } from "../../components/sb";
import { ReadOnlyNote, usePermission } from "../../lib/permissions";
import { randomUUID } from "../../lib/random-id";
import { recordCableIntentCheck } from "../evidence/api";
import { SignalTypeChip } from "../interfaces/SignalSetPanel";
import { DIMENSIONS, DIMENSION_LABELS, checkPath, read, type CheckRow, type Chip, type Dimension, type IntentCheck, type Status } from "./api";
import "./intent-check.css";

/** One LED per outcome: unknown and not evaluated stay distinct, and neither looks like pass. */
export function statusLed(status: Status): SbLed {
  return status === "pass" ? "pass" : status === "fail" ? "failed" : status === "unknown" ? "unknown" : status === "flagged" ? "info" : "not-evaluated";
}
const WORDS: Record<Status, string> = { pass: "pass", fail: "fail", unknown: "unknown", not_evaluated: "not evaluated", flagged: "flagged" };

function Led({ dimension, value }: { dimension: string; value: Dimension }) {
  return <span title={`${value.reason}${value.evidence.length ? ` (evidence: ${value.evidence.join("; ")})` : ""}`}><SbStatus led={statusLed(value.status)} dimension={dimension} value={WORDS[value.status]} /></span>;
}

function PathChips({ chips }: { chips: Chip[] }) {
  if (!chips.length) return <Text size="xs" c="dimmed">No declared path.</Text>;
  return <div className="sb-path-chain" role="list" aria-label="Declared path">
    {chips.map((chip, i) => <span key={i} role="listitem" className="sb-chain-chip" data-kind={chip.kind} data-unknown={chip.status === "unknown" || undefined}>{chip.label}</span>)}
  </div>;
}

function RowDetail({ row }: { row: CheckRow }) {
  return <Stack gap={4} p="xs">
    <PathChips chips={row.path} />
    {row.note && <Text size="xs">{row.note}</Text>}
    <Table verticalSpacing={2} className="sb-check-table" aria-label={`Dimensions of ${row.row_id}`}>
      <Table.Tbody>{DIMENSIONS.map((name) => <Table.Tr key={name}>
        <Table.Td><SbStatus led={statusLed(row.dimensions[name].status)} dimension={DIMENSION_LABELS[name]} value={WORDS[row.dimensions[name].status]} /></Table.Td>
        <Table.Td><Text size="xs">{row.dimensions[name].reason}</Text></Table.Td>
        <Table.Td><Text size="xs" c="dimmed">{row.dimensions[name].evidence.join("; ") || "—"}</Text></Table.Td>
      </Table.Tr>)}</Table.Tbody>
    </Table>
  </Stack>;
}

/**
 * Check against intent: one row per intent row with its outcome and ten separate
 * dimensions; expand a row for the declared path chain and every reason. Frozen cables
 * can record the shown check as design evidence pinned to both exact revisions.
 */
export function IntentCheckPanel({ revisionId = null, draftId = null, intentRevisionId = null }: { revisionId?: string | null; draftId?: string | null; intentRevisionId?: string | null }) {
  const recordGate = usePermission("item.create");
  const [open, setOpen] = useState<string | null>(null);
  const [key] = useState(randomUUID);
  const result = useQuery({ queryKey: ["cable-intent-check", revisionId, draftId, intentRevisionId], queryFn: () => read<IntentCheck>(checkPath({ revisionId, draftId }, intentRevisionId)), enabled: !!intentRevisionId && !!(revisionId || draftId), retry: false });
  const record = useMutation({ mutationFn: () => recordCableIntentCheck(revisionId!, result.data!.intent_revision_id, key) });
  if (!intentRevisionId) return <Card withBorder><Stack gap={4}><Title order={4}>Check against intent</Title><Text size="sm" c="dimmed">Pin a cable intent on this cable to check it signal by signal.</Text></Stack></Card>;
  const data = result.data;
  return <Card withBorder aria-label="Check against intent"><Stack gap="xs">
    <Group justify="space-between"><Title order={4}>Check against intent</Title>
      {data && <Text size="xs" c="dimmed">{data.intent_name} r{data.intent_number} · {draftId ? "saved draft" : "frozen revision"} · declared topology, not continuity</Text>}</Group>
    {result.isLoading && <Text size="sm" role="status">Checking…</Text>}
    {result.isError && <Alert color="red">{result.error.message}</Alert>}
    {data && <>
      <Group gap="md" wrap="wrap">
        {(["pass", "fail", "unknown", "not_evaluated"] as Status[]).map((s) => <SbStatus key={s} led={statusLed(s)} dimension={WORDS[s]} value={String(data.counts[s] ?? 0)} />)}
        <Led dimension="from end mating" value={data.ends.from.mating} /><Led dimension="to end mating" value={data.ends.to.mating} />
        <Led dimension="cable isolation" value={data.cable.isolation} /><Led dimension="cable shield" value={data.cable.shield} />
      </Group>
      <Text size="xs" c="dimmed">From {data.ends.from.intent_end} at {data.ends.from.label}; to {data.ends.to.intent_end} at {data.ends.to.label}.</Text>
      <Table.ScrollContainer minWidth={1100}><Table verticalSpacing={2} className="sb-check-table" aria-label="Intent check rows">
        <Table.Thead><Table.Tr><Table.Th>Signal</Table.Th><Table.Th>From</Table.Th><Table.Th>To</Table.Th><Table.Th>Outcome</Table.Th>{DIMENSIONS.map((d) => <Table.Th key={d}>{DIMENSION_LABELS[d]}</Table.Th>)}</Table.Tr></Table.Thead>
        <Table.Tbody>{data.rows.map((row) => <Fragment key={row.row_id}>
          <Table.Tr data-outcome={row.outcome}>
            <Table.Td><UnstyledButton aria-expanded={open === row.row_id} aria-label={`Path and reasons for ${row.row_id}`} onClick={() => setOpen(open === row.row_id ? null : row.row_id)}>
              <Group gap={4} wrap="nowrap"><span>{open === row.row_id ? "▾" : "▸"}</span><span>{row.signal?.name ?? "unknown"}</span>{row.signal && <SignalTypeChip type={row.signal.type} />}</Group></UnstyledButton></Table.Td>
            <Table.Td className="sb-mono">{row.from_label ?? "none"}</Table.Td>
            <Table.Td className="sb-mono">{row.to_labels.join(", ") || (row.requirement === "must_not_connect" ? "must not connect" : "none")}</Table.Td>
            <Table.Td><SbStatus led={statusLed(row.outcome)} dimension="row" value={WORDS[row.outcome]} /></Table.Td>
            {DIMENSIONS.map((d) => <Table.Td key={d} title={row.dimensions[d].reason}><span className="sb-led" data-state={statusLed(row.dimensions[d].status)} aria-label={`${DIMENSION_LABELS[d]} ${WORDS[row.dimensions[d].status]}`} /></Table.Td>)}
          </Table.Tr>
          {open === row.row_id && <Table.Tr><Table.Td colSpan={4 + DIMENSIONS.length}><RowDetail row={row} /></Table.Td></Table.Tr>}
        </Fragment>)}</Table.Tbody>
      </Table></Table.ScrollContainer>
      {revisionId && <Group gap="xs">
        <Button size="xs" variant="default" loading={record.isPending} disabled={record.isSuccess} onClick={() => record.mutate()} {...recordGate.props}>Record this check as evidence</Button>
        <ReadOnlyNote permission="item.create">Recording evidence is unavailable.</ReadOnlyNote>
        {record.isSuccess && <Text size="xs" role="status">Recorded, pinned to this cable revision and intent revision.</Text>}
      </Group>}
      {record.isError && <Alert color="red">{record.error.message}</Alert>}
      {draftId && <Text size="xs" c="dimmed">Checks the saved draft. Freeze the cable to record a check as evidence.</Text>}
    </>}
  </Stack></Card>;
}
