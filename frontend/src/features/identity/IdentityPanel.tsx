import { Alert, Button, Card, Group, Select, Stack, Table, Text, TextInput, Textarea, Title } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { command, read, type Catalog, type Definition, type Identity } from "./api";

export function IdentityPanel({ projectId }: { projectId: string }) {
  return <IdentityWorkspace key={projectId} projectId={projectId} />;
}

function IdentityWorkspace({ projectId }: { projectId: string }) {
  const cache = useQueryClient();
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [identityOffset, setIdentityOffset] = useState(0);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("part");
  const definitions = useQuery({ queryKey: ["identity-definitions", projectId], queryFn: () => read<Definition[]>(`projects/${projectId}/definitions`) });
  const identity = useQuery({ queryKey: ["identity", definitionId, identityOffset], queryFn: () => read<Identity>(`catalog/definitions/${definitionId}?offset=${identityOffset}`), enabled: !!definitionId });
  const create = useMutation({ mutationFn: () => command<{ definition_id: string }>("definition.create", { project_id: projectId, kind, name }), onSuccess: async (data) => {
    setDefinitionId(data.definition_id); setRevisionId(null); setIdentityOffset(0); setName("");
    await cache.invalidateQueries({ queryKey: ["identity-definitions", projectId] });
  } });
  const freeze = useMutation({ mutationFn: (draft: { draft_id: string; state: string; dependencies: string[] }) => command<{ revision_id: string; number: number }>("draft.freeze", { draft_id: draft.draft_id, dependencies: draft.dependencies }, draft.state), onSuccess: async (data) => {
    setRevisionId(data.revision_id); setIdentityOffset(Math.floor((data.number - 1) / 50) * 50); await cache.invalidateQueries({ queryKey: ["identity", definitionId] });
  } });
  return <Stack>
    <Title order={2}>Reusable identities</Title>
    <Text>Definitions hold reusable designs. Orderable manufacturer variants, source representations and physical lots keep separate identities pinned to an exact revision.</Text>
    <Card withBorder><Stack>
      <Title order={3}>Create definition</Title>
      <TextInput label="Definition name" value={name} onChange={(event) => setName(event.currentTarget.value)} />
      <TextInput label="Definition kind" value={kind} onChange={(event) => setKind(event.currentTarget.value)} />
      <Button disabled={!name.trim() || !kind.trim()} loading={create.isPending} onClick={() => create.mutate()}>Create draft</Button>
      {create.isError && <Alert color="red">{create.error.message}</Alert>}
    </Stack></Card>
    {definitions.isError && <Alert color="red">{definitions.error.message}</Alert>}
    <Select label="Definition" placeholder="Choose a definition" searchable data={(definitions.data ?? []).map((d) => ({ value: d.definition_id, label: `${d.name} (${d.kind})` }))} value={definitionId} onChange={(value) => { setDefinitionId(value); setRevisionId(null); setIdentityOffset(0); }} />
    {identity.isError && <Alert color="red">{identity.error.message}</Alert>}
    {identity.data && <>
      <Text size="sm">Definition ID: {identity.data.definition_id}</Text>
      {identity.data.drafts.map((draft) => <Group key={draft.draft_id}><Text size="sm">Draft {draft.draft_id} · {draft.state}</Text><Button size="xs" loading={freeze.isPending} onClick={() => freeze.mutate(draft)}>Freeze current draft</Button></Group>)}
      <Text size="sm" c="dimmed">Freezing records the current draft. It does not qualify a part for manufacture.</Text>
      {freeze.isError && <Alert color="red">{freeze.error.message}</Alert>}
      <Select label="Exact revision" placeholder="Freeze a draft or choose a revision" data={identity.data.revisions.map((r) => ({ value: r.revision_id, label: `Revision ${r.number}` }))} value={revisionId} onChange={setRevisionId} />
      <Group><Button disabled={identityOffset === 0} onClick={() => setIdentityOffset(Math.max(0, identityOffset - 50))}>Previous revisions</Button><Text>Revision page {identityOffset / 50 + 1}</Text><Button disabled={Math.max(identity.data.revisions.length, identity.data.drafts.length) < 50} onClick={() => setIdentityOffset(identityOffset + 50)}>Next revisions</Button></Group>
    </>}
    {revisionId && <RevisionCatalog key={revisionId} revisionId={revisionId} />}
  </Stack>;
}

