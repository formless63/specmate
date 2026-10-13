import { Alert, Button, Card, Checkbox, Group, NumberInput, Select, Stack, Table, Tabs, Text, TextInput, Title } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { addressKey, command, read, relationship, type Assembly, type Definition, type Draft, type Identity, type Occurrence, type Projection, type RelationshipKind } from "./api";

export function AssemblyPanel({ projectId }: { projectId: string }) {
  return <AssemblyWorkspace key={projectId} projectId={projectId} />;
}

function AssemblyWorkspace({ projectId }: { projectId: string }) {
  const cache = useQueryClient();
  const [name, setName] = useState("");
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [frozenRevision, setFrozenRevision] = useState<string | null>(null);
  const [identityOffset, setIdentityOffset] = useState(0);
  const definitions = useQuery({ queryKey: ["assembly-definitions", projectId], queryFn: () => read<Definition[]>(`projects/${projectId}/definitions`) });
  const identity = useQuery({ queryKey: ["assembly-identity", definitionId, identityOffset], queryFn: () => read<Identity>(`catalog/definitions/${definitionId}?offset=${identityOffset}`), enabled: !!definitionId });
  const revision = useQuery({ queryKey: ["assembly-revision", frozenRevision], queryFn: () => read<{ snapshot_id: string }>(`revisions/${frozenRevision}`), enabled: !!frozenRevision });
  const inspectedSnapshot = snapshotId ?? revision.data?.snapshot_id;
  const draft = useQuery({ queryKey: ["assembly-draft", draftId], queryFn: () => read<Draft>(`assemblies/drafts/${draftId}`), enabled: !!draftId });
  const create = useMutation({ mutationFn: () => command<Draft>("assembly.create", { project_id: projectId, name }), onSuccess: async (data) => {
    setDefinitionId(data.definition_id); setDraftId(data.draft_id); setSnapshotId(null); setFrozenRevision(null); setIdentityOffset(0); setName("");
    await cache.invalidateQueries({ queryKey: ["assembly-definitions", projectId] });
  } });
  const capture = useMutation({ mutationFn: (freeze: boolean) => command<{ snapshot_id: string; draft?: Draft }>(freeze ? "assembly.freeze" : "assembly.snapshot", { draft_id: draftId }, draft.data?.state), onSuccess: async (data) => {
    setSnapshotId(data.snapshot_id);
    await cache.invalidateQueries({ queryKey: ["assembly-draft", draftId] });
    await cache.invalidateQueries({ queryKey: ["assembly-identity", definitionId] });
  } });
  return <Stack>
    <Title order={2}>Reusable assemblies</Title>
    <Text>Every occurrence uses an exact revision. Local IDs preserve identity; display references such as J1 may repeat. Snapshots pin the complete assembly.</Text>
    <Group align="end"><TextInput label="Assembly name" value={name} onChange={(e) => setName(e.currentTarget.value)} /><Button disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>Create assembly draft</Button></Group>
    {create.isError && <Alert color="red">{create.error.message}</Alert>}
    {definitions.isError && <Alert color="red">{definitions.error.message}</Alert>}
    <Select label="Assembly definition" searchable value={definitionId} data={(definitions.data ?? []).filter((d) => d.kind === "assembly").map((d) => ({ value: d.definition_id, label: d.name }))} onChange={(id) => { setDefinitionId(id); setDraftId(null); setSnapshotId(null); setFrozenRevision(null); setIdentityOffset(0); }} />
    {identity.isError && <Alert color="red">{identity.error.message}</Alert>}
    {identity.data && <Select label="Assembly draft" value={draftId} data={identity.data.drafts.map((d) => ({ value: d.draft_id, label: `${d.draft_id} · ${d.state}` }))} onChange={(id) => { setDraftId(id); setSnapshotId(null); }} />}
    {identity.data && <><Select label="Frozen assembly revision" clearable value={frozenRevision} data={identity.data.revisions.map((r) => ({ value: r.revision_id, label: `Revision ${r.number} · ${r.revision_id}` }))} onChange={(id) => { setFrozenRevision(id); setSnapshotId(null); }} /><Group><Button disabled={identityOffset === 0} onClick={() => setIdentityOffset(Math.max(0, identityOffset - 50))}>Previous assembly revisions</Button><Button disabled={Math.max(identity.data.revisions.length, identity.data.drafts.length) < 50} onClick={() => setIdentityOffset(identityOffset + 50)}>Next assembly revisions</Button></Group></>}
    {revision.isError && <Alert color="red">{revision.error.message}</Alert>}
    {draft.isError && <Alert color="red">{draft.error.message}</Alert>}
    {draft.data && <>
      <AssemblyEditor key={draft.data.draft_id} draft={draft.data} definitions={definitions.data ?? []} onSaved={async () => { await cache.invalidateQueries({ queryKey: ["assembly-draft", draftId] }); }} />
      <Group><Button loading={capture.isPending} onClick={() => capture.mutate(false)}>Capture assembly snapshot</Button><Button loading={capture.isPending} onClick={() => capture.mutate(true)}>Freeze assembly revision</Button></Group>
      <Text size="sm" c="dimmed">Freezing does not establish fit, electrical compatibility or manufacturing qualification.</Text>
      {capture.isError && <Alert color="red">{capture.error.message}</Alert>}
    </>}
    <TextInput label="Inspect assembly snapshot ID" value={inspectedSnapshot ?? ""} onChange={(e) => { setFrozenRevision(null); setSnapshotId(e.currentTarget.value || null); }} />
    {inspectedSnapshot && <AssemblyInspector key={inspectedSnapshot} snapshotId={inspectedSnapshot} />}
  </Stack>;
}

