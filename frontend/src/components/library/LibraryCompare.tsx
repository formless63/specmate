import { Alert, Button, Group, Modal, Table, Text } from "@mantine/core";
import type { LibraryField, LibraryTableRecord } from "../../features/library-gallery/table-api";

export function savedState(row: LibraryTableRecord): string {
  const summary = row.summary;
  return summary.basis === "latest_frozen" ? `Frozen r${row.latest_revision}` : summary.basis === "newest_draft" ? `Saved draft v${summary.draft_version}` : "Saved state unknown";
}
export function fieldText(field?: LibraryField): string {
  return field?.value === null || field?.value === undefined ? "Unknown" : `${String(field.value).replaceAll("_", " ")}${field.unit ? ` ${field.unit}` : ""}`;
}
export function numberText(row: LibraryTableRecord): string {
  return (row.summary.numbers.map(number => `${number.manufacturer} ${number.value}`).join(" · ") || "Unassigned") + (row.summary.numbers_truncated ? " · more associations not shown" : "");
}

/** Compares the two saved projections captured by selection; no engineering judgment. */
export function LibraryCompare({ rows, opened, onClose }: { rows: LibraryTableRecord[]; opened: boolean; onClose: () => void }) {
  const fields = [...new Map(rows.flatMap(row => row.summary.fields).map(field => [field.key, field])).values()];
  return <Modal opened={opened} onClose={onClose} title="Compare saved states" size="xl">
    <Alert color="blue" mb="sm">Properties of these exact saved states. Differences do not establish compatibility or qualification. Unsaved editor changes are excluded.</Alert>
    <div className="sb-ws-scroll"><Table className="sb-ws-table"><Table.Thead><Table.Tr><Table.Th>Property</Table.Th>{rows.map(row => <Table.Th key={row.record_id}>{row.label}</Table.Th>)}</Table.Tr></Table.Thead>
      <Table.Tbody>
        <Table.Tr><Table.Th>State</Table.Th>{rows.map(row => <Table.Td key={row.record_id}><Text size="sm">{savedState(row)}</Text><Text className="sb-mono" size="xs">{row.summary.revision_id ?? `${row.summary.draft_id} / v${row.summary.draft_version}`}</Text></Table.Td>)}</Table.Tr>
        <Table.Tr><Table.Th>Manufacturer PN</Table.Th>{rows.map(row => <Table.Td key={row.record_id}>{numberText(row)}</Table.Td>)}</Table.Tr>
        <Table.Tr><Table.Th>Kind</Table.Th>{rows.map(row => <Table.Td key={row.record_id}>{row.kind?.replaceAll("_", " ")}</Table.Td>)}</Table.Tr>
        {fields.map(field => <Table.Tr key={field.key}><Table.Th>{field.label}</Table.Th>{rows.map(row => <Table.Td key={row.record_id}>{fieldText(row.summary.fields.find(value => value.key === field.key))}</Table.Td>)}</Table.Tr>)}
      </Table.Tbody></Table></div>
    <Group justify="flex-end" mt="sm"><Button variant="quiet" onClick={onClose}>Close comparison</Button></Group>
  </Modal>;
}
