import { Alert, Badge, Button, Card, Checkbox, Group, Stack, Table, Text, Title } from "@mantine/core";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { SbStatus } from "../../components/sb";
import { apiErrorMessage } from "../../lib/api-errors";
import { ReadOnlyNote, usePermission } from "../../lib/permissions";
import type { Assignment, Cable } from "../cables/api";
import { command } from "../identity/api";
import type { EndStack } from "../end-assemblies/api";
import { statusLed } from "../intent-check/IntentCheckPanel";
import type { IntentCheck } from "../intent-check/api";

export type EndChoice = { end_assembly_revision_id?: string | null; stack?: EndStack | null; label?: string | null };
export type ProposedRow = {
  row_id: string; requirement: string; status: "proposed" | "question" | "not_wired"; conductor: string | null; reason: string | null;
  assignments: (Assignment & { terminal_label: string })[]; questions: Question[];
};
export type Question = { row_id: string; kind: string; text: string; options?: string[]; development_need?: { need: string; summary: string; description: string } };
export type Proposal = {
  intent_revision_id: string; cable: Cable; rows: ProposedRow[]; questions: Question[]; existing_needs: { definition_id: string; name: string }[];
  check: IntentCheck; diff: { endpoint_id: string; element_path: string; change: "same" | "added" | "changed" | "removed"; current: Assignment | null; proposed: Assignment | null }[] | null;
  status: "proposed"; review: "required";
};

