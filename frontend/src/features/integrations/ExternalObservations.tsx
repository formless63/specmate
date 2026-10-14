import { Alert, Button, Group, Stack, Table, Text, TextInput } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SbUnknown } from "../../components/sb";
import { useCan, usePermission } from "../../lib/permissions";
import { listObservations, run } from "./api";

/** Imported supplier observations for one item: not reviewed, never counted as offers until promoted. */
export function ExternalObservations({ workspaceId, revisionId, name }: { workspaceId: string; revisionId: string; name: string }) {
  const cache = useQueryClient();
  const query = useQuery({ queryKey: ["external-observations", workspaceId, revisionId], queryFn: () => listObservations(workspaceId, revisionId) });
  const gate = usePermission("item.create");
  const can = useCan("item.create");
  const [basis, setBasis] = useState<Record<string, string>>({});
  const promote = useMutation({
    mutationFn: (id: string) => run("integration.promote_observation", { observation_id: id, review_basis: basis[id] ?? "" }),
    onSuccess: async () => {
      await Promise.all([cache.invalidateQueries({ queryKey: ["external-observations"] }), cache.invalidateQueries({ queryKey: ["sourcing-report"] })]);
    },
  });
  const rows = query.data?.observations ?? [];
  if (query.isError) return <Alert color="red">{query.error.message}</Alert>;
  if (rows.length === 0) return null;
  return <Stack gap={4} aria-label={`External observations for ${name}`}>
    <Text size="sm" fw={600}>External observations (not reviewed): {name}</Text>
    {promote.isError && <Alert color="red">{promote.error.message}</Alert>}
    <Table><Table.Thead><Table.Tr><Table.Th>Supplier</Table.Th><Table.Th>Price</Table.Th><Table.Th>Dated</Table.Th><Table.Th>Source</Table.Th><Table.Th><span className="sb-visually-hidden">Promote</span></Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{rows.map((o) => <Table.Tr key={o.observation_id}>
        <Table.Td>{o.supplier}{o.external_ref ? ` · ${o.external_ref}` : ""}</Table.Td>
        <Table.Td>{o.price?.amount != null ? `${o.price.amount} ${o.price.currency ?? ""} per ${o.price.per_unit ?? "ea"}`.trim() : <SbUnknown what="price" />}</Table.Td>
        <Table.Td>{o.observed_on}</Table.Td>
        <Table.Td><Text size="xs">{o.attribution.integration}, row {o.attribution.row_number}, imported by {o.attribution.imported_by.username}</Text></Table.Td>
        <Table.Td>{o.promoted_offer_id ? <Text size="xs">Promoted to a reviewed offer</Text> : can ? <Group gap={4} wrap="nowrap">
          <TextInput size="xs" aria-label={`Review basis for ${o.supplier}`} placeholder="Review basis" value={basis[o.observation_id] ?? ""} onChange={(e) => setBasis({ ...basis, [o.observation_id]: e.currentTarget.value })} />
          <Button size="xs" loading={promote.isPending} disabled={!(basis[o.observation_id] ?? "").trim()} onClick={() => promote.mutate(o.observation_id)} {...gate.props}>Promote {o.supplier}</Button>
        </Group> : <Text size="xs">Read-only: promotion needs contributor access</Text>}</Table.Td>
      </Table.Tr>)}</Table.Tbody></Table>
  </Stack>;
}
