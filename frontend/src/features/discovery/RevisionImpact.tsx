import { Alert, Button, Group, NativeSelect, Stack, Text, Title } from "@mantine/core";
import { useRef, useState } from "react";
import { revisionImpact, type DefinitionRevisions, type ImpactPage } from "./api";
import { revisionOptionLabel } from "../../lib/revision-labels";
import { ExactPins } from "../../lib/IdentityLabel";

export function RevisionImpact({ definition }: { definition: DefinitionRevisions }) {
  const [current, setCurrent] = useState("");
  const [candidate, setCandidate] = useState("");
  const [report, setReport] = useState<ImpactPage | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const options = [{ value: "", label: "Select exact revision" }, ...definition.revisions.map((r) => ({ value: r.revision_id, label: revisionOptionLabel(definition.name, r.number) }))];
  function choose(set: (value: string) => void, value: string) {
    generation.current++; set(value); setReport(null); setError(""); setBusy(false);
  }
  async function compare(after?: string) {
    const token = ++generation.current;
    const previous = report;
    setReport(null); setError(""); setBusy(true);
    try {
      const next = await revisionImpact(current, candidate, after);
      if (generation.current === token) setReport(after && previous ? { ...next, results: [...previous.results, ...next.results] } : next);
    } catch (reason) {
      if (generation.current === token) setError(reason instanceof Error ? reason.message : "Impact request failed.");
    } finally {
      if (generation.current === token) setBusy(false);
    }
  }
  return <Stack>
    <Title order={4}>Revision upgrade impact</Title>
    <Text size="sm">Compare an existing pin with a later revision of this identity. Existing frozen consumers retain their pins. Adoption requires editing and reviewing a new owning draft; matching labels do not establish feature correspondence or compatibility.</Text>
    <Group align="end">
      <NativeSelect label="Existing pinned revision" value={current} data={options} onChange={e => choose(setCurrent, e.currentTarget.value)} />
      <NativeSelect label="Proposed later revision" value={candidate} data={options} onChange={e => choose(setCandidate, e.currentTarget.value)} />
      <Button disabled={!current || !candidate || current === candidate} loading={busy} onClick={() => void compare()}>Review upgrade impact</Button>
    </Group>
    {error && <Alert color="red">{error}</Alert>}
    {report && <Stack>
      <Text>Revision {report.current_number} → revision {report.candidate_number} · {report.definition_kind}</Text>
      <Text>Design content: {report.content_changed ? "changed" : "unchanged"}. Captured dependency pins: {report.dependency_pins_changed ? "changed" : "unchanged"}.</Text>
      <Text>Existing pins retained. Compatibility: not evaluated. New owning draft required for adoption.</Text>
      <Text size="xs">Current snapshot SHA-256 {report.current_sha256}</Text>
      <Text size="xs">Proposed snapshot SHA-256 {report.candidate_sha256}</Text>
      {report.results.length === 0 && <Text>No visible parent snapshots pin the existing revision.</Text>}
      {report.results.map(row => <Stack gap={0} key={row.snapshot_id}><Text>{row.label}</Text><Text size="xs">Exact revision pin retained <ExactPins pins={[{ label: 'Snapshot ID', value: row.snapshot_id }, { label: 'Project ID', value: row.project_id }]} /></Text></Stack>)}
      {report.next_after && <Button disabled={busy} onClick={() => void compare(report.next_after ?? undefined)}>More affected pins</Button>}
    </Stack>}
  </Stack>;
}