export async function requestProposal(body: object): Promise<Proposal> {
  const csrf = document.cookie.split("; ").find((cookie) => cookie.startsWith("csrftoken="))?.split("=")[1];
  const response = await fetch("/api/v0/cables/propose", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRFToken": decodeURIComponent(csrf ?? "") }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(apiErrorMessage(result, `Request failed (${response.status})`));
  return result as Proposal;
}

const key = (a: { endpoint_id: string; element_path: string }) => `${a.endpoint_id}\u0000${a.element_path}`;

/** The cable with the accepted rows' landings replacing the current ones for the same conductor ends. */
export function acceptRows(current: Cable | null, proposal: Proposal, accepted: Set<string>): Cable {
  const chosen = proposal.rows.filter((r) => accepted.has(r.row_id)).flatMap((r) => r.assignments.map(({ terminal_label: _label, ...a }) => a));
  const replaced = new Set(chosen.map(key));
  if (!current) return { ...proposal.cable, assignments: chosen };
  return { ...current, intent_revision_id: proposal.intent_revision_id, assignments: [...current.assignments.filter((a) => !replaced.has(key(a))), ...chosen] };
}

const CHANGE_WORDS = { same: "unchanged", added: "new", changed: "changed", removed: "removed" } as const;

/**
 * Propose wiring: a deterministic proposal from the intent, shown with its check result and,
 * for a draft, what each row would change. Questions are listed, never answered silently;
 * nothing reaches the draft until rows are accepted.
 */
export function ProposeWiring({ intentRevisionId, draftId = null, current = null, stockRevisionId = null, fromEnd = null, toEnd = null, onAccept, acceptLabel = "Accept selected rows" }: {
  intentRevisionId: string; draftId?: string | null; current?: Cable | null; stockRevisionId?: string | null; fromEnd?: EndChoice | null; toEnd?: EndChoice | null;
  onAccept: (cable: Cable) => void | Promise<void>; acceptLabel?: string;
}) {
  const createGate = usePermission("item.create");
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const proposal = useMutation({
    mutationFn: () => requestProposal({ intent_revision_id: intentRevisionId, ...(draftId ? { draft_id: draftId } : { stock_revision_id: stockRevisionId, from_end: fromEnd, to_end: toEnd }) }),
    onSuccess: (data) => setAccepted(new Set(data.rows.filter((r) => r.status === "proposed").map((r) => r.row_id))),
  });
  const need = useMutation({ mutationFn: (q: Question) => command("definition.create", { kind: "development_need", name: q.development_need!.summary, content: { development_need: q.development_need } }) });
  const accept = useMutation({ mutationFn: async () => { await onAccept(acceptRows(current, proposal.data!, accepted)); } });
  const ready = !!intentRevisionId && (!!draftId || (!!stockRevisionId && !!fromEnd && !!toEnd));
  const data = proposal.data;
  const outcomes = new Map((data?.check.rows ?? []).map((r) => [r.row_id, r.outcome] as const));
  const changes = new Map((data?.diff ?? []).map((d) => [key(d), d.change] as const));
  return <Card withBorder aria-label="Propose wiring"><Stack gap="xs">
    <Group justify="space-between"><Title order={4}>Propose wiring</Title>
      <Button size="xs" variant="default" disabled={!ready} loading={proposal.isPending} onClick={() => proposal.mutate()}>{data ? "Propose again" : "Propose wiring from the intent"}</Button></Group>
    <Text size="xs" c="dimmed">Conductors follow the conductor requirement and your conventions; each lands on the pad or part that reaches its pin. Nothing is invented and nothing is saved until you accept rows.</Text>
    {!ready && <Text size="xs" role="status">Choose a stock and both ends first.</Text>}
    {proposal.isError && <Alert color="red">{proposal.error.message}</Alert>}
    {data && <>
      {data.questions.length > 0 && <Alert color="yellow" title={`${data.questions.length} question${data.questions.length === 1 ? "" : "s"}`}><Stack gap={4}>
        {data.questions.map((q, i) => <Group key={i} gap="xs" wrap="nowrap" align="flex-start"><Badge size="xs" variant="outline">{q.row_id}</Badge><Text size="xs">{q.text}{q.options ? ` Options: ${q.options.join(", ")}.` : ""}</Text>
          {q.development_need && <Button size="compact-xs" variant="default" loading={need.isPending} disabled={need.isSuccess} onClick={() => need.mutate(q)} {...createGate.props}>Record as development need</Button>}</Group>)}
        {data.existing_needs.length > 0 && <Text size="xs">Existing development needs: {data.existing_needs.map((n) => n.name).join(", ")}.</Text>}
        {need.isSuccess && <Text size="xs" role="status">Development need recorded.</Text>}
      </Stack></Alert>}
      <Table.ScrollContainer minWidth={900}><Table verticalSpacing={2} className="sb-check-table" aria-label="Proposed rows">
        <Table.Thead><Table.Tr><Table.Th>Accept</Table.Th><Table.Th>Row</Table.Th><Table.Th>Conductor</Table.Th><Table.Th>Landings</Table.Th><Table.Th>Why</Table.Th><Table.Th>Checked</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{data.rows.map((row) => {
          const outcome = outcomes.get(row.row_id);
          return <Table.Tr key={row.row_id}>
            <Table.Td><Checkbox aria-label={`Accept row ${row.row_id}`} disabled={row.assignments.length === 0} checked={accepted.has(row.row_id)} onChange={(e) => { const next = new Set(accepted); if (e.currentTarget.checked) next.add(row.row_id); else next.delete(row.row_id); setAccepted(next); }} /></Table.Td>
            <Table.Td className="sb-mono">{row.row_id}{row.status !== "proposed" && <Text span size="xs" c="dimmed"> · {row.status === "question" ? "question" : "not wired"}</Text>}</Table.Td>
            <Table.Td className="sb-mono">{row.conductor ?? "—"}</Table.Td>
            <Table.Td>{row.assignments.map((a) => <Text key={key(a)} size="xs" className="sb-mono">{a.endpoint_id.toUpperCase()}: {a.element_path.replace(/^stock\./, "")} → {a.terminal_label}{data.diff ? ` (${CHANGE_WORDS[changes.get(key(a)) ?? "added"]})` : ""}</Text>)}</Table.Td>
            <Table.Td><Text size="xs">{row.reason ?? row.questions[0]?.text ?? "—"}</Text></Table.Td>
            <Table.Td>{outcome ? <SbStatus led={statusLed(outcome)} dimension="check" value={outcome.replace("_", " ")} /> : null}</Table.Td>
          </Table.Tr>;
        })}</Table.Tbody>
      </Table></Table.ScrollContainer>
      <Group gap="xs">
        <Button size="xs" disabled={accepted.size === 0} loading={accept.isPending} onClick={() => accept.mutate()}>{acceptLabel} ({accepted.size})</Button>
        <Button size="xs" variant="subtle" onClick={() => setAccepted(new Set())}>Reject all</Button>
        <ReadOnlyNote permission="design.edit">Accepting into a draft is unavailable.</ReadOnlyNote>
      </Group>
      {accept.isError && <Alert color="red">{accept.error.message}</Alert>}
      {accept.isSuccess && <Text size="xs" role="status">Accepted rows were applied.</Text>}
    </>}
  </Stack></Card>;
}
