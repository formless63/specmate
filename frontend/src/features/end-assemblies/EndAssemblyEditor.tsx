import { Alert, Card, Group, Select, Stack, TextInput, Title } from "@mantine/core";
import type { Definition, EndAssembly } from "./api";
import { StackEditor, StackView, useResolvedStack } from "./StackEditor";

/** Layer cards with the resolved terminals beside them, so joins pick labels, not IDs. */
export function AssemblyEditor({ value, onChange, definitions }: { value: EndAssembly; onChange: (v: EndAssembly) => void; definitions?: Definition[] }) {
  const resolved = useResolvedStack({ stack: value.stack, end_assembly_revision_id: null });
  return <Stack gap="xs">
    <TextInput size="xs" label="Description" placeholder="Optional" value={value.description ?? ""} onChange={(e) => onChange({ ...value, description: e.currentTarget.value || null })} />
    <StackEditor label="End assembly" value={value.stack} onChange={(stack) => onChange({ ...value, stack })} definitions={definitions} resolved={resolved.data} />
    {resolved.isError && <Alert color="orange">{resolved.error.message}</Alert>}
    {resolved.data && <Card withBorder padding="xs"><Stack gap="xs"><Title order={5}>Pads, pins and what they reach</Title><StackView resolved={resolved.data} label="End assembly" /></Stack></Card>}
    <Group align="end">
      <Select size="xs" label="Review" data={[{ value: "unreviewed", label: "Unreviewed" }, { value: "reviewed", label: "Reviewed" }]} value={value.review} onChange={(v) => onChange({ ...value, review: (v ?? "unreviewed") as EndAssembly["review"] })} />
      <TextInput size="xs" label="Review basis" placeholder="Required when reviewed" value={value.review_basis ?? ""} onChange={(e) => onChange({ ...value, review_basis: e.currentTarget.value || null })} />
    </Group>
  </Stack>;
}