function RevisionCatalog({ revisionId }: { revisionId: string }) {
  const cache = useQueryClient();
  const [manufacturer, setManufacturer] = useState("");
  const [partNumber, setPartNumber] = useState("");
  const [basis, setBasis] = useState("");
  const [lotLabel, setLotLabel] = useState("");
  const [variantId, setVariantId] = useState<string | null>(null);
  const [representationLabel, setRepresentationLabel] = useState("");
  const [representationKind, setRepresentationKind] = useState<string | null>("symbol");
  const [bundleRevision, setBundleRevision] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [offset, setOffset] = useState(0);
  const catalog = useQuery({ queryKey: ["catalog", revisionId, offset], queryFn: () => read<Catalog>(`catalog/revisions/${revisionId}?offset=${offset}&limit=50`) });
  const registration = useMutation({ mutationFn: ({ operation, payload }: { operation: string; payload: object }) => command(operation, { revision_id: revisionId, ...payload }), onSuccess: async () => { await cache.invalidateQueries({ queryKey: ["catalog", revisionId] }); } });
  const register = (operation: string, payload: object) => registration.mutate({ operation: `catalog.register_${operation}`, payload });
  return <Stack>
    <Text size="sm">Revision ID: {revisionId}</Text>
    {catalog.isError && <Alert color="red">{catalog.error.message}</Alert>}
    {registration.isError && <Alert color="red">{registration.error.message}</Alert>}
    {registration.isSuccess && <Alert color="green">Identity registered.</Alert>}
    <Card withBorder><Stack>
      <Title order={3}>Manufacturer variants</Title>
      <Table><Table.Thead><Table.Tr><Table.Th>Manufacturer / part</Table.Th><Table.Th>Association basis</Table.Th><Table.Th>Variant ID</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{catalog.data?.variants.map((v) => <Table.Tr key={v.variant_id}><Table.Td>{v.manufacturer} / {v.part_number}</Table.Td><Table.Td>{v.association_basis}</Table.Td><Table.Td>{v.variant_id}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
      <TextInput label="Manufacturer" value={manufacturer} onChange={(e) => setManufacturer(e.currentTarget.value)} />
      <TextInput label="Manufacturer part number" value={partNumber} onChange={(e) => setPartNumber(e.currentTarget.value)} />
      <Textarea label="Basis for this association" value={basis} onChange={(e) => setBasis(e.currentTarget.value)} />
      <Button disabled={!manufacturer.trim() || !partNumber.trim() || !basis.trim()} loading={registration.isPending} onClick={() => register("variant", { manufacturer, part_number: partNumber, association_basis: basis })}>Register variant</Button>
    </Stack></Card>
    <Card withBorder><Stack>
      <Title order={3}>Physical lots</Title>
      <Text size="sm">A lot identifies a physical batch. Registration does not receive, reserve or consume stock.</Text>
      {catalog.data?.lots.map((lot) => <Text key={lot.lot_id}>{lot.label} · Lot {lot.lot_id} · {lot.variant_id ? `Variant ${lot.variant_id}` : "Manufacturer variant unknown"}</Text>)}
      <TextInput label="Lot label" value={lotLabel} onChange={(e) => setLotLabel(e.currentTarget.value)} />
      <Select label="Lot manufacturer variant" placeholder="Unknown / unassigned" clearable value={variantId} onChange={setVariantId} data={(catalog.data?.variants ?? []).map((v) => ({ value: v.variant_id, label: `${v.manufacturer} / ${v.part_number}` }))} />
      <Button disabled={!lotLabel.trim()} loading={registration.isPending} onClick={() => register("lot", { label: lotLabel, variant_id: variantId })}>Register lot identity</Button>
    </Stack></Card>
    <Card withBorder><Stack>
      <Title order={3}>Representations</Title>
      {catalog.data?.representations.map((r) => <Text key={r.representation_id}>{r.label} ({r.kind}) · {r.source_path} · Rights: {r.rights} · SHA-256: {r.sha256}</Text>)}
      <TextInput label="Representation label" value={representationLabel} onChange={(e) => setRepresentationLabel(e.currentTarget.value)} />
      <Select label="Representation kind" value={representationKind} onChange={setRepresentationKind} data={["symbol", "footprint", "model", "drawing", "datasheet"]} allowDeselect={false} />
      <TextInput label="Registered source bundle revision ID" value={bundleRevision} onChange={(e) => setBundleRevision(e.currentTarget.value)} />
      <TextInput label="Source package path" value={sourcePath} onChange={(e) => setSourcePath(e.currentTarget.value)} />
      <Text size="sm">Choose an exact file from a registered source bundle in this project. Its original rights are retained.</Text>
      <Button disabled={!representationLabel.trim() || !bundleRevision.trim() || !sourcePath.trim()} loading={registration.isPending} onClick={() => register("representation", { label: representationLabel, kind: representationKind, source_bundle_revision_id: bundleRevision, source_path: sourcePath })}>Register representation</Button>
    </Stack></Card>
    <Group><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous records</Button><Text>Page {offset / 50 + 1}</Text><Button disabled={!catalog.data || Math.max(catalog.data.variants.length, catalog.data.lots.length, catalog.data.representations.length) < 50} onClick={() => setOffset(offset + 50)}>Next records</Button></Group>
  </Stack>;
}