function AssemblyEditor({ draft, definitions, onSaved }: { draft: Draft; definitions: Definition[]; onSaved: () => Promise<void> }) {
  const [childDefinition, setChildDefinition] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [childOffset, setChildOffset] = useState(0);
  const [localId, setLocalId] = useState("");
  const [displayRef, setDisplayRef] = useState("");
  const [relationshipKind, setRelationshipKind] = useState<RelationshipKind>("electrical");
  const [relationshipId, setRelationshipId] = useState("");
  const [pathA, setPathA] = useState("");
  const [pathB, setPathB] = useState("");
  const [featureA, setFeatureA] = useState("");
  const [featureB, setFeatureB] = useState("");
  const [assignmentPath, setAssignmentPath] = useState("");
  const [firmwareRevision, setFirmwareRevision] = useState("");
  const child = useQuery({ queryKey: ["assembly-child-identity", childDefinition, childOffset], queryFn: () => read<Identity>(`catalog/definitions/${childDefinition}?offset=${childOffset}`), enabled: !!childDefinition });
  const save = useMutation({ mutationFn: (assembly: Assembly) => command<Draft>("assembly.update", { draft_id: draft.draft_id, assembly }, draft.state), onSuccess: onSaved });
  const assembly = draft.content.assembly;
  const externalTarget = relationshipKind === "source_derivation" || relationshipKind === "procurement";
  function updateOccurrence(index: number, changes: Partial<Occurrence>) { save.mutate({ ...assembly, occurrences: assembly.occurrences.map((occ, i) => i === index ? { ...occ, ...changes } : occ) }); }
  return <Stack>
    <Text size="sm">Draft {draft.draft_id} · {draft.state}</Text>
    {save.isError && <Alert color="red">{save.error.message}</Alert>}
    <Card withBorder><Stack>
      <Title order={3}>Occurrences</Title>
      {assembly.occurrences.map((occ, index) => <OccurrenceEditor key={occ.local_id} occurrence={occ} busy={save.isPending} onSave={(changes) => updateOccurrence(index, changes)} onRemove={() => save.mutate({ ...assembly, occurrences: assembly.occurrences.filter((_, i) => i !== index) })} />)}
      <TextInput label="Stable local occurrence ID" description="A lowercase ID for this use, independent of its displayed reference." value={localId} onChange={(e) => setLocalId(e.currentTarget.value)} />
      <TextInput label="Display reference" value={displayRef} onChange={(e) => setDisplayRef(e.currentTarget.value)} />
      <Select label="Child definition" searchable value={childDefinition} data={definitions.map((d) => ({ value: d.definition_id, label: `${d.name} (${d.kind})` }))} onChange={(id) => { setChildDefinition(id); setRevisionId(null); setChildOffset(0); }} />
      {child.isError && <Alert color="red">{child.error.message}</Alert>}
      <Select label="Pinned child revision" value={revisionId} data={(child.data?.revisions ?? []).map((r) => ({ value: r.revision_id, label: `Revision ${r.number} · ${r.revision_id}` }))} onChange={setRevisionId} />
      {child.data && <Group><Button disabled={childOffset === 0} onClick={() => { setChildOffset(Math.max(0, childOffset - 50)); setRevisionId(null); }}>Previous child revisions</Button><Button disabled={child.data.revisions.length < 50} onClick={() => { setChildOffset(childOffset + 50); setRevisionId(null); }}>Next child revisions</Button></Group>}
      <Button disabled={!localId || !revisionId} loading={save.isPending} onClick={() => save.mutate({ ...assembly, occurrences: [...assembly.occurrences, { local_id: localId, revision_id: revisionId!, display_ref: displayRef, placement: { status: "unknown" } }] })}>Add occurrence</Button>
    </Stack></Card>
    <Card withBorder><Stack>
      <Title order={3}>Typed relationships</Title>
      {assembly.relationships.map((r) => <Group key={r.local_id}><Text>{r.local_id} · {r.kind}</Text><Button size="xs" variant="subtle" onClick={() => save.mutate({ ...assembly, relationships: assembly.relationships.filter((rel) => rel.local_id !== r.local_id) })}>Remove {r.local_id}</Button></Group>)}
      <Select label="Relationship type" value={relationshipKind} allowDeselect={false} data={["containment", "electrical", "mating", "mounting", "source_derivation", "documentation", "procurement"]} onChange={(value) => setRelationshipKind(value as RelationshipKind)} />
      <TextInput label="Relationship local ID" value={relationshipId} onChange={(e) => setRelationshipId(e.currentTarget.value)} />
      <TextInput label="First occurrence path" description="Local IDs separated by /; leave empty for the assembly root." value={pathA} onChange={(e) => setPathA(e.currentTarget.value)} />
      <TextInput label={externalTarget ? "Referenced exact revision ID" : "Second occurrence path"} value={pathB} onChange={(e) => setPathB(e.currentTarget.value)} />
      {relationshipKind !== "containment" && <Group><TextInput label="First stable feature ID" value={featureA} onChange={(e) => setFeatureA(e.currentTarget.value)} /><TextInput label="Second stable feature ID" value={featureB} onChange={(e) => setFeatureB(e.currentTarget.value)} /></Group>}
      <Text size="sm">Feature addresses retain their pinned identity. Feature existence and engineering compatibility are not evaluated here.</Text>
      <Button disabled={!relationshipId || (externalTarget && !pathB)} loading={save.isPending} onClick={() => save.mutate({ ...assembly, relationships: [...assembly.relationships, relationship(relationshipKind, relationshipId, pathA, pathB, featureA, featureB)] })}>Add typed relationship</Button>
    </Stack></Card>
    <Card withBorder><Stack>
      <Title order={3}>Contextual firmware assignments</Title>
      {assembly.assignments?.map((a) => <Group key={addressKey(a.path)}><Text>{a.path.join("/")} · {a.assignments.firmware_revision_id ?? "Unassigned"}</Text><Button size="xs" variant="subtle" onClick={() => save.mutate({ ...assembly, assignments: assembly.assignments?.filter((other) => addressKey(other.path) !== addressKey(a.path)) })}>Clear assignment for {a.path.join("/")}</Button></Group>)}
      <TextInput label="Firmware occurrence path" value={assignmentPath} onChange={(e) => setAssignmentPath(e.currentTarget.value)} />
      <TextInput label="Exact firmware revision ID" value={firmwareRevision} onChange={(e) => setFirmwareRevision(e.currentTarget.value)} />
      <Button disabled={!assignmentPath || !firmwareRevision} loading={save.isPending} onClick={() => { const path = assignmentPath.split("/"); save.mutate({ ...assembly, assignments: [...(assembly.assignments ?? []).filter((a) => addressKey(a.path) !== addressKey(path)), { path, assignments: { firmware_revision_id: firmwareRevision } }] }); }}>Assign firmware to this occurrence</Button>
    </Stack></Card>
  </Stack>;
}

