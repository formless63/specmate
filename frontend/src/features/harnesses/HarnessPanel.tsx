import { ReadOnlyNote, usePermission } from "../../lib/permissions";
import { Alert, Button, Card, Group, NumberInput, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { authorityDenied } from '../cables/api';
import { HarnessEditor } from './HarnessEditor';
import { HarnessViews } from '../harness-views/HarnessViews';
import { command, read, initialHarness, terminalKey, terminalLabel, type Harness, type Definition, type Draft, type Identity, type Inspection } from './api';
import { revisionOptionLabel } from "../../lib/revision-labels";
import { RevisionLabel } from "../../lib/IdentityLabel";

export function HarnessPanel({ projectId }: { projectId: string }) { return <Workspace key={projectId} projectId={projectId} />; }
function Workspace({ projectId }: { projectId: string }) {
  const cache = useQueryClient();
  const editGate = usePermission('design.edit');
  const freezeGate = usePermission('design.freeze');
  const editorGeneration = useRef(0); const creationGeneration = useRef(0); const newDenialEpoch = useRef(0);
  const renderedCreation = creationGeneration.current;
  const [draftControl, setDraftControl] = useState<{ state: string; busy: boolean } | null>(null);
  const [acceptedFreeze, setAcceptedFreeze] = useState<{ draftId: string; expected: string; state: string } | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState<Harness>(initialHarness());
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [createSourceDenied, setCreateSourceDenied] = useState(false);
  const [draftSourceDenied, setDraftSourceDenied] = useState(false);
  const [newBlocked, setNewBlocked] = useState(false); const [freezeDenied, setFreezeDenied] = useState(false);
  const newDeniedRefs = useRef(new Set<string>());
  const [inspectorDenied, setInspectorDenied] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const deniedRevisions = useRef(new Set<string>()); const inspectionEpoch = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const selected = useRef({ definitionId, draftId, revisionId }); selected.current = { definitionId, draftId, revisionId };
  const inspectorFailure = useCallback((revision: string, generation: number) => {
    if (!mounted.current || generation !== editorGeneration.current) return;
    deniedRevisions.current.add(revision); inspectionEpoch.current += 1; setInspectorDenied(true);
  }, []);
  const replaceEditor = () => { editorGeneration.current += 1; deniedRevisions.current.clear(); inspectionEpoch.current += 1; setInspectorDenied(false); setRestoreError(null); setRestoring(false); setFreezeDenied(false); setDraftSourceDenied(false); };
  const newReferenceDenied = useCallback((path: string) => { if (renderedCreation !== creationGeneration.current) return; newDeniedRefs.current.add(path); newDenialEpoch.current += 1; setNewBlocked(true); }, [renderedCreation]);
  const definitions = useQuery({ queryKey: ["harness-definitions", projectId], queryFn: () => read<Definition[]>(`projects/${projectId}/definitions`) });
  const identity = useQuery({ queryKey: ["harness-identity", definitionId, offset], queryFn: () => read<Identity>(`catalog/definitions/${definitionId}?offset=${offset}`), enabled: !!definitionId });
  const draft = useQuery({ queryKey: ["harness-draft", draftId], queryFn: () => read<Draft>(`harnesses/drafts/${draftId}`), enabled: !!draftId });
  const create = useMutation({ mutationFn: async ({ generation }: { generation: number }) => { const data = await command<Draft>("harness.create", { project_id: projectId, name, harness: value }); return { data, generation }; }, onSuccess: async ({ data, generation }) => {
    if (generation !== creationGeneration.current) return;
    replaceEditor(); setDefinitionId(data.definition_id); setDraftId(data.draft_id); setRevisionId(null); setOffset(0);
    await cache.invalidateQueries({ queryKey: ["harness-definitions", projectId] });
  }, onError: (reason, variables) => { if (variables.generation === creationGeneration.current && authorityDenied(reason)) { newDenialEpoch.current += 1; setNewBlocked(true); } } });
  const freeze = useMutation({ mutationFn: async ({ generation }: { generation: number }) => { const expected = draftControl?.state ?? draft.data?.state; const target = draftId!; const data = await command<{ revision_id: string; draft?: { state: string } }>("harness.freeze", { draft_id: target }, expected); return { data, generation, expected, target }; }, onSuccess: async ({ data, generation, expected, target }) => {
    if (generation !== editorGeneration.current) return;
    if (data.draft?.state && expected) setAcceptedFreeze({ draftId: target, expected, state: data.draft.state });
    setRevisionId(data.revision_id);
    await cache.invalidateQueries({ queryKey: ["harness-draft", draftId] });
    await cache.invalidateQueries({ queryKey: ["harness-identity", definitionId] });
  }, onError: (reason, variables) => { if (variables.generation === editorGeneration.current && authorityDenied(reason)) setFreezeDenied(true); } });
  async function recheckWorkspace() {
    const generation = editorGeneration.current; const epoch = inspectionEpoch.current;
    const target = selected.current; setRestoring(true); setRestoreError(null);
    try {
      await read(`projects/${projectId}/definitions`);
      if (target.definitionId) await read(`catalog/definitions/${target.definitionId}`);
      if (target.draftId) await read(`harnesses/drafts/${target.draftId}`);
      for (const revision of new Set([...deniedRevisions.current, ...(target.revisionId ? [target.revisionId] : [])])) await read(`harnesses/revisions/${revision}`);
      if (!mounted.current || generation !== editorGeneration.current || epoch !== inspectionEpoch.current || (target.definitionId !== selected.current.definitionId || target.draftId !== selected.current.draftId || target.revisionId !== selected.current.revisionId)) return false;
      deniedRevisions.current.clear(); setInspectorDenied(false); setFreezeDenied(false);
      return true;
    } catch (reason) { if (mounted.current && generation === editorGeneration.current) setRestoreError(reason instanceof Error ? reason.message : 'Harness authority unavailable'); return false; }
    finally { if (mounted.current && generation === editorGeneration.current) setRestoring(false); }
  }
  const currentDefinitions = definitions.isError ? [] : definitions.data ?? [];
  const workspaceDenied = definitions.isError || identity.isError;
  return <Stack>
    <Button variant="subtle" onClick={() => { replaceEditor(); setDraftId(null); setRevisionId(null); }}>Discard retained Harness editor</Button><Text>Discarding closes the selected draft and its unsaved declarations.</Text>
    <Title order={2}>Branched harnesses</Title>
    <Text>Physical sections count original stock pieces once. Segments and breakout declarations preserve feature identity; joints and shield bonds require explicit targets and a basis. Continuity and physical qualification remain unevaluated.</Text>
    <Card withBorder><Stack>
      <Title order={3}>New reusable definition</Title>
      {newBlocked && <Alert>New Harness access is denied. Retained unsaved declarations are hidden. Starting New discards them.</Alert>}
      {!newBlocked && <><TextInput label="Definition name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
      <HarnessEditor value={value} onChange={setValue} definitions={currentDefinitions} onAuthorityChange={setCreateSourceDenied} onReferenceDenied={newReferenceDenied} />
      <Button disabled={!name.trim() || definitions.isError || createSourceDenied} loading={create.isPending} {...editGate.props} onClick={() => create.mutate({ generation: creationGeneration.current })}>Create harness draft</Button><ReadOnlyNote permission="design.edit">Creating drafts is unavailable.</ReadOnlyNote></>}
      <Button variant="subtle" onClick={() => { creationGeneration.current += 1; setValue(initialHarness()); setName(""); setNewBlocked(false); setCreateSourceDenied(false); newDeniedRefs.current.clear(); }}>New Harness: discard unsaved creation</Button>
      {newBlocked && <Button onClick={() => { void (async () => { try { const generation = creationGeneration.current; const epoch = newDenialEpoch.current; await read("harnesses/authority", value); for (const path of newDeniedRefs.current) await read(path); if (generation !== creationGeneration.current || epoch !== newDenialEpoch.current) return; newDeniedRefs.current.clear(); setNewBlocked(false); } catch { /* Retain denial and unsaved state. */ } })(); }}>Restore new Harness access</Button>}
      {create.isError && <Alert color="red">{create.error.message}</Alert>}
    </Stack></Card>
    {definitions.isError && <Alert color="red">{definitions.error.message}</Alert>}
    <Select label="Existing harness definition" searchable data={currentDefinitions.filter((d) => d.kind === "harness").map((d) => ({ value: d.definition_id, label: `${d.name} (${d.kind})` }))} value={definitions.isError ? null : definitionId} disabled={definitions.isError} onChange={(id) => { if (id !== definitionId) replaceEditor(); setDefinitionId(id); setDraftId(null); setRevisionId(null); setOffset(0); }} />
    {identity.isError && <Alert color="red">{identity.error.message}</Alert>}
    {identity.data && !workspaceDenied && <>
      <Select label="Edit harness draft" value={draftId} onChange={id => { if (id !== draftId) replaceEditor(); setDraftId(id); }} data={identity.data.drafts.map((d) => ({ value: d.draft_id, label: `${d.draft_id} · ${d.state}` }))} />
      <Select label="Inspect frozen harness" value={revisionId} onChange={setRevisionId} data={identity.data.revisions.map((r) => ({ value: r.revision_id, label: revisionOptionLabel(identity.data.name, r.number) }))} />
      <Group><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous revisions</Button><Button disabled={Math.max(identity.data.revisions.length, identity.data.drafts.length) < 50} onClick={() => setOffset(offset + 50)}>Next revisions</Button></Group>
    </>}
    {inspectorDenied && <Alert color="red">Frozen Harness access must be rechecked before retained draft declarations or inspection are shown.</Alert>}
    {restoreError && <Alert color="red">{restoreError}</Alert>}
    {inspectorDenied && !draft.data && <Button loading={restoring} onClick={() => { void recheckWorkspace(); }}>Restore Harness inspection access</Button>}
    {draft.isError && <Alert color="red">{draft.error.message}</Alert>}
    {(workspaceDenied || draft.isError) && <Button onClick={() => { void cache.refetchQueries({ queryKey: ["harness-definitions", projectId] }); void cache.refetchQueries({ queryKey: ["harness-identity", definitionId] }); void cache.refetchQueries({ queryKey: ["harness-draft", draftId] }); }}>Refresh Harness workspace access</Button>}
    {draft.data && <><DraftEditor onControlChange={setDraftControl} acceptedFreeze={acceptedFreeze} externalDenied={freezeDenied || inspectorDenied} onRestoreAuthority={recheckWorkspace} onRestored={() => setFreezeDenied(false)} hidden={draft.isError || workspaceDenied} key={draft.data.draft_id} draft={draft.data} definitions={currentDefinitions} onAuthorityChange={setDraftSourceDenied} onSaved={async () => { await cache.invalidateQueries({ queryKey: ["harness-draft", draftId] }); }} />{!draft.isError && !workspaceDenied && <Button disabled={draftSourceDenied || draftControl?.busy} loading={freeze.isPending} {...freezeGate.props} onClick={() => freeze.mutate({ generation: editorGeneration.current })}>Freeze harness revision</Button>}</>}
    {freeze.isError && <Alert color="red">{freeze.error.message}</Alert>}
    {revisionId && !workspaceDenied && !draft.isError && !draftSourceDenied && !freezeDenied && !inspectorDenied && <HarnessInspector key={revisionId} revisionId={revisionId} authorityScope={editorGeneration.current} onDenied={inspectorFailure} />}
  </Stack>;
}

export function DraftEditor({ draft, definitions, onSaved, onAuthorityChange, hidden = false, externalDenied = false, onRestored, onControlChange, acceptedFreeze, onRestoreAuthority }: { onRestoreAuthority?: () => Promise<boolean>; onControlChange?: (control: { state: string; busy: boolean }) => void; acceptedFreeze?: { draftId: string; expected: string; state: string } | null; externalDenied?: boolean; onRestored?: () => void; hidden?: boolean; draft: Draft; definitions: Definition[]; onSaved: () => Promise<void>; onAuthorityChange: (denied: boolean) => void }) {
  const editGate = usePermission('design.edit');
  const [sourceDenied, setSourceDenied] = useState(false); const [blocked, setBlocked] = useState(false);
  const [value, setValue] = useState(() => draft.content.harness ?? initialHarness());
  const [state, setState] = useState(draft.state); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true); const edits = useRef(0); const epoch = useRef(0); const deniedRefs = useRef(new Set<string>()); const deniedPayloads = useRef<Harness[]>([]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onControlChange?.({ state, busy }); }, [state, busy, onControlChange]);
  useEffect(() => { if (acceptedFreeze?.draftId === draft.draft_id) setState(current => current === acceptedFreeze.expected ? acceptedFreeze.state : current); }, [acceptedFreeze, draft.draft_id]);
  useEffect(() => { if (externalDenied) { epoch.current += 1; setBlocked(true); } }, [externalDenied]);
  useEffect(() => onAuthorityChange(sourceDenied || blocked), [sourceDenied, blocked, onAuthorityChange]);
  const refDenied = useCallback((path: string, reason: unknown) => { if (mounted.current) { setError(reason instanceof Error ? reason.message : 'Source unavailable'); deniedRefs.current.add(path); epoch.current += 1; setBlocked(true); } }, []);
  const change = (next: Harness) => { edits.current += 1; setValue(next); };
  async function save() {
    const submitted = value; const count = edits.current; setBusy(true); setError(null);
    try { const accepted = await command<Draft>('harness.update', { draft_id: draft.draft_id, harness: submitted }, state);
      if (!mounted.current) return;
      setState(accepted.state); if (count === edits.current) setValue(accepted.content?.harness ?? submitted);
      await onSaved();
    } catch (reason) { if (mounted.current) { setError(reason instanceof Error ? reason.message : 'Save failed'); if (authorityDenied(reason)) { deniedPayloads.current.push(submitted); epoch.current += 1; setBlocked(true); } } }
    finally { if (mounted.current) setBusy(false); }
  }
  async function restore() {
    const generation = epoch.current; setBusy(true); setError(null);
    try { await read(`harnesses/drafts/${draft.draft_id}`); await read('harnesses/authority', value); for (const payload of deniedPayloads.current) await read('harnesses/authority', payload); for (const path of deniedRefs.current) await read(path);
      if (!mounted.current || generation !== epoch.current) return;
      if (onRestoreAuthority && !await onRestoreAuthority()) return;
      if (mounted.current && generation === epoch.current) { deniedRefs.current.clear(); deniedPayloads.current = []; setBlocked(false); setSourceDenied(false); onRestored?.(); }
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'Access unavailable'); }
    finally { if (mounted.current) setBusy(false); }
  }
  if (hidden) return null;
  return <Card withBorder><Stack><Title order={3}>Edit draft</Title>{error && <Alert color="red">{error}</Alert>}
    {blocked || externalDenied ? <><Alert>Harness access must be restored. Unsaved declarations and their original token are retained.</Alert><Button loading={busy} onClick={() => { void restore(); }}>Restore Harness draft access</Button><Button disabled>Save harness draft</Button></> : <><Text size="sm">{state}</Text><fieldset disabled={busy} style={{ border: 0, padding: 0 }}><HarnessEditor value={value} onChange={change} definitions={definitions} onAuthorityChange={setSourceDenied} onReferenceDenied={refDenied} /><Button disabled={sourceDenied || busy} {...editGate.props} onClick={() => { void save(); }}>Save harness draft</Button></fieldset><ReadOnlyNote permission="design.edit">Saving harness drafts is unavailable.</ReadOnlyNote></>}
  </Stack></Card>;
}
export function HarnessInspector({ revisionId, authorityScope = 0, onDenied }: { revisionId: string; authorityScope?: number; onDenied?: (revisionId: string, generation: number) => void }) {
  const [quantity, setQuantity] = useState(1);
  const [terminal, setTerminal] = useState<string | null>(null);
  const result = useQuery({ queryKey: ['harness-inspect', revisionId, quantity], queryFn: async () => { const generation = authorityScope; try { return await read<Inspection>(`harnesses/revisions/${revisionId}?quantity=${quantity}`); } catch (reason) { if (authorityDenied(reason)) onDenied?.(revisionId, generation); throw reason; } }, retry: false });
  const value = result.isError || result.isFetching ? undefined : result.data;
  const relationships = value?.declared_relationships.filter(r => r.members.some(t => terminalKey(t) === terminal)) ?? [];
  return <Card withBorder><Stack><Title order={3}>Frozen harness inspection</Title><Text><RevisionLabel id={revisionId} /></Text>
    <Button loading={result.isFetching} onClick={() => { void result.refetch(); }}>Refresh frozen Harness access</Button>
    <NumberInput label="Harness quantity" min={1} max={1000000} allowDecimal={false} value={quantity} onChange={v => { if (typeof v === 'number' && Number.isInteger(v) && v >= 1) setQuantity(v); }} />
    {result.isError && <Alert color="red">{result.error.message}</Alert>}
    {value && <><Text>Planned stock pieces: {value.quantities.physical_piece_count ?? 'unknown'}; segment spans: {value.quantities.segment_count ?? 'unknown'}</Text><Text>Continuity: {value.continuity}. Compatibility: {value.compatibility}. Physical qualification: {value.physical_qualification}.</Text>
      <Table><Table.Thead><Table.Tr><Table.Th>Exact stock</Table.Th><Table.Th>Planned sections</Table.Th><Table.Th>Pieces</Table.Th><Table.Th>Planned cut total (mm)</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{value.quantities.stock.map(row => <Table.Tr key={row.stock_revision_id}><Table.Td><RevisionLabel id={row.stock_revision_id} /></Table.Td><Table.Td>{row.section_ids.join(', ')}</Table.Td><Table.Td>{row.piece_count ?? 'unknown'}</Table.Td><Table.Td>{row.planned_cut_total_mm ?? 'unknown'}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
      <Title order={4}>Formboard and build sheet</Title><HarnessViews key={`${revisionId}:${quantity}`} revisionId={revisionId} harness={value.harness} quantity={quantity} />
      <Title order={4}>Declared physical ends</Title>{value.harness.sections.map(section => <Stack key={section.local_id}><Text>Section {section.local_id}</Text>{!(section.physical_ends?.length) && <Text>Physical ends unknown; no segment directions imply end assignments.</Text>}{section.physical_ends?.map(end => <Text key={end.local_id}>{end.local_id} · {end.label ?? 'unknown label'} · {end.segment_ends.map(ref => `${ref.segment_id}/${ref.end}`).join(', ')} · endpoint {end.endpoint_id ?? 'unknown'} · {end.review}: {end.basis}</Text>)}</Stack>)}
      <Title order={4}>Segments and retained material</Title>{value.harness.segments.map(s => <Text key={s.local_id}>{s.local_id} → section {s.section_id}; conductive paths: {s.element_paths?.join(', ') ?? 'all declared conductive features'}</Text>)}
      <Title order={4}>Declared relationships</Title><Text>Only explicit relationships touching a selected terminal are shown. This does not trace longitudinal copper or establish measured continuity.</Text>
      <Select label="Inspect terminal declarations" searchable value={terminal} onChange={setTerminal} data={value.terminals.map(row => ({ value: terminalKey(row.terminal), label: `${terminalLabel(row.terminal)} (${row.feature_kind})` }))} />
      {terminal && (relationships.length ? relationships.map(r => <Card key={`${r.breakout_id ?? 'joint'}:${r.id}`} withBorder><Text>{r.kind}: {r.id}{r.breakout_id ? ` at ${r.breakout_id}` : ''}</Text><Text>{r.members.map(terminalLabel).join(' ↔ ')}</Text><Text>Basis: {r.basis}</Text></Card>) : <Text>No relationship declared for this terminal; continuity remains unknown.</Text>)}
      <Title order={4}>Breakout accountability</Title><Table><Table.Thead><Table.Tr><Table.Th>Breakout</Table.Th><Table.Th>Exact terminal</Table.Th><Table.Th>Declared fate</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{value.breakout_fates.map(row => <Table.Tr key={`${row.breakout_id}:${terminalKey(row.terminal)}`}><Table.Td>{row.breakout_id}</Table.Td><Table.Td>{terminalLabel(row.terminal)}</Table.Td><Table.Td>{row.fate}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
    </>}
  </Stack></Card>;
}
