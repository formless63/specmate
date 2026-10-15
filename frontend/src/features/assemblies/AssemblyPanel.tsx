import { Alert, Button, Card, Checkbox, Group, Select, Stack, Table, Tabs, Text, TextInput, Title } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { randomUUID } from '../../lib/random-id';
import { SourceError } from '../sources/api';
import { PlacementEditor } from './PlacementEditor';
import { MountingDetails, MountingEditor } from './MountingEditor';
import { addressKey, command, read, relationship, type Assembly, type Definition, type Draft, type Identity, type Occurrence, type Projection, type RelationshipKind } from "./api";
import { revisionOptionLabel, newestFirst } from "../../lib/revision-labels";
import { RevisionLabel } from "../../lib/IdentityLabel";
import { useCan } from "../../lib/permissions";
import { referenceFromProject } from "../scope/openProbed";
import { useProbedSelection } from "../cable-views/useProbedSelection";
import { useProbe } from "../probe";
import { ContinueDraftButton } from "../scope/ContinueDraftButton";

/** Library assemblies. `projectId` is optional context: new assemblies are then also referenced by that project. */
export function AssemblyPanel({ projectId = null, onAccessLost }: { projectId?: string | null; onAccessLost?: () => void }) {
  return <AssemblyWorkspace key={projectId ?? "library"} projectId={projectId} onAccessLost={onAccessLost} />;
}

