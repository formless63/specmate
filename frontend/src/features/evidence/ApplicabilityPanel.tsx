import { Alert, Button, Card, Group, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useProbe } from "../probe";
import { SbStatus, type SbLed } from "../../components/sb";
import { applicabilityPath, read, type Applicability, type ApplicabilityList, type ApplicabilityStatus } from "./api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL: Record<ApplicabilityStatus, { led: SbLed; value: string }> = {
  exact_revision: { led: "info", value: "recorded against this revision" },
  exact_unit_only: { led: "info", value: "one unit of this revision only" },
  definition_scope_unverified: { led: "not-evaluated", value: "definition-wide, not verified for this revision" },
  stale_earlier_revision: { led: "stale", value: "stale: earlier revision" },
  inapplicable_later_revision: { led: "off", value: "inapplicable: later revision" },
};

function Change({ applicability }: { applicability: Applicability }) {
  const change = applicability.change;
  if (!change) return null;
  if (!change.content_changed) return <Text size="xs">Revision {change.from_number} to {change.to_number}: frozen content is identical, yet re-establishing the result is still a deliberate step.</Text>;
  return <Text size="xs">Changed since revision {change.from_number}: {change.changed_sections.join(", ") || "content"}{change.sections_truncated ? ", and more" : ""}</Text>;
}

/** Reads evidence for a revision's definition against that one revision. Nothing is rewritten or re-attached. */
export function ApplicabilityPanel({ workspaceId }: { workspaceId: string }) {
  const probe = useProbe()?.probe ?? null;
  const [draft, setDraft] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  // The shared selection names a definition (and maybe a revision); its revisions fill the picker.
  const definition = useQuery({ queryKey: ["evidence-applicability-revisions", probe?.object], queryFn: () => read<{ revisions: { revision_id: string; number: number }[] }>(`catalog/definitions/${probe?.object}?limit=100`), enabled: !!probe, retry: false });
  const options = (definition.data?.revisions ?? []).map((r) => ({ value: r.revision_id, label: `Revision ${r.number}` }));
  const fromProbe = definition.data?.revisions.find((r) => r.number === probe?.rev) ?? definition.data?.revisions.at(-1);
  const selected = picked && options.some((o) => o.value === picked) ? picked : fromProbe?.revision_id ?? null;
  const usePicker = !!probe && options.length > 0;
  const target = usePicker ? selected : revisionId;
  const result = useQuery({ queryKey: ["evidence-applicability", workspaceId, target, offset], queryFn: () => read<ApplicabilityList>(applicabilityPath(workspaceId, target ?? "", offset)), enabled: target !== null, retry: false });
  const valid = UUID.test(draft.trim());
  return <Card withBorder><Stack gap="xs">
    <Title order={3}>Applicability to a revision</Title>
    <Text size="sm">Using the selected item, choose a frozen revision to see which evidence is exact for it, stale because it was recorded against an earlier revision, or inapplicable. Old results and observations stay attached to what they were recorded against; nothing here qualifies the selected revision.</Text>
    {usePicker
      ? <Select label="Revision" data={options} value={selected} allowDeselect={false} onChange={(value) => { setPicked(value); setOffset(0); }} />
      : <>
        {probe && definition.isError && <Text size="xs">The selected object has no readable revisions here; enter a revision ID instead.</Text>}
        {!probe && <Text size="xs">Nothing is selected. Select an item, or enter a revision ID.</Text>}
        <Group align="end">
          <TextInput label="Revision ID" value={draft} onChange={(event) => setDraft(event.currentTarget.value)} error={draft && !valid ? "Enter a revision UUID." : undefined} style={{ flex: 1 }} />
          <Button disabled={!valid} onClick={() => { setOffset(0); setRevisionId(draft.trim()); }}>Check applicability</Button>
        </Group>
      </>}
    {result.isError && <Alert color="red">{result.error.message}</Alert>}
    {result.data && <>
      <Text size="sm">Selected revision {result.data.revision.number}{result.data.revision.is_latest ? " (latest)" : `; latest is revision ${result.data.revision.latest_number}`}</Text>
      {result.data.scan_limit_reached && <Alert color="orange">The scan limit was reached; older evidence may exist.</Alert>}
      {result.data.items.length === 0 ? <Text>No evidence is attached to this definition. Absence is not a pass.</Text> : <Table><Table.Thead><Table.Tr><Table.Th>Applicability</Table.Th><Table.Th>Evidence</Table.Th><Table.Th>Why</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
        {result.data.items.map(({ item, applicability }) => <Table.Tr key={item.evidence_id}>
          <Table.Td><SbStatus led={LABEL[applicability.status].led} dimension="applicability" value={LABEL[applicability.status].value} /></Table.Td>
          <Table.Td><Text size="sm">{item.statement}</Text><Text size="xs">{item.kind_label} · {item.subject.label} · recorded {item.recorded_at}</Text></Table.Td>
          <Table.Td><Text size="xs">{applicability.reason}</Text><Change applicability={applicability} /></Table.Td>
        </Table.Tr>)}
      </Table.Tbody></Table>}
      <Group><Button variant="quiet" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</Button><Button variant="quiet" disabled={!result.data.has_more} onClick={() => setOffset(offset + 50)}>Next</Button></Group>
    </>}
  </Stack></Card>;
}
