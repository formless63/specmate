import { ReadOnlyNote, usePermission, InspectionScope } from "../../lib/permissions";
import { Alert, Button, Card, Checkbox, Group, Select, Stack, Table, Text, TextInput, Textarea, Title } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { command, libraryDefinitions, read, type Catalog, type Identity } from "./api";
import { RepresentationsCard } from "./RepresentationsCard";
import { IdentityLabel, RevisionLabel } from "../../lib/IdentityLabel";
import { definitionIn, useOpenNewest, useOpenProbed } from "../scope/openProbed";

import { newestFirst } from '../../lib/revision-labels';
/** Library identities. `projectId` is optional navigation context, never the item's owner. */
export function IdentityPanel({ projectId }: { projectId?: string | null }) {
  return <IdentityWorkspace key={projectId ?? "library"} projectId={projectId ?? null} />;
}

function IdentityWorkspace({ projectId }: { projectId: string | null }) {
  const cache = useQueryClient();
  const createGate = usePermission('item.create');
  const freezeGate = usePermission('design.freeze');
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [identityOffset, setIdentityOffset] = useState(0);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("part");
  const [useHere, setUseHere] = useState(true);
  const definitions = useQuery({ queryKey: ["library-definitions", projectId], queryFn: () => libraryDefinitions(projectId) });
  const identity = useQuery({ queryKey: ["identity", definitionId, identityOffset], queryFn: () => read<Identity>(`catalog/definitions/${definitionId}?offset=${identityOffset}`), enabled: !!definitionId });
  // A Library row, deep link or other view opens its definition here.
  const openNewest = useOpenNewest(identity.data, () => undefined, setRevisionId);
  useOpenProbed(definitionIn(definitions.data?.results, []), (id) => { setDefinitionId(id); setRevisionId(null); setIdentityOffset(0); openNewest(id); });
  const create = useMutation({ mutationFn: async () => {
    // New items join the workspace library; "Use in this project" adds the reference in the same operation.
    const workspaceId = definitions.data?.workspace_id ?? (await libraryDefinitions(projectId)).workspace_id;
    return command<{ definition_id: string }>("definition.create", { workspace_id: workspaceId, kind, name, ...(projectId && useHere ? { project_id: projectId } : {}) });
  }, onSuccess: async (data) => {
    setDefinitionId(data.definition_id); setRevisionId(null); setIdentityOffset(0); setName("");
    await cache.invalidateQueries({ queryKey: ["library-definitions", projectId] });
    // Other panels still cache definition lists under the earlier key.
    await cache.invalidateQueries({ queryKey: ["identity-definitions"] });
  } });
  const freeze = useMutation({ mutationFn: (draft: { draft_id: string; state: string; dependencies: string[] }) => command<{ revision_id: string; number: number }>("draft.freeze", { draft_id: draft.draft_id, dependencies: draft.dependencies }, draft.state), onSuccess: async (data) => {
    setRevisionId(data.revision_id); setIdentityOffset(Math.floor((data.number - 1) / 50) * 50); await cache.invalidateQueries({ queryKey: ["identity", definitionId] });
  } });
  return <Stack>
    <Title order={2}>Reusable identities</Title>
    <Text>Definitions hold reusable designs. Orderable manufacturer variants, source representations and physical lots keep separate identities pinned to an exact revision.</Text>
    <Card withBorder><Stack>
      <Title order={3}>Create definition</Title>
      <InspectionScope permission="item.create">
      <TextInput label="Definition name" value={name} onChange={(event) => setName(event.currentTarget.value)} />
      <TextInput label="Definition kind" value={kind} onChange={(event) => setKind(event.currentTarget.value)} />
      {projectId && <Checkbox label="Use in this project" checked={useHere} onChange={(event) => setUseHere(event.currentTarget.checked)} />}
      </InspectionScope>
      <Button disabled={!name.trim() || !kind.trim()} loading={create.isPending} onClick={() => create.mutate()} {...createGate.props}>Create draft</Button><ReadOnlyNote permission="item.create">Creating drafts is unavailable.</ReadOnlyNote>
      {create.isError && <Alert color="red">{create.error.message}</Alert>}
    </Stack></Card>
    {definitions.isError && <Alert color="red">{definitions.error.message}</Alert>}
    <Select label="Definition" placeholder="Choose a library definition" searchable data={(definitions.data?.results ?? []).map((d) => ({ value: d.definition_id, label: `${d.name} (${d.kind})${d.in_project ? " · in this project" : ""}` }))} value={definitionId} onChange={(value) => { setDefinitionId(value); setRevisionId(null); setIdentityOffset(0); }} />
    {identity.isError && <Alert color="red">{identity.error.message}</Alert>}
    {identity.data && <>
      <Text size="sm"><IdentityLabel name={identity.data.name} kind={identity.data.kind} pins={[{ label: 'Definition ID', value: identity.data.definition_id }]} /></Text>
      {identity.data.drafts.map((draft) => <Group key={draft.draft_id}><Text size="sm">Draft {draft.draft_id} · {draft.state}</Text><Button size="xs" loading={freeze.isPending} onClick={() => freeze.mutate(draft)} {...freezeGate.props}>Freeze current draft</Button></Group>)}
      <Text size="sm" c="dimmed">Freezing records the current draft. It does not qualify a part for manufacture.</Text>
      {freeze.isError && <Alert color="red">{freeze.error.message}</Alert>}
      <Select label="Exact revision" placeholder="Freeze a draft or choose a revision" data={newestFirst(identity.data.revisions).map((r) => ({ value: r.revision_id, label: `Revision ${r.number}` }))} value={revisionId} onChange={setRevisionId} />
      <Group><Button disabled={identityOffset === 0} onClick={() => setIdentityOffset(Math.max(0, identityOffset - 50))}>Previous revisions</Button><Text>Revision page {identityOffset / 50 + 1}</Text><Button disabled={Math.max(identity.data.revisions.length, identity.data.drafts.length) < 50} onClick={() => setIdentityOffset(identityOffset + 50)}>Next revisions</Button></Group>
    </>}
    {revisionId && <RevisionCatalog key={revisionId} revisionId={revisionId} workspaceId={definitions.data?.workspace_id ?? null} />}
  </Stack>;
}