function AssemblyWorkspace({ projectId, onAccessLost }: { projectId: string | null; onAccessLost?: () => void }) {
  const canEdit = useCan("design.edit");
  // Creating an assembly adds a workspace item (item.create); editing drafts needs design.edit.
  const canCreate = useCan("item.create");
  const canFreeze = useCan("design.freeze");
  const [accessError, setAccessError] = useState("");
  const generation = useRef(0);
  const [acceptedCapture, setAcceptedCapture] = useState<Draft | null>(null);
  const [captureState, setCaptureState] = useState<{ draft_id: string; state: string } | null>(null);
  const pendingCapture = useRef<{ fingerprint: string; key: string } | null>(null);
  const retainedDraft = useRef<Draft | null>(null);
  const cache = useQueryClient();
  const [name, setName] = useState("");
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [loadedDraftId, setLoadedDraftId] = useState<string | null>(null);
  const activeDraftId = useRef(draftId); activeDraftId.current = draftId;
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [frozenRevision, setFrozenRevision] = useState<string | null>(null);
  const [identityOffset, setIdentityOffset] = useState(0);
  const definitions = useQuery({ queryKey: ["assembly-definitions", projectId], queryFn: () => read<Definition[]>('workspace/definitions') });
  const identity = useQuery({ queryKey: ["assembly-identity", definitionId, identityOffset], queryFn: () => read<Identity>(`catalog/definitions/${definitionId}?offset=${identityOffset}`), enabled: !!definitionId });
  const revision = useQuery({ queryKey: ["assembly-revision", frozenRevision], queryFn: () => read<{ snapshot_id: string }>(`revisions/${frozenRevision}`), enabled: !!frozenRevision });
  const inspectedSnapshot = snapshotId ?? revision.data?.snapshot_id;
  const draft = useQuery({ queryKey: ["assembly-draft", draftId], queryFn: () => read<Draft>(`assemblies/drafts/${draftId}`), enabled: !!draftId && !accessError });
  function accessLost(error: Error) {
    if (!(error instanceof SourceError) || ![401, 403, 404].includes(error.status)) return;
    generation.current++; setAccessError(error.message);
    // Own manual input remains inert in mounted editors; no private DOM is rendered.
    // Restoration must authorize every selected draft/snapshot before revealing it.
    cache.removeQueries({ queryKey: ['assembly-projection'] }); cache.removeQueries({ queryKey: ['assembly-placement-inputs'] }); onAccessLost?.();
  }
  useEffect(() => { const error = draft.error || revision.error || identity.error || definitions.error; if (error) accessLost(error); }, [draft.error, revision.error, identity.error, definitions.error]);
  // Fresh current content may omit a pin still displayed by the retained editor.
  function authorizeRetainedPins() {
    const original = canEdit ? retainedDraft.current : null;
    const pins = new Set<string>(original?.content.assembly.occurrences.map(row => row.revision_id));
    if (original?.base_revision_id) pins.add(original.base_revision_id);
    for (const row of original?.content.assembly.relationships ?? []) {
      for (const ref of Object.values(row)) if (typeof ref === 'object' && ref && ref.kind === 'revision') pins.add(ref.revision_id);
    }
    for (const row of original?.content.assembly.occurrences ?? []) if (row.assignments?.firmware_revision_id) pins.add(row.assignments.firmware_revision_id);
    for (const row of original?.content.assembly.assignments ?? []) if (row.assignments.firmware_revision_id) pins.add(row.assignments.firmware_revision_id);
    return Promise.all([...pins].map(pin => read(`revisions/${pin}`)));
  }
  useEffect(() => {
    const focus = () => {
      const token = generation.current;
      const original = retainedDraft.current;
      void definitions.refetch(); if (draftId) void draft.refetch();
      if (inspectedSnapshot) void cache.refetchQueries({ queryKey: ['assembly-projection', inspectedSnapshot] });
      void authorizeRetainedPins().catch(error => { if (token === generation.current && original === retainedDraft.current) accessLost(error); });
    };
    window.addEventListener('focus', focus);
    return () => { generation.current++; window.removeEventListener('focus', focus); };
  }, [draftId, inspectedSnapshot, canEdit]);
  useEffect(() => {
    if (draft.data && !draft.isFetching && !draft.isError) {
      setLoadedDraftId(draft.data.draft_id);
      if (captureState?.draft_id !== draft.data.draft_id || (!canEdit && captureState.state !== draft.data.state)) {
        retainedDraft.current = draft.data; setCaptureState({ draft_id: draft.data.draft_id, state: draft.data.state });
      }
    }
  }, [draft.data, draft.isFetching, draft.isError, captureState, canEdit]);
  async function refreshAuthorized() {
    const token = generation.current;
    const original = retainedDraft.current;
    try {
      const [nextDefinitions, nextIdentity, nextDraft, nextRevision, nextProjection] = await Promise.all([
        read<Definition[]>('workspace/definitions'),
        definitionId ? read<Identity>(`catalog/definitions/${definitionId}?offset=${identityOffset}`) : Promise.resolve(null),
        draftId ? read<Draft>(`assemblies/drafts/${draftId}`) : Promise.resolve(null),
        frozenRevision ? read<{ snapshot_id: string }>(`revisions/${frozenRevision}`) : Promise.resolve(null),
        inspectedSnapshot ? read<Projection>(`assemblies/snapshots/${inspectedSnapshot}`) : Promise.resolve(null),
        authorizeRetainedPins(),
      ]);
      if (token !== generation.current || original !== retainedDraft.current) return;
      cache.setQueryData(['assembly-definitions', projectId], nextDefinitions);
      if (nextIdentity) cache.setQueryData(['assembly-identity', definitionId, identityOffset], nextIdentity);
      if (nextDraft) cache.setQueryData(['assembly-draft', draftId], nextDraft);
      if (nextRevision) cache.setQueryData(['assembly-revision', frozenRevision], nextRevision);
      if (nextProjection) cache.setQueryData(['assembly-projection', inspectedSnapshot], nextProjection);
      create.reset(); capture.reset(); setAccessError('');
    } catch (error) { if (token === generation.current && original === retainedDraft.current) accessLost(error as Error); }
  }
  async function guarded<T>(request: () => Promise<T>) {
    const token = generation.current;
    try { return { data: await request(), token }; }
    catch (error) { if (token === generation.current) throw error; return { data: null, token }; }
  }
  function clearDraftSession() {
    setAcceptedCapture(null); retainedDraft.current = null; setCaptureState(null);
    setLoadedDraftId(null); pendingCapture.current = null;
  }
  const create = useMutation({ mutationFn: () => guarded(() => command<Draft>("assembly.create", { name })), onSuccess: async ({ data, token }) => {
    if (token !== generation.current || !data) return;
    clearDraftSession(); setDefinitionId(data.definition_id); setDraftId(data.draft_id); setSnapshotId(null); setFrozenRevision(null); setIdentityOffset(0); setName("");
    await cache.invalidateQueries({ queryKey: ["assembly-definitions", projectId] });
    await referenceFromProject(projectId, data.definition_id, "assembly");
  }, onError: accessLost });
  const pick = (id: string | null) => { generation.current++; clearDraftSession(); setDefinitionId(id); setDraftId(null); setSnapshotId(null); setFrozenRevision(null); setIdentityOffset(0); };
  const probe = useProbe()?.probe;
  useEffect(() => {
    if (probe?.object === definitionId && probe.rev !== null) {
      setDraftId(null); setSnapshotId(null); setFrozenRevision(null);
      setIdentityOffset(Math.floor((probe.rev - 1) / 50) * 50);
    }
  }, [probe?.object, probe?.rev, definitionId]);
  useProbedSelection({ kind: "assembly", definitions: accessError ? undefined : definitions.data, definitionId,
    revisions: identity.data?.definition_id === definitionId && identityOffset === (probe?.rev ? Math.floor((probe.rev - 1) / 50) * 50 : 0) ? identity.data.revisions : undefined,
    drafts: identity.data?.definition_id === definitionId ? identity.data.drafts : undefined,
    pickDefinition: pick, pickRevision: setFrozenRevision, pickDraft: setDraftId });
  const capture = useMutation({ mutationFn: (freeze: boolean) => {
    const operation = freeze ? "assembly.freeze" : "assembly.snapshot";
    const expectedState = captureState?.draft_id === draftId ? captureState.state : undefined;
    const fingerprint = JSON.stringify([operation, draftId, expectedState]);
    if (!pendingCapture.current || pendingCapture.current.fingerprint !== fingerprint) pendingCapture.current = { fingerprint, key: randomUUID() };
    return guarded(() => command<{ snapshot_id: string; draft?: Draft }>(operation, { draft_id: draftId }, expectedState, pendingCapture.current!.key));
  }, onSuccess: async ({ data, token }) => {
    if (token !== generation.current || !data) return;
    pendingCapture.current = null; setSnapshotId(data.snapshot_id);
    if (data.draft) { retainedDraft.current = data.draft; setAcceptedCapture(data.draft); setCaptureState({ draft_id: data.draft.draft_id, state: data.draft.state }); }
    await cache.invalidateQueries({ queryKey: ["assembly-draft", draftId] });
    await cache.invalidateQueries({ queryKey: ["assembly-identity", definitionId] });
  }, onError: accessLost });
  return <Stack>
    <Title order={2}>Reusable assemblies</Title>
    <Text>Every occurrence uses an exact revision. Local IDs preserve identity; display references such as J1 may repeat. Snapshots pin the complete assembly.</Text>
    {canCreate && !accessError && <Group align="end"><TextInput label="Assembly name" value={name} onChange={(e) => setName(e.currentTarget.value)} /><Button disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>Create assembly draft</Button></Group>}
    {accessError && <Alert color="red">{accessError}</Alert>}
    <Button onClick={() => { void refreshAuthorized(); }}>Refresh authorized assemblies</Button>
    {!accessError && create.isError && <Alert color="red">{create.error.message}</Alert>}
    {!accessError && definitions.isError && <Alert color="red">{definitions.error.message}</Alert>}
    {!accessError && <Select label="Assembly definition" searchable value={definitionId} data={(definitions.data ?? []).filter((d) => d.kind === "assembly").map((d) => ({ value: d.definition_id, label: d.name }))} onChange={pick} />}
    {!accessError && identity.isError && <Alert color="red">{identity.error.message}</Alert>}
    {!accessError && identity.data && <Select label="Assembly draft" value={draftId} data={identity.data.drafts.map((d) => ({ value: d.draft_id, label: `${d.draft_id} · ${d.state}` }))} onChange={(id) => { generation.current++; clearDraftSession(); setDraftId(id); setSnapshotId(null); }} />}
    {!accessError && identity.data && <ContinueDraftButton drafts={identity.data.drafts} revisionId={frozenRevision} draftId={draftId} onOpen={(id) => { generation.current++; clearDraftSession(); setDraftId(id); setSnapshotId(null); }} />}
    {!accessError && identity.data && <><Select label="Frozen assembly revision" clearable value={frozenRevision} data={newestFirst(identity.data.revisions).map((r) => ({ value: r.revision_id, label: revisionOptionLabel(identity.data.name, r.number) }))} onChange={(id) => { generation.current++; setFrozenRevision(id); setSnapshotId(null); }} /><Group><Button disabled={identityOffset === 0} onClick={() => setIdentityOffset(Math.max(0, identityOffset - 50))}>Previous assembly revisions</Button><Button disabled={Math.max(identity.data.revisions.length, identity.data.drafts.length) < 50} onClick={() => setIdentityOffset(identityOffset + 50)}>Next assembly revisions</Button></Group></>}
    {!accessError && revision.isError && <Alert color="red">{revision.error.message}</Alert>}
    {!accessError && draft.isError && <Alert color="red">{draft.error.message}</Alert>}
    {draft.data && loadedDraftId === draftId && <>
      <AssemblyEditor key={draft.data.draft_id} draft={draft.data} definitions={definitions.data ?? []} authorized={!accessError} acceptedCapture={acceptedCapture} canEdit={canEdit} onDenied={error => { if (draftId === activeDraftId.current) accessLost(error); }} onSaved={async data => { retainedDraft.current = data; setCaptureState({ draft_id: data.draft_id, state: data.state }); await cache.invalidateQueries({ queryKey: ["assembly-draft", draftId] }); }} />
      {!accessError && <Group>{canEdit && <Button disabled={captureState?.draft_id !== draftId} loading={capture.isPending} onClick={() => capture.mutate(false)}>Capture assembly snapshot</Button>}{canFreeze && <Button disabled={captureState?.draft_id !== draftId} loading={capture.isPending} onClick={() => capture.mutate(true)}>Freeze assembly revision</Button>}</Group>}
      <Text size="sm">Capture and freeze use the saved assembly declaration. Save staged placement or mounting edits first.</Text>
      <Text size="sm" c="dimmed">Freezing does not establish fit, electrical compatibility or manufacturing qualification.</Text>
      {!accessError && capture.isError && <Alert color="red">{capture.error.message}</Alert>}
    </>}
    {!accessError && <TextInput label="Inspect assembly snapshot ID" value={inspectedSnapshot ?? ""} onChange={(e) => { setFrozenRevision(null); setSnapshotId(e.currentTarget.value || null); }} />}
    {!accessError && inspectedSnapshot && <AssemblyInspector key={inspectedSnapshot} snapshotId={inspectedSnapshot} />}
  </Stack>;
}