function OccurrenceEditor({ occurrence, busy, onSave, onRemove }: { occurrence: Occurrence; busy: boolean; onSave: (changes: Partial<Occurrence>) => void; onRemove: () => void }) {
  const [displayRef, setDisplayRef] = useState(occurrence.display_ref);
  const [known, setKnown] = useState(occurrence.placement?.status === "known");
  const [translation, setTranslation] = useState<[number, number, number]>(occurrence.placement?.translation ?? [0, 0, 0]);
  return <Card withBorder><Stack gap="xs">
    <Text>Local ID: {occurrence.local_id} · Exact revision: {occurrence.revision_id}</Text>
    <TextInput label={`Display reference for ${occurrence.local_id}`} value={displayRef} onChange={(e) => setDisplayRef(e.currentTarget.value)} />
    <Checkbox label={`Known placement for ${occurrence.local_id}`} checked={known} onChange={(e) => setKnown(e.currentTarget.checked)} />
    {known && <Group>{["X", "Y", "Z"].map((axis, index) => <NumberInput key={axis} label={`${occurrence.local_id} ${axis} (mm)`} value={translation[index]} onChange={(value) => setTranslation((current) => current.map((v, i) => i === index ? Number(value) : v) as [number, number, number])} />)}</Group>}
    <Group><Button size="xs" loading={busy} onClick={() => onSave({ display_ref: displayRef, placement: known ? { status: "known", translation, rotation_xyzw: occurrence.placement?.rotation_xyzw ?? [0, 0, 0, 1] } : { status: "unknown" } })}>Save {occurrence.local_id}</Button><Button size="xs" color="red" onClick={onRemove}>Remove {occurrence.local_id}</Button></Group>
  </Stack></Card>;
}

