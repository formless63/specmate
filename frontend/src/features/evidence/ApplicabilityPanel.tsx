import { Alert, Button, Card, Group, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
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
  const [draft, setDraft] = useState("");
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const result = useQuery({ queryKey: ["evidence-applicability", workspaceId, revisionId, offset], queryFn: () => read<ApplicabilityList>(applicabilityPath(workspaceId, revisionId ?? "", offset)), enabled: revisionId !== null, retry: false });
  const valid = UUID.test(draft.trim());
  return <Card withBorder><Stack gap="xs">
    <Title order={3}>Applicability to a revision</Title>
    <Text size="sm">Choose a frozen revision to see which evidence is exact for it, stale because it was recorded against an earlier revision, or inapplicable. Old results and observations stay attached to what they were recorded against; nothing here qualifies the selected revision.</Text>
    <Group align="end">
      <TextInput label="Revision ID" value={draft} onChange={(event) => setDraft(event.currentTarget.value)} error={draft && !valid ? "Enter a revision UUID." : undefined} style={{ flex: 1 }} />
      <Button disabled={!valid} onClick={() => { setOffset(0); setRevisionId(draft.trim()); }}>Check applicability</Button>
    </Group>
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