function AssemblyEditor({ draft: currentDraft, definitions, onSaved, canEdit, onDenied, authorized, acceptedCapture }: { draft: Draft; definitions: Definition[]; onSaved: (draft: Draft) => Promise<void>; canEdit: boolean; onDenied: (error: Error) => void; authorized: boolean; acceptedCapture: Draft | null }) {
  const [draft, setDraft] = useState(currentDraft);
  useEffect(() => { if (acceptedCapture?.draft_id === currentDraft.draft_id) setDraft(acceptedCapture); }, [acceptedCapture, currentDraft.draft_id]);
  const requestEpoch = useRef(0);
  const isAuthorized = useRef(authorized); isAuthorized.current = authorized;
  useEffect(() => { requestEpoch.current++; return () => { requestEpoch.current++; }; }, [authorized]);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const pendingSave = useRef<{ fingerprint: string; key: string } | null>(null);
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
  const visibleChild = child.isError || child.isFetching ? null : child.data;
  const save = useMutation({ mutationFn: async (assembly: Assembly) => {
    const epoch = requestEpoch.current;
    const fingerprint = JSON.stringify([draft.state, assembly]);
    if (!pendingSave.current || pendingSave.current.fingerprint !== fingerprint) pendingSave.current = { fingerprint, key: randomUUID() };
    try {
      return { data: await command<Draft>("assembly.update", { draft_id: draft.draft_id, assembly }, draft.state, pendingSave.current.key), epoch };
    } catch (error) {
      if (epoch !== requestEpoch.current || !isAuthorized.current) return { data: null, epoch };
      throw error;
    }
  }, onSuccess: async ({ data, epoch }) => {
    if (!data || epoch !== requestEpoch.current || !isAuthorized.current) return;
    setDraft(data); pendingSave.current = null; await onSaved(data);
  }, onError: onDenied });
  useEffect(() => { if (!authorized) save.reset(); }, [authorized]);
  const assembly = draft.content.assembly;
  const externalTarget = relationshipKind === "source_derivation" || relationshipKind === "procurement";
  function updateOccurrence(index: number, changes: Partial<Occurrence>) { save.mutate({ ...assembly, occurrences: assembly.occurrences.map((occ, i) => i === index ? { ...occ, ...changes } : occ) }); }
  if (!canEdit) return authorized ? <Stack><Text>Read-only assembly draft {currentDraft.draft_id} · {currentDraft.state}</Text><MountingDetails relationships={currentDraft.content.assembly.relationships} />{currentDraft.content.assembly.occurrences.map(occurrence => <Text key={occurrence.local_id}>{occurrence.local_id} · {occurrence.revision_id} · canonical placement {occurrence.placement?.status === 'known' ? `${occurrence.placement.translation?.join(', ')} mm; rotation quaternion ${occurrence.placement.rotation_xyzw?.join(', ')}` : 'Unknown'}</Text>)}</Stack> : null;
  return <Stack>
    {authorized && currentDraft.state !== draft.state && <Alert color="yellow">A newer assembly draft is available. Unsaved fields retain their original state token. Deliberately load the latest draft before editing it.</Alert>}
    {authorized && currentDraft.state !== draft.state && <Button onClick={() => { setDraft(currentDraft); setEditorEpoch(epoch => epoch + 1); pendingSave.current = null; void onSaved(currentDraft); }}>Load latest assembly draft</Button>}
    {authorized && <Text size="sm">Draft {draft.draft_id} · {draft.state}</Text>}
    {authorized && save.isError && <Alert color="red">{save.error.message}</Alert>}
    <Card withBorder><Stack>
      {authorized && <Title order={3}>Occurrences</Title>}
      {assembly.occurrences.map((occ, index) => <PlacementEditor key={`${occ.local_id}:${editorEpoch}`} occurrence={occ} busy={save.isPending} authorized={authorized} onSave={(changes) => updateOccurrence(index, changes)} onRemove={() => save.mutate({ ...assembly, occurrences: assembly.occurrences.filter((_, i) => i !== index) })} />)}
      {authorized && <>
      <TextInput label="Stable local occurrence ID" description="A lowercase ID for this use, independent of its displayed reference." value={localId} onChange={(e) => setLocalId(e.currentTarget.value)} />
      <TextInput label="Display reference" value={displayRef} onChange={(e) => setDisplayRef(e.currentTarget.value)} />
      <Select label="Child definition" searchable value={childDefinition} data={definitions.map((d) => ({ value: d.definition_id, label: `${d.name} (${d.kind})` }))} onChange={(id) => { setChildDefinition(id); setRevisionId(null); setChildOffset(0); }} />
      {child.isError && <Alert color="red">{child.error.message}</Alert>}
      <Select label="Pinned child revision" value={revisionId} data={newestFirst(visibleChild?.revisions ?? []).map((r) => ({ value: r.revision_id, label: revisionOptionLabel(visibleChild?.name, r.number) }))} onChange={setRevisionId} />
      {visibleChild && <Group><Button disabled={childOffset === 0} onClick={() => { setChildOffset(Math.max(0, childOffset - 50)); setRevisionId(null); }}>Previous child revisions</Button><Button disabled={visibleChild.revisions.length < 50} onClick={() => { setChildOffset(childOffset + 50); setRevisionId(null); }}>Next child revisions</Button></Group>}
      <Button disabled={!localId || !revisionId} loading={save.isPending} onClick={() => save.mutate({ ...assembly, occurrences: [...assembly.occurrences, { local_id: localId, revision_id: revisionId!, display_ref: displayRef, placement: { status: "unknown" } }] })}>Add occurrence</Button>
      </>}
    </Stack></Card>
    <MountingEditor key={editorEpoch} draft={draft} busy={save.isPending} authorized={authorized} onSave={assembly => save.mutate(assembly)} onDenied={onDenied} />
    {authorized && <><Card withBorder><Stack>
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
      {assembly.assignments?.map((a) => <Group key={addressKey(a.path)}><Text>{a.path.join("/")} · {a.assignments.firmware_revision_id ? <RevisionLabel id={a.assignments.firmware_revision_id} role="Firmware" /> : "Unassigned"}</Text><Button size="xs" variant="subtle" onClick={() => save.mutate({ ...assembly, assignments: assembly.assignments?.filter((other) => addressKey(other.path) !== addressKey(a.path)) })}>Clear assignment for {a.path.join("/")}</Button></Group>)}
      <TextInput label="Firmware occurrence path" value={assignmentPath} onChange={(e) => setAssignmentPath(e.currentTarget.value)} />
      <TextInput label="Exact firmware revision ID" value={firmwareRevision} onChange={(e) => setFirmwareRevision(e.currentTarget.value)} />
      <Button disabled={!assignmentPath || !firmwareRevision} loading={save.isPending} onClick={() => { const path = assignmentPath.split("/"); save.mutate({ ...assembly, assignments: [...(assembly.assignments ?? []).filter((a) => addressKey(a.path) !== addressKey(path)), { path, assignments: { firmware_revision_id: firmwareRevision } }] }); }}>Assign firmware to this occurrence</Button>
    </Stack></Card></>}
  </Stack>;
}

