import { Stack, Table, Text, Title } from "@mantine/core";
import { SbStatus, SbUnknown } from "../../components/sb";
import type { SbLed } from "../../components/sb";
import type { ComputedImpact, EvidenceGroup, ImpactStatus } from "./api";

const disciplines = ["electrical", "mechanical", "firmware", "manufacturing", "evidence"] as const;
const shown: Record<ImpactStatus, { led: SbLed; label: string }> = {
  changed: { led: "review", label: "changed, review required" },
  unknown: { led: "stale", label: "unknown, review required" },
  not_evaluated: { led: "not-evaluated", label: "not evaluated" },
  no_difference_found: { led: "info", label: "no difference in compared sections" },
  none_found: { led: "info", label: "no readable evidence affected" },
};

function Evidence({ title, group }: { title: string; group: EvidenceGroup | null }) {
  if (!group) return null;
  return <Stack gap={4}>
    <Text fw={600}>{title}: {group.total}{group.truncated ? ` (first ${group.items.length} shown)` : ""}</Text>
    <Text size="sm" c="dimmed">{group.reason}</Text>
    {group.scan_limit_reached && <SbUnknown what="Complete evidence list" next="scan limit reached" />}
    {group.items.map((item) => <Text key={item.evidence_id} size="sm">
      {item.kind_label} · {item.statement} · {item.subject}{item.evidence_revision_number != null ? ` · recorded at r${item.evidence_revision_number}` : ""}{item.changed_sections.length ? ` · changed since: ${item.changed_sections.join(", ")}` : ""}
    </Text>)}
  </Stack>;
}

/** CFG-004: derived impact of a proposal; unknown is never shown as no impact. */
export function ComputedImpactPanel({ impact }: { impact?: ComputedImpact }) {
  if (!impact) return <Stack gap="xs" aria-label="Computed impact">
    <Title order={3}>Computed impact</Title>
    <SbUnknown what="Impact" next="the server did not return a computed impact; treat every discipline as not evaluated" />
  </Stack>;
  const content = impact.content;
  return <Stack gap="xs" aria-label="Computed impact">
    <Title order={3}>Computed impact</Title>
    <Text size="sm">Derived from the exact frozen revisions and recorded evidence. Nothing is adopted; compatibility is not evaluated.</Text>
    <Table>
      <Table.Thead><Table.Tr><Table.Th>Discipline</Table.Th><Table.Th>Computed status</Table.Th><Table.Th>Reason</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{disciplines.map((d) => {
        const row = impact.disciplines[d];
        const style = shown[row.status] ?? shown.unknown;
        return <Table.Tr key={d} data-discipline={d} data-status={row.status}>
          <Table.Td>{d}</Table.Td>
          <Table.Td><SbStatus led={style.led} dimension="computed" value={style.label} /></Table.Td>
          <Table.Td>{row.reason}</Table.Td>
        </Table.Tr>;
      })}</Table.Tbody>
    </Table>
    <Text fw={600}>Frozen content r{content.from_number} → r{content.to_number}</Text>
    {content.content_changed
      ? <Text size="sm">Changed content: {content.changed_sections.join(", ") || "differs outside named sections"}{content.sections_truncated ? " (more not listed)" : ""}</Text>
      : <Text size="sm">Frozen content is identical.</Text>}
    {impact.adapter.status === "computed" && <>
      <Text fw={600}>Changed sections ({impact.sections.length})</Text>
      {!impact.sections.length && <Text size="sm">No compared section changed.</Text>}
      {impact.sections.map((s) => <Text key={s.section} size="sm" data-section={s.section}>
        {s.section} · {s.status} · {s.summary}{s.reviews.length ? ` · re-review: ${s.reviews.join(", ")}` : ""}
      </Text>)}
    </>}
    {impact.adapter.status !== "computed" && <Text size="sm">Section comparison: {impact.adapter.reason}</Text>}
    <Title order={4}>Evidence staleness</Title>
    <Evidence title="Becomes stale on adoption" group={impact.evidence.becomes_stale} />
    <Evidence title="Consuming revision evidence" group={impact.evidence.consumer_stale} />
    <Evidence title="Definition-wide, unverified for the candidate" group={impact.evidence.definition_scope_unverified} />
    <Evidence title="Already recorded against the candidate" group={impact.evidence.candidate_recorded} />
  </Stack>;
}
