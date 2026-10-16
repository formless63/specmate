import { Alert, Button, Card, Group, Select, Stack, Table, Text, TextInput, Textarea, Title } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { InspectionScope, ReadOnlyNote, usePermission } from '../../lib/permissions';
import { RevisionLabel } from '../../lib/IdentityLabel';
import { command, read, type Catalog } from './api';
import { RepresentationsCard } from './RepresentationsCard';

export function RevisionCatalog({ revisionId, workspaceId, active = true, scopeKey = "" }: { revisionId: string; workspaceId: string | null; active?: boolean; scopeKey?: string }) {
  // Catalog associations are additive registrations: contributors may record them.
  const editGate = usePermission('item.create');
  const cache = useQueryClient();
  const [manufacturer, setManufacturer] = useState("");
  const [partNumber, setPartNumber] = useState("");
  const [basis, setBasis] = useState("");
  const [lotLabel, setLotLabel] = useState("");
  const [variantId, setVariantId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const catalog = useQuery({ queryKey: ["catalog", scopeKey, revisionId, offset], enabled: active, queryFn: () => read<Catalog>(`catalog/revisions/${revisionId}?offset=${offset}&limit=50`) });
  const registration = useMutation({ mutationFn: ({ operation, payload }: { operation: string; payload: object }) => command(operation, { revision_id: revisionId, ...payload }), onSuccess: async () => { await Promise.all([cache.invalidateQueries({ queryKey: ["catalog", scopeKey, revisionId] }), cache.invalidateQueries({ queryKey: ["catalog", revisionId] })]); } });
  const register = (operation: string, payload: object) => { if (active && editGate.allowed && !catalog.isError && !catalog.isFetching) registration.mutate({ operation: `catalog.register_${operation}`, payload }); };
  return <Stack hidden={!active} inert={!active}>
    <Text size="sm"><RevisionLabel id={revisionId} /></Text>
    {catalog.isError && <Alert color="red">{catalog.error.message}</Alert>}
    {registration.isError && <Alert color="red">{registration.error.message}</Alert>}
    {registration.isSuccess && <Alert color="green">Identity registered.</Alert>}
    <Card withBorder><Stack>
      <Title order={3}>Manufacturer variants</Title>
      <Table><Table.Thead><Table.Tr><Table.Th>Manufacturer / part</Table.Th><Table.Th>Association basis</Table.Th><Table.Th>Variant ID</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{(!catalog.isError && !catalog.isFetching ? catalog.data?.variants : undefined)?.map((v) => <Table.Tr key={v.variant_id}><Table.Td>{v.manufacturer} / {v.part_number}</Table.Td><Table.Td>{v.association_basis}</Table.Td><Table.Td>{v.variant_id}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
      <InspectionScope permission="item.create">
      <TextInput label="Manufacturer" value={manufacturer} onChange={(e) => setManufacturer(e.currentTarget.value)} />
      <TextInput label="Manufacturer part number" value={partNumber} onChange={(e) => setPartNumber(e.currentTarget.value)} />
      <Textarea label="Basis for this association" value={basis} onChange={(e) => setBasis(e.currentTarget.value)} />
      </InspectionScope>
      <Button disabled={!manufacturer.trim() || !partNumber.trim() || !basis.trim()} loading={registration.isPending} onClick={() => register("variant", { manufacturer, part_number: partNumber, association_basis: basis })} {...editGate.props}>Register variant</Button><ReadOnlyNote permission="item.create">Registering identities is unavailable.</ReadOnlyNote>
    </Stack></Card>
    <Card withBorder><Stack>
      <Title order={3}>Physical lots</Title>
      <Text size="sm">A lot identifies a physical batch. Registration does not receive, reserve or consume stock.</Text>
      {(!catalog.isError && !catalog.isFetching ? catalog.data?.lots : undefined)?.map((lot) => <Text key={lot.lot_id}>{lot.label} · Lot {lot.lot_id} · {lot.variant_id ? `Variant ${lot.variant_id}` : "Manufacturer variant unknown"}</Text>)}
      <InspectionScope permission="item.create">
      <TextInput label="Lot label" value={lotLabel} onChange={(e) => setLotLabel(e.currentTarget.value)} />
      <Select label="Lot manufacturer variant" placeholder="Unknown / unassigned" clearable value={variantId} onChange={setVariantId} data={(catalog.isError || catalog.isFetching ? [] : catalog.data?.variants ?? []).map((v) => ({ value: v.variant_id, label: `${v.manufacturer} / ${v.part_number}` }))} />
      </InspectionScope>
      <Button disabled={!lotLabel.trim()} loading={registration.isPending} onClick={() => register("lot", { label: lotLabel, variant_id: variantId })} {...editGate.props}>Register lot identity</Button>
    </Stack></Card>
    <RepresentationsCard scopeKey={scopeKey} active={active} catalog={catalog.isError || catalog.isFetching ? undefined : catalog.data} workspaceId={workspaceId} pending={registration.isPending} register={register} />
    <Group><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous records</Button><Text>Page {offset / 50 + 1}</Text><Button disabled={!catalog.data || Math.max(catalog.data.variants.length, catalog.data.lots.length, catalog.data.representations.length) < 50} onClick={() => setOffset(offset + 50)}>Next records</Button></Group>
  </Stack>;
}