export function AssemblyInspector({ snapshotId }: { snapshotId: string }) {
  const [selection, setSelection] = useState<string | null>(null);
  const [featureId, setFeatureId] = useState("");
  const [arranged, setArranged] = useState(false);
  const projection = useQuery({ queryKey: ["assembly-projection", snapshotId], queryFn: () => read<Projection>(`assemblies/snapshots/${snapshotId}`) });
  const visible = projection.isError || projection.isFetching ? null : projection.data;
  useEffect(() => { if (projection.isError) { setSelection(null); setFeatureId(''); setArranged(false); } }, [projection.isError]);
  const selected = visible?.occurrences.find((node) => addressKey(node.address.path) === selection);
  return <Stack>
    <Title order={3}>Assembly snapshot</Title>
    <Button disabled={projection.isFetching} onClick={() => { void projection.refetch(); }}>Refresh canonical assembly inspection</Button>
    {projection.isError && <Alert color="red">{projection.error.message}</Alert>}
    {visible && <>
      <Text size="sm">Snapshot {visible.snapshot_id} · SHA-256 {visible.sha256}</Text>
      <Tabs defaultValue="tree"><Tabs.List><Tabs.Tab value="tree">Occurrence tree</Tabs.Tab><Tabs.Tab value="table">Assembly contents</Tabs.Tab><Tabs.Tab value="arrangement">View arrangement</Tabs.Tab></Tabs.List>
        <Tabs.Panel value="tree"><Stack gap="xs">{visible.occurrences.map((node) => <Button key={addressKey(node.address.path)} variant={selection === addressKey(node.address.path) ? "filled" : "light"} aria-pressed={selection === addressKey(node.address.path)} onClick={() => setSelection(addressKey(node.address.path))}>{node.address.path.join("/")} · {node.display_ref || node.name}</Button>)}</Stack></Tabs.Panel>
        <Tabs.Panel value="table"><Table><Table.Thead><Table.Tr><Table.Th>Contextual path</Table.Th><Table.Th>Display reference</Table.Th><Table.Th>Pinned revision</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{visible.occurrences.map((node) => <Table.Tr key={addressKey(node.address.path)} data-selected={selection === addressKey(node.address.path)}><Table.Td><Button variant="subtle" onClick={() => setSelection(addressKey(node.address.path))}>{node.address.path.join("/")}</Button></Table.Td><Table.Td>{node.display_ref}</Table.Td><Table.Td><RevisionLabel id={node.revision_id} /></Table.Td></Table.Tr>)}</Table.Tbody></Table></Tabs.Panel>
        <Tabs.Panel value="arrangement"><Stack><Checkbox label="Spread occurrences for inspection" checked={arranged} onChange={(e) => setArranged(e.currentTarget.checked)} /><Text size="sm">This is a display layout. Canonical placement stays in the pinned snapshot. Geometry and clearances are not evaluated.</Text><Group align="start" style={{ gap: arranged ? 48 : 12 }}>{visible.occurrences.map((node) => <Card key={addressKey(node.address.path)} withBorder><Button variant={selection === addressKey(node.address.path) ? "filled" : "light"} onClick={() => setSelection(addressKey(node.address.path))}>{node.address.path.join("/")}</Button><Text>{node.display_ref || node.name}</Text></Card>)}</Group></Stack></Tabs.Panel>
      </Tabs>
      {selected && <Card withBorder><Stack gap="xs">
        <Title order={4}>Selected occurrence</Title>
        <Text>Context: {selected.address.path.join("/")}</Text><Text>Display reference: {selected.display_ref}</Text>
        <Text><RevisionLabel id={selected.revision_id} extraPins={[{ label: 'Definition ID', value: selected.definition_id }]} /></Text>
        <Text>Child snapshot SHA-256: {selected.snapshot_sha256}</Text>
        <Text>Firmware revision: {selected.assignments.firmware_revision_id ? <RevisionLabel id={selected.assignments.firmware_revision_id} /> : "Unassigned"}</Text>
        <Text>Canonical placement: {selected.placement.status === "known" ? `${selected.placement.translation?.join(", ")} mm` : "Unknown"}</Text>
        <Text>Canonical rotation quaternion (X, Y, Z, W): {selected.placement.status === "known" ? selected.placement.rotation_xyzw?.join(", ") : "Unknown"}</Text>
        <TextInput label="Selected stable feature ID" value={featureId} onChange={(e) => setFeatureId(e.currentTarget.value)} />
        {featureId && <Text>Feature address: {snapshotId} / {selected.address.path.join("/")} / {featureId} · Existence and compatibility not evaluated</Text>}
      </Stack></Card>}
      <MountingDetails relationships={visible.relationships} />
      <Title order={4}>Relationships</Title>
      {visible.relationships.map((r) => <Text key={`${addressKey(r.context_path)}:${r.local_id}`}>{r.context_path.join("/") || "Root"} · {r.local_id} · {r.kind}</Text>)}
    </>}
  </Stack>;
}