export function AssemblyInspector({ snapshotId }: { snapshotId: string }) {
  const [selection, setSelection] = useState<string | null>(null);
  const [featureId, setFeatureId] = useState("");
  const [arranged, setArranged] = useState(false);
  const projection = useQuery({ queryKey: ["assembly-projection", snapshotId], queryFn: () => read<Projection>(`assemblies/snapshots/${snapshotId}`) });
  const selected = projection.data?.occurrences.find((node) => addressKey(node.address.path) === selection);
  return <Stack>
    <Title order={3}>Assembly snapshot</Title>
    {projection.isError && <Alert color="red">{projection.error.message}</Alert>}
    {projection.data && <>
      <Text size="sm">Snapshot {projection.data.snapshot_id} · SHA-256 {projection.data.sha256}</Text>
      <Tabs defaultValue="tree"><Tabs.List><Tabs.Tab value="tree">Occurrence tree</Tabs.Tab><Tabs.Tab value="table">Assembly contents</Tabs.Tab><Tabs.Tab value="arrangement">View arrangement</Tabs.Tab></Tabs.List>
        <Tabs.Panel value="tree"><Stack gap="xs">{projection.data.occurrences.map((node) => <Button key={addressKey(node.address.path)} variant={selection === addressKey(node.address.path) ? "filled" : "light"} aria-pressed={selection === addressKey(node.address.path)} onClick={() => setSelection(addressKey(node.address.path))}>{node.address.path.join("/")} · {node.display_ref || node.name}</Button>)}</Stack></Tabs.Panel>
        <Tabs.Panel value="table"><Table><Table.Thead><Table.Tr><Table.Th>Contextual path</Table.Th><Table.Th>Display reference</Table.Th><Table.Th>Pinned revision</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{projection.data.occurrences.map((node) => <Table.Tr key={addressKey(node.address.path)} data-selected={selection === addressKey(node.address.path)}><Table.Td><Button variant="subtle" onClick={() => setSelection(addressKey(node.address.path))}>{node.address.path.join("/")}</Button></Table.Td><Table.Td>{node.display_ref}</Table.Td><Table.Td>{node.revision_id}</Table.Td></Table.Tr>)}</Table.Tbody></Table></Tabs.Panel>
        <Tabs.Panel value="arrangement"><Stack><Checkbox label="Spread occurrences for inspection" checked={arranged} onChange={(e) => setArranged(e.currentTarget.checked)} /><Text size="sm">This is a display layout. Canonical placement stays in the pinned snapshot. Geometry and clearances are not evaluated.</Text><Group align="start" style={{ gap: arranged ? 48 : 12 }}>{projection.data.occurrences.map((node) => <Card key={addressKey(node.address.path)} withBorder><Button variant={selection === addressKey(node.address.path) ? "filled" : "light"} onClick={() => setSelection(addressKey(node.address.path))}>{node.address.path.join("/")}</Button><Text>{node.display_ref || node.name}</Text></Card>)}</Group></Stack></Tabs.Panel>
      </Tabs>
      {selected && <Card withBorder><Stack gap="xs">
        <Title order={4}>Selected occurrence</Title>
        <Text>Context: {selected.address.path.join("/")}</Text><Text>Display reference: {selected.display_ref}</Text>
        <Text>Definition: {selected.definition_id}</Text><Text>Exact revision: {selected.revision_id}</Text>
        <Text>Child snapshot SHA-256: {selected.snapshot_sha256}</Text>
        <Text>Firmware revision: {selected.assignments.firmware_revision_id ?? "Unassigned"}</Text>
        <Text>Canonical placement: {selected.placement.status === "known" ? `${selected.placement.translation?.join(", ")} mm` : "Unknown"}</Text>
        <TextInput label="Selected stable feature ID" value={featureId} onChange={(e) => setFeatureId(e.currentTarget.value)} />
        {featureId && <Text>Feature address: {snapshotId} / {selected.address.path.join("/")} / {featureId} · Existence and compatibility not evaluated</Text>}
      </Stack></Card>}
      <Title order={4}>Relationships</Title>
      {projection.data.relationships.map((r) => <Text key={`${addressKey(r.context_path)}:${r.local_id}`}>{r.context_path.join("/") || "Root"} · {r.local_id} · {r.kind}</Text>)}
    </>}
  </Stack>;
}
