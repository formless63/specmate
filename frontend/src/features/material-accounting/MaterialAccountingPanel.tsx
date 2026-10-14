import { ReadOnlyNote, usePermission } from '../../lib/permissions';
import { Alert, Button, Card, Group, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BuildSheet } from './BuildSheet';
import { PlanEditor } from './PlanEditor';
import { referenceKey, type ReferenceSelections } from './ReferenceChoice';
import { authorityDenied, checkAuthority, command, emptyPlan, read, type Definition, type Draft, type Identity, type Plan } from './api';
import { revisionOptionLabel } from "../../lib/revision-labels";

export function MaterialAccountingPanel({ projectId }: { projectId: string }) { return <Workspace key={projectId} projectId={projectId} />; }
function Workspace({ projectId }: { projectId: string }) {
  const editGate = usePermission('design.edit');
  // Saving a new profile or plan creates a workspace item (item.create); revising one needs design.edit.
  const createGate = usePermission('item.create');
  const freezeGate = usePermission('design.freeze');
  const cache = useQueryClient();
  const [name, setName] = useState(''); const [plan, setPlan] = useState<Plan>(emptyPlan);
  const [current, setCurrent] = useState<Draft | null>(null); const [definition, setDefinition] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null); const [revisionId, setRevisionId] = useState<string | null>(null);
  const [references, setReferences] = useState<ReferenceSelections>({});
  const [offset, setOffset] = useState(0); const [blocked, setBlocked] = useState(false);
  const edits = useRef(0); const generation = useRef(0); const authorityEpoch = useRef(0);
  const denied = useCallback((version: number) => {
    if (version !== generation.current) return;
    authorityEpoch.current += 1; setBlocked(true);
    cache.removeQueries({ queryKey: ['material-sheet'] });
  }, [cache]);
  const fail = (error: Error, version: number) => { if (authorityDenied(error)) denied(version); };
  const definitions = useQuery({ queryKey: ['material-definitions', projectId], queryFn: async () => {
    const version = generation.current;
    try { return await read<Definition[]>('workspace/definitions'); }
    catch (error) { fail(error as Error, version); throw error; }
  } });
  const identity = useQuery({ queryKey: ['material-identity', definition, offset], queryFn: async () => {
    const version = generation.current;
    try { return await read<Identity>(`catalog/definitions/${definition}?offset=${offset}`); }
    catch (error) { fail(error as Error, version); throw error; }
  }, enabled: !!definition && !blocked });
  const load = useMutation({ mutationFn: ({ id, version, edit }: { id: string; version: number; edit: number }) => read<Draft>(`material-accounting/drafts/${id}`).then(data => ({ data, version, edit })), onSuccess: ({ data, version, edit }) => {
    if (version !== generation.current || edit !== edits.current) return;
    generation.current += 1; authorityEpoch.current += 1; setCurrent(data); setPlan(data.content.material_plan); setDefinition(data.definition_id); setDraftId(data.draft_id); setRevisionId(null); setReferences({}); setBlocked(false);
    save.reset(); freeze.reset(); refresh.reset(); cache.removeQueries({ queryKey: ['material-sheet'] });
  }, onError: (error, input) => fail(error, input.version) });
  const save = useMutation({ mutationFn: ({ version, payload, draft }: { version: number; payload: Plan; draft: Draft | null }) => command<Draft>(draft ? 'material_plan.update' : 'material_plan.create', draft ? { draft_id: draft.draft_id, plan: payload } : { name, plan: payload }, draft?.state).then(data => ({ data, version })), onSuccess: ({ data, version }) => {
    if (version !== generation.current) return;
    setCurrent(data); setDefinition(data.definition_id); setDraftId(data.draft_id);
    cache.invalidateQueries({ queryKey: ['material-definitions', projectId] }); cache.invalidateQueries({ queryKey: ['material-identity', data.definition_id] });
  }, onError: (error, input) => fail(error, input.version) });
  const freeze = useMutation({ mutationFn: ({ draft, version }: { draft: Draft; version: number }) => command<{ revision_id: string; draft: Draft }>('material_plan.freeze', { draft_id: draft.draft_id }, draft.state).then(data => ({ data, version })), onSuccess: ({ data, version }) => {
    if (version !== generation.current) return;
    setCurrent(previous => previous ? { ...previous, state: data.draft.state } : previous); setRevisionId(data.revision_id); cache.invalidateQueries({ queryKey: ['material-identity', definition] });
  }, onError: (error, input) => fail(error, input.version) });
  const refresh = useMutation({ mutationFn: async ({ version, epoch }: { version: number; epoch: number }) => {
    // Fresh reads cover every retained choice without adopting a newer editing token.
    if (plan.subject_revision_id) await checkAuthority(plan);
    if (current) await read<Draft>(`material-accounting/drafts/${current.draft_id}`);
    if (draftId && draftId !== current?.draft_id) await read<Draft>(`material-accounting/drafts/${draftId}`);
    if (revisionId) await read(`material-accounting/revisions/${revisionId}`);
    const freshReferences = await Promise.all(Object.values(references).filter(reference => reference.definition).map(async reference => ({ reference, identity: await read<Identity>(`catalog/definitions/${reference.definition}?offset=${reference.offset}`) })));
    const freshIdentity = definition ? await read<Identity>(`catalog/definitions/${definition}?offset=${offset}`) : null;
    const freshDefinitions = await read<Definition[]>('workspace/definitions');
    return { version, epoch, freshIdentity, freshDefinitions, freshReferences };
  }, onSuccess: ({ version, epoch, freshIdentity, freshDefinitions, freshReferences }) => {
    if (version !== generation.current || epoch !== authorityEpoch.current) return;
    cache.setQueryData(['material-definitions', projectId], freshDefinitions);
    if (freshIdentity) cache.setQueryData(['material-identity', definition, offset], freshIdentity);
    for (const { reference, identity } of freshReferences) cache.setQueryData(referenceKey(reference, version), identity);
    setBlocked(false);
  }, onError: (error, input) => fail(error, input.version) });
  // Errors from read promises are fenced inside their query functions, including detached reads.
  useEffect(() => { if (blocked) cache.removeQueries({ queryKey: ['material-sheet'] }); }, [blocked, cache]);
  const pending = load.isPending || save.isPending || freeze.isPending;
  const sheetGeneration = generation.current;
  const discard = () => {
    generation.current += 1; authorityEpoch.current += 1; edits.current += 1;
    setBlocked(false); setCurrent(null); setPlan(emptyPlan()); setName(''); setDefinition(null); setDraftId(null); setRevisionId(null); setOffset(0); setReferences({});
    load.reset(); save.reset(); freeze.reset(); refresh.reset();
    cache.removeQueries({ queryKey: ['material-sheet'] }); cache.removeQueries({ queryKey: ['material-identity'] });
  };
  return <Stack><Title order={2}>Preparation material accounting</Title><Text>Keep installed cable material, selected cuts, extra waste, process consumables and procurement separate. Freeze a plan for an exact cable or harness; record actual observations against existing Inventory events.</Text>
    <Group><Button variant="subtle" onClick={discard}>Discard unsaved material values and start new</Button><Text size="sm">This clears the current editor and retained selections.</Text></Group>
    {blocked ? <Alert color="red"><Stack><Text>Material access must be refreshed before retained evidence is shown. Unsaved values and their original editing token are retained.</Text><Button loading={refresh.isPending} onClick={() => refresh.mutate({ version: generation.current, epoch: authorityEpoch.current })}>Refresh material accounting access</Button>{refresh.isError && <Text>{refresh.error.message}</Text>}</Stack></Alert> : <>
      <Card withBorder><Stack><Title order={3}>{current ? 'Edit material plan' : 'New material plan'}</Title>{current ? <Text>{current.draft_id} · {current.state}</Text> : <TextInput label="Material plan name" value={name} onChange={e => setName(e.currentTarget.value)} />}
        <PlanEditor references={references} onReference={(label, reference) => setReferences(previous => ({ ...previous, [label]: reference }))} generation={sheetGeneration} onDenied={() => denied(sheetGeneration)} value={plan} definitions={definitions.isError ? [] : definitions.data ?? []} onChange={next => { edits.current += 1; setPlan(next); }} />
        <Group><Button disabled={pending || !plan.subject_revision_id || (!current && !name.trim())} {...(current ? editGate : createGate).props} onClick={() => save.mutate({ version: generation.current, payload: plan, draft: current })}>Save material plan</Button><Button disabled={pending || !current} {...freezeGate.props} onClick={() => freeze.mutate({ draft: current!, version: generation.current })}>Freeze saved material plan</Button></Group><ReadOnlyNote permission={current ? "design.edit" : "item.create"}>Saving and freezing material plans are unavailable.</ReadOnlyNote><Text size="sm">Freeze captures the saved draft. Unsaved edits stay separate.</Text>
      </Stack></Card>
      <Select label="Existing material plan" value={definition} data={(definitions.isError ? [] : definitions.data ?? []).filter(d => d.kind === 'material_plan').map(d => ({ value: d.definition_id, label: d.name }))} onChange={id => { setDefinition(id); setDraftId(null); setRevisionId(null); setOffset(0); }} />
      {identity.data && !identity.isError && <><Select label="Material draft to load" value={draftId} data={identity.data.drafts.map(d => ({ value: d.draft_id, label: `${d.draft_id} · ${d.state}` }))} onChange={setDraftId} /><Button disabled={pending || !draftId} onClick={() => load.mutate({ id: draftId!, version: generation.current, edit: edits.current })}>Load material draft</Button><Select label="Frozen material revision" value={revisionId} data={identity.data.revisions.map((r) => ({ value: r.revision_id, label: revisionOptionLabel(identity.data.name, r.number) }))} onChange={setRevisionId} /><Group><Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>Earlier material history</Button><Button disabled={Math.max(identity.data.drafts.length, identity.data.revisions.length) < 50} onClick={() => setOffset(offset + 50)}>Later material history</Button></Group></>}
      {revisionId && <BuildSheet key={`${revisionId}:${sheetGeneration}`} revisionId={revisionId} editorGeneration={sheetGeneration} onDenied={() => denied(sheetGeneration)} />}
    </>}
    {[definitions, identity, load, save, freeze].map((q, i) => q.isError && <Alert color="red" key={i}>{q.error.message}</Alert>)}
  </Stack>;
}
