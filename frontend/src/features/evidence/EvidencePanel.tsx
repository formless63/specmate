import { Alert, Badge, Button, Card, Group, MultiSelect, Stack, Table, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { KIND_ORDER, evidenceQuery, read, type EvidenceItem, type EvidenceKind, type EvidenceList, type KindDescription } from "./api";

function KindBadge({ item }: { item: EvidenceItem }) {
  // Only an actual-unit measurement carries the unit badge; every other kind is a distinct label.
  const variant = item.kind === "physical_measurement" ? "unit" : item.kind === "requirement" ? "draft" : "frozen";
  return <Badge variant={variant}>{item.kind_label}</Badge>;
}

function Row({ item }: { item: EvidenceItem }) {
  const method = item.method;
  const details = [
    method.instrument && `Instrument: ${method.instrument}`,
    method.procedure && `Procedure: ${method.procedure}`,
    method.formula && `Formula: ${method.formula} (${method.algorithm_version})`,
    method.tool && `Recipe: ${method.tool}`,
  ].filter(Boolean) as string[];
  return <Table.Tr>
    <Table.Td><KindBadge item={item} /><Text size="xs">{item.source}</Text></Table.Td>
    <Table.Td><Text>{item.statement}</Text><Text size="xs">Status: {item.status.replaceAll("_", " ")}</Text>
      {item.conditions.map((c) => <Text size="xs" key={c.property}>Condition {c.property}: {c.status === "known" ? JSON.stringify(c.value) : "unknown"}</Text>)}</Table.Td>
    <Table.Td><Text size="sm">{item.subject.label}</Text><Text size="xs">{item.subject.scope === "actual" ? "Actual unit" : item.subject.scope === "design" ? "Design scope" : "Project scope"}</Text></Table.Td>
    <Table.Td><Text size="sm">Method: {method.name.replaceAll("_", " ")}</Text>{details.map((line) => <Text size="xs" key={line}>{line}</Text>)}</Table.Td>
    <Table.Td><Text size="sm">Origin: {item.basis.origin.replaceAll("_", " ")}</Text>{item.basis.references.map((ref) => <Text size="xs" key={ref}>{ref}</Text>)}
      <Text size="xs">{item.basis.independently_verified ? "Independently verified" : "Not independently verified"}</Text>
      <Text size="xs">Recorded {item.recorded_at}{item.observed_at ? ` · observed ${item.observed_at}` : ""}</Text></Table.Td>
    <Table.Td>{item.does_not_establish.map((line) => <Text size="xs" key={line}>Does not establish: {line}</Text>)}
      {item.warnings.map((line) => <Text size="xs" c="orange" key={line}>{line}</Text>)}</Table.Td>
  </Table.Tr>;
}

export function EvidencePanel({ projectId }: { projectId: string }) {
  return <EvidenceWorkspace key={projectId} projectId={projectId} />;
}

function EvidenceWorkspace({ projectId }: { projectId: string }) {
  const [kinds, setKinds] = useState<EvidenceKind[]>([]);
  const [offset, setOffset] = useState(0);
  const taxonomy = useQuery({ queryKey: ["evidence-taxonomy"], queryFn: () => read<{ kinds: KindDescription[] }>("evidence/taxonomy") });
  const evidence = useQuery({ queryKey: ["evidence", projectId, [...kinds].sort(), offset], queryFn: () => read<EvidenceList>(evidenceQuery(projectId, kinds, offset)) });
  const labels = new Map((taxonomy.data?.kinds ?? []).map((kind) => [kind.kind, kind.label]));
  return <Stack>
    <Title order={2}>Evidence by kind</Title>
    <Text>Requirements, declared claims, calculations, generated checks, reviews and physical measurements are separate kinds. Nothing here is a generic pass, and none of it is physical qualification.</Text>
    <Card withBorder><Stack gap="xs">
      <Title order={3}>Evidence kinds</Title>
      {taxonomy.isError && <Alert color="red">{taxonomy.error.message}</Alert>}
      {(taxonomy.data?.kinds ?? []).map((kind) => <Text size="sm" key={kind.kind}><strong>{kind.label}</strong>: {kind.summary} Never establishes: {kind.does_not_establish.join(" ")}</Text>)}
    </Stack></Card>
    <MultiSelect label="Show evidence kinds" placeholder="All kinds" clearable data={KIND_ORDER.map((kind) => ({ value: kind, label: labels.get(kind) ?? kind }))} value={kinds} onChange={(value) => { setKinds(value as EvidenceKind[]); setOffset(0); }} />
    {evidence.isError && <Alert color="red">{evidence.error.message}</Alert>}
    {evidence.data && !evidence.isError && <>
      {evidence.data.items.length === 0 && <Text>No evidence of the selected kinds is visible in this project. Absence is not a pass.</Text>}
      {evidence.data.scan_limit_reached && <Alert color="orange">The scan limit was reached; older records may exist. Narrow the kinds to see them.</Alert>}
      {evidence.data.items.length > 0 && <Table><Table.Thead><Table.Tr><Table.Th>Kind</Table.Th><Table.Th>Statement and conditions</Table.Th><Table.Th>Subject</Table.Th><Table.Th>Method</Table.Th><Table.Th>Provenance</Table.Th><Table.Th>Limits</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{evidence.data.items.map((item) => <Row key={item.evidence_id} item={item} />)}</Table.Tbody></Table>}
      <Group><Button variant="quiet" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous evidence</Button><Button variant="quiet" disabled={!evidence.data.has_more} onClick={() => setOffset(offset + 50)}>Next evidence</Button></Group>
    </>}
  </Stack>;
}
