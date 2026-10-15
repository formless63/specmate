import { ReadOnlyNote, usePermission, InspectionScope } from '../../lib/permissions';
import { Alert, Button, Card, Group, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadFrozenStock } from '../wire-stock/viewer-api';
import { authorityDenied, command, emptyProfile, postRead, read, type Definition, type Draft, type Frozen, type Identity, type Profile, type Request } from './api';
import { conductiveChoices, FormulaInspection, ProfileEditor } from './ProfileEditor';
import { RevisionChoice } from './RevisionChoice';
import { CutCalculation } from './CutCalculation';
import { revisionOptionLabel } from "../../lib/revision-labels";
import { RevisionLabel } from "../../lib/IdentityLabel";
import { ContinueDraftButton } from '../scope/ContinueDraftButton';
import { definitionIn, referenceFromProject, useOpenNewest, useOpenProbed } from '../scope/openProbed';

/** Library cut preparation profiles. `projectId` is optional context: new profiles are then also referenced by that project. */
export function PreparationPanel({ projectId = null }: { projectId?: string | null }) { return <Workspace key={projectId ?? "library"} projectId={projectId} />; }
function Workspace({ projectId }: { projectId: string | null }) {
  const editGate = usePermission('design.edit');
  // Saving a new profile or plan creates a workspace item (item.create); revising one needs design.edit.
  const createGate = usePermission('item.create');
  const freezeGate = usePermission('design.freeze');
  const cache = useQueryClient();
  const [name, setName] = useState('');
  const [profile, setProfile] = useState<Profile>(emptyProfile());
  const [current, setCurrent] = useState<Draft | null>(null);
  const [definition, setDefinition] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [blocked, setBlocked] = useState(false);
  // Browse/replace selections fence late writes; only an actual editor replacement
  // makes an older computation denial unrelated to retained editor evidence.
  const generation = useRef(0);
  const edits = useRef(0);
  const authorityGeneration = useRef(0);
  const deniedApplication = useRef<Request | null>(null);
  const changeProfile = (value: Profile) => { edits.current += 1; setProfile(value); };
  const computationDenied = useCallback((request: Request, scope: number) => { if (scope !== authorityGeneration.current) return; deniedApplication.current = request; setBlocked(true); }, []);
  const definitions = useQuery({ queryKey: ['preparation-definitions', projectId], queryFn: () => read<Definition[]>('workspace/definitions') });
  const identity = useQuery({ queryKey: ['preparation-identity', definition, offset], queryFn: () => read<Identity>(`catalog/definitions/${definition}?offset=${offset}`), enabled: !!definition });
  const stock = useQuery({ queryKey: ['preparation-stock', profile.stock_revision_id], queryFn: () => loadFrozenStock(profile.stock_revision_id), enabled: !!profile.stock_revision_id });
  const onError = (error: Error) => { if (authorityDenied(error)) setBlocked(true); };
  const refresh = useMutation({ mutationFn: async () => {
    await read('workspace/definitions');
    if (current) await read(`preparation/drafts/${current.draft_id}`);
    if (profile.stock_revision_id) await postRead('authority', profile);
    if (revisionId) await read(`preparation/revisions/${revisionId}`);
    if (deniedApplication.current) {
      await read(`revisions/${deniedApplication.current.revision_id}/snapshot`);
      for (const application of deniedApplication.current.applications) await read(`preparation/revisions/${application.profile_revision_id}`);
    }
    if (definition) await cache.refetchQueries({ queryKey: ['preparation-identity', definition] }, { throwOnError: true });
    await cache.invalidateQueries({ queryKey: ['preparation-definitions', projectId] });
    await cache.invalidateQueries({ queryKey: ['preparation-stock', profile.stock_revision_id] });
  }, onSuccess: () => { deniedApplication.current = null; setBlocked(false); } });
  const refreshAccess = useCallback(() => refresh.mutate(), [refresh.mutate]);
  useEffect(() => { if (!blocked) return; window.addEventListener('focus', refreshAccess); return () => window.removeEventListener('focus', refreshAccess); }, [blocked, refreshAccess]);
  const load = useMutation({
    mutationFn: ({ draftId }: { draftId: string; generation: number; authorityGeneration: number; edits: number }) => read<Draft>(`preparation/drafts/${draftId}`),
    onSuccess: (data, submitted) => { if (submitted.generation !== generation.current || submitted.edits !== edits.current) return; authorityGeneration.current += 1; setRevisionId(null); setCurrent(data); setProfile(data.content.preparation_profile); },
    onError: (_error, submitted) => { if (submitted.authorityGeneration === authorityGeneration.current) setBlocked(true); },
  });
  const save = useMutation({
    mutationFn: (submitted: { current: Draft | null; profile: Profile; name: string; generation: number; authorityGeneration: number; edits: number }) => command<Draft>(submitted.current ? 'preparation.update' : 'preparation.create', submitted.current ? { draft_id: submitted.current.draft_id, profile: submitted.profile } : { name: submitted.name, profile: submitted.profile }, submitted.current?.state),
    onSuccess: async (data, submitted) => {
      if (submitted.generation !== generation.current) return;
      setCurrent(data);
      if (submitted.edits === edits.current) setProfile(data.content.preparation_profile);
      setDefinition(data.definition_id); setDraftId(data.draft_id);
      await cache.invalidateQueries({ queryKey: ['preparation-definitions', projectId] });
      await cache.invalidateQueries({ queryKey: ['preparation-identity', data.definition_id] });
      if (!submitted.current) await referenceFromProject(projectId, data.definition_id, 'preparation profile');
    },
    onError: (error, submitted) => { if (submitted.authorityGeneration === authorityGeneration.current) onError(error); },
  });
  const freeze = useMutation({
    mutationFn: (submitted: { current: Draft; generation: number; authorityGeneration: number }) => command<{ revision_id: string; draft: Draft }>('preparation.freeze', { draft_id: submitted.current.draft_id }, submitted.current.state),
    onSuccess: async (data, submitted) => { if (submitted.generation !== generation.current) return; setRevisionId(data.revision_id); setCurrent(c => c ? { ...c, state: data.draft.state } : c); await cache.invalidateQueries({ queryKey: ['preparation-identity', submitted.current.definition_id] }); },
    onError: (error, submitted) => { if (submitted.authorityGeneration === authorityGeneration.current) onError(error); },
  });
  const pick = (id: string | null) => { generation.current += 1; setDefinition(id); setDraftId(null); setRevisionId(null); setOffset(0); };
  // Opening from the Library selects the newest draft to load (unsaved values stay until loaded) or the latest revision.
  const openNewest = useOpenNewest(identity.data, setDraftId, setRevisionId);
  useOpenProbed(definitionIn(definitions.data, ['preparation_profile']), (id) => { pick(id); openNewest(id); });
  const denied = blocked || definitions.isError || identity.isError || stock.isError;
  return <Stack><Title order={2}>Preparation arithmetic</Title><Text>Freeze reviewed formulas separately from illustrative workshop practices. Exact applications compute suggestions without changing stock, cable or harness declarations. Prepend, physical clearance and qualification remain unevaluated.</Text>
    {[definitions.error, identity.error, stock.error, load.error, save.error, freeze.error, refresh.error].filter(Boolean).map((error, i) => <Alert key={i} color="red">{error!.message}</Alert>)}
    {denied && <Alert color="red"><Stack><Text>Preparation source access must be rechecked before retained content is shown. Unsaved values and their editing token are retained.</Text><Button loading={refresh.isPending} onClick={refreshAccess}>Refresh preparation access</Button></Stack></Alert>}
    {!denied && <><Card withBorder><Stack><Title order={3}>{current ? 'Edit preparation draft' : 'New preparation profile'}</Title>
      {current ? <Text>{current.draft_id} · {current.state}</Text> : <InspectionScope permission="item.create"><TextInput label="Preparation profile name" value={name} onChange={e => setName(e.currentTarget.value)} /></InspectionScope>}
      <InspectionScope permission={current ? 'design.edit' : 'item.create'}>
      <RevisionChoice label="Preparation stock" kinds={['wire_stock']} value={profile.stock_revision_id} onChange={stock_revision_id => changeProfile({ ...profile, stock_revision_id })} definitions={definitions.data ?? []} />
      <ProfileEditor value={profile} onChange={changeProfile} choices={stock.data ? conductiveChoices(stock.data.structure) : []} />
      </InspectionScope>
      <Group><Button disabled={load.isPending || freeze.isPending || !profile.stock_revision_id || (!current && !name.trim())} loading={save.isPending} {...(current ? editGate : createGate).props} onClick={() => save.mutate({ current, profile, name, generation: generation.current, authorityGeneration: authorityGeneration.current, edits: edits.current })}>Save preparation profile</Button>{current && <Button disabled={save.isPending || load.isPending} loading={freeze.isPending} {...freezeGate.props} onClick={() => freeze.mutate({ current, generation: generation.current, authorityGeneration: authorityGeneration.current })}>Freeze preparation profile</Button>}<Button variant="subtle" onClick={() => { generation.current += 1; authorityGeneration.current += 1; setCurrent(null); changeProfile(emptyProfile()); setName(''); setDefinition(null); setDraftId(null); setRevisionId(null); }}>New preparation profile</Button></Group><ReadOnlyNote permission={current ? "design.edit" : "item.create"}>Saving and freezing preparation profiles are unavailable.</ReadOnlyNote>
    </Stack></Card>
    <Select label="Existing preparation definition" data={(definitions.data ?? []).filter(d => d.kind === 'preparation_profile').map(d => ({ value: d.definition_id, label: d.name }))} value={definition} onChange={pick} />
    {identity.data && <><Select label="Preparation draft to load" value={draftId} data={identity.data.drafts.map(d => ({ value: d.draft_id, label: `${d.draft_id} · ${d.state}` }))} onChange={id => { generation.current += 1; setDraftId(id); }} /><Button disabled={!draftId} loading={load.isPending} onClick={() => { generation.current += 1; load.mutate({ draftId: draftId!, generation: generation.current, authorityGeneration: authorityGeneration.current, edits: edits.current }); }}>Load preparation draft</Button><ContinueDraftButton drafts={identity.data.drafts} revisionId={revisionId} draftId={current?.draft_id ?? null} onOpen={id => { generation.current += 1; setDraftId(id); load.mutate({ draftId: id, generation: generation.current, authorityGeneration: authorityGeneration.current, edits: edits.current }); }} /><Select label="Frozen preparation revision" value={revisionId} data={identity.data.revisions.map((r) => ({ value: r.revision_id, label: revisionOptionLabel(identity.data.name, r.number) }))} onChange={id => { generation.current += 1; setRevisionId(id); }} /><Group><Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous preparation history</Button><Button disabled={Math.max(identity.data.drafts.length, identity.data.revisions.length) < 50} onClick={() => setOffset(offset + 50)}>Next preparation history</Button></Group></>}
    {revisionId && <FrozenProfile key={revisionId} revisionId={revisionId} onDenied={() => setBlocked(true)} />}
    <CutCalculation key={authorityGeneration.current} definitions={definitions.data ?? []} onDenied={computationDenied} authorityScope={authorityGeneration.current} />
    </>}
  </Stack>;
}
export function FrozenProfile({ revisionId, onDenied }: { revisionId: string; onDenied?: () => void }) {
  const query = useQuery({ queryKey: ['preparation-frozen', revisionId], queryFn: () => read<Frozen>(`preparation/revisions/${revisionId}`) });
  useEffect(() => { if (query.isError) onDenied?.(); }, [query.isError, onDenied]);
  return <Card withBorder><Stack><Title order={3}>Frozen preparation profile</Title><Button loading={query.isFetching} onClick={() => query.refetch()}>Refresh frozen preparation access</Button>{query.isError && <Alert color="red">{query.error.message}</Alert>}{query.data && !query.isError && !query.isFetching && <><Text><RevisionLabel id={query.data.revision_id} role="Profile" sha256={query.data.sha256} /></Text><Text><RevisionLabel id={query.data.profile.stock_revision_id} role="Stock" sha256={query.data.stock_sha256} /></Text>{query.data.profile.formulas.map(f => <FormulaInspection key={f.local_id} formula={f} />)}</>}</Stack></Card>;
}