function RevisionCatalog({ revisionId, workspaceId }: { revisionId: string; workspaceId: string | null }) {
  // Catalog associations are additive registrations: contributors may record them.
  const editGate = usePermission('item.create');
  const cache = useQueryClient();
  const [manufacturer, setManufacturer] = useState("");
  const [partNumber, setPartNumber] = useState("");
  const [basis, setBasis] = useState("");
  const [lotLabel, setLotLabel] = useState("");
  const [variantId, setVariantId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const catalog = useQuery({ queryKey: ["catalog", revisionId, offset], queryFn: () => read<Catalog>(`catalog/revisions/${revisionId}?offset=${offset}&limit=50`) });
  const registration = useMutation({ mutationFn: ({ operation, payload }: { operation: string; payload: object }) => command(operation, { revision_id: revisionId, ...payload }), onSuccess: async () => { await cache.invalidateQueries({ queryKey: ["catalog", revisionId] }); } });
  const register = (operation: string, payload: object) => registration.mutate({ operation: `catalog.register_${operation}`, payload });
  return <Stack>
    <Text size="sm"><RevisionLabel id={revisionId} /></Text>
    {catalog.isError && <Alert color="red">{catalog.error.message}</Alert>}
    {registration.isError && <Alert color="red">{registration.error.message}</Alert>}
    {registration.isSuccess && <Alert color="green">Identity registered.</Alert>}
    <Card withBorder><Stack>
      <Title order={3}>Manufacturer variants</Title>
      <Table><Table.Thead><Table.Tr><Table.Th>Manufacturer / part</Table.Th><Table.Th>Association basis</Table.Th><Table.Th>Variant ID</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{catalog.data?.variants.map((v) => <Table.Tr key={v.variant_id}><Table.Td>{v.manufacturer} / {v.part_number}</Table.Td><Table.Td>{v.association_basis}</Table.Td><Table.Td>{v.variant_id}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
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
      {catalog.data?.lots.map((lot) => <Text key={lot.lot_id}>{lot.label} · Lot {lot.lot_id} · {lot.variant_id ? `Variant ${lot.variant_id}` : "Manufacturer variant unknown"}</Text>)}
      <InspectionScope permission="item.create">
      <TextInput label="Lot label" value={lotLabel} onChange={(e) => setLotLabel(e.currentTarget.value)} />
      <Select label="Lot manufacturer variant" placeholder="Unknown / unassigned" clearable value={variantId} onChange={setVariantId} data={(catalog.data?.variants ?? []).map((v) => ({ value: v.variant_id, label: `${v.manufacturer} / ${v.part_number}` }))} />
      </InspectionScope>
      <Button disabled={!lotLabel.trim()} loading={registration.isPending} onClick={() => register("lot", { label: lotLabel, variant_id: variantId })} {...editGate.props}>Register lot identity</Button>
    </Stack></Card>
    <RepresentationsCard catalog={catalog.data} workspaceId={workspaceId} pending={registration.isPending} register={register} />
    <Group><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous records</Button><Text>Page {offset / 50 + 1}</Text><Button disabled={!catalog.data || Math.max(catalog.data.variants.length, catalog.data.lots.length, catalog.data.representations.length) < 50} onClick={() => setOffset(offset + 50)}>Next records</Button></Group>
  </Stack>;
}
