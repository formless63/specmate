import { Alert, Button, Card, Group, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { loadFrozenStock } from '../wire-stock/viewer-api';
import { authorityDenied, command, emptyProfile, postRead, read, type Definition, type Draft, type Frozen, type Identity, type Profile } from './api';
import { conductiveChoices, FormulaInspection, ProfileEditor } from './ProfileEditor';
import { RevisionChoice } from './RevisionChoice';
import { CutCalculation } from './CutCalculation';

export function PreparationPanel({ projectId }: { projectId: string }) { return <Workspace key={projectId} projectId={projectId} />; }
function Workspace({ projectId }: { projectId: string }) {
  const cache = useQueryClient();
  const [name, setName] = useState('');
  const [profile, setProfile] = useState<Profile>(emptyProfile());
  const [current, setCurrent] = useState<Draft | null>(null);
  const [definition, setDefinition] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const definitions = useQuery({ queryKey: ['preparation-definitions', projectId], queryFn: () => read<Definition[]>(`projects/${projectId}/definitions`) });
  const identity = useQuery({ queryKey: ['preparation-identity', definition, offset], queryFn: () => read<Identity>(`catalog/definitions/${definition}?offset=${offset}`), enabled: !!definition });
  const stock = useQuery({ queryKey: ['preparation-stock', profile.stock_revision_id], queryFn: () => loadFrozenStock(profile.stock_revision_id), enabled: !!profile.stock_revision_id });
  const onError = (error: Error) => { if (authorityDenied(error)) setBlocked(true); };
  const refresh = useMutation({ mutationFn: async () => {
    await read(`projects/${projectId}/definitions`);
    if (current) await read(`preparation/drafts/${current.draft_id}`);
    if (profile.stock_revision_id) await postRead('authority', profile);
    if (revisionId) await read(`preparation/revisions/${revisionId}`);
    if (definition) await cache.refetchQueries({ queryKey: ['preparation-identity', definition] }, { throwOnError: true });
    await cache.invalidateQueries({ queryKey: ['preparation-definitions', projectId] });
    await cache.invalidateQueries({ queryKey: ['preparation-stock', profile.stock_revision_id] });
  }, onSuccess: () => setBlocked(false) });
  const refreshAccess = useCallback(() => refresh.mutate(), [refresh.mutate]);
  useEffect(() => { if (!blocked) return; window.addEventListener('focus', refreshAccess); return () => window.removeEventListener('focus', refreshAccess); }, [blocked, refreshAccess]);
  const load = useMutation({ mutationFn: () => read<Draft>(`preparation/drafts/${draftId}`), onSuccess: data => { setCurrent(data); setProfile(data.content.preparation_profile); }, onError: () => setBlocked(true) });
  const save = useMutation({ mutationFn: () => command<Draft>(current ? 'preparation.update' : 'preparation.create', current ? { draft_id: current.draft_id, profile } : { project_id: projectId, name, profile }, current?.state), onSuccess: async data => { setCurrent(data); setProfile(data.content.preparation_profile); setDefinition(data.definition_id); setDraftId(data.draft_id); await cache.invalidateQueries({ queryKey: ['preparation-definitions', projectId] }); await cache.invalidateQueries({ queryKey: ['preparation-identity', data.definition_id] }); }, onError });
  const freeze = useMutation({ mutationFn: () => command<{ revision_id: string; draft: Draft }>('preparation.freeze', { draft_id: current?.draft_id }, current?.state), onSuccess: async data => { setRevisionId(data.revision_id); setCurrent(c => c ? { ...c, state: data.draft.state } : c); await cache.invalidateQueries({ queryKey: ['preparation-identity', definition] }); }, onError });
  const denied = blocked || definitions.isError || identity.isError || stock.isError;
  return <Stack><Title order={2}>Preparation arithmetic</Title><Text>Freeze reviewed formulas separately from illustrative workshop practices. Exact applications compute suggestions without changing stock, cable or harness declarations. Prepend, physical clearance and qualification remain unevaluated.</Text>
    {[definitions.error, identity.error, stock.error, load.error, save.error, freeze.error, refresh.error].filter(Boolean).map((error, i) => <Alert key={i} color="red">{error!.message}</Alert>)}
    {denied && <Alert color="red"><Stack><Text>Preparation source access must be rechecked before retained content is shown. Unsaved values and their editing token are retained.</Text><Button loading={refresh.isPending} onClick={refreshAccess}>Refresh preparation access</Button></Stack></Alert>}
    {!denied && <><Card withBorder><Stack><Title order={3}>{current ? 'Edit preparation draft' : 'New preparation profile'}</Title>
      {current ? <Text>{current.draft_id} · {current.state}</Text> : <TextInput label="Preparation profile name" value={name} onChange={e => setName(e.currentTarget.value)} />}
      <RevisionChoice label="Preparation stock" kinds={['wire_stock']} value={profile.stock_revision_id} onChange={stock_revision_id => setProfile({ ...profile, stock_revision_id })} definitions={definitions.data ?? []} />
      <ProfileEditor value={profile} onChange={setProfile} choices={stock.data ? conductiveChoices(stock.data.structure) : []} />
      <Group><Button disabled={!profile.stock_revision_id || (!current && !name.trim())} loading={save.isPending} onClick={() => save.mutate()}>Save preparation profile</Button>{current && <Button loading={freeze.isPending} onClick={() => freeze.mutate()}>Freeze preparation profile</Button>}<Button variant="subtle" onClick={() => { setCurrent(null); setProfile(emptyProfile()); setName(''); }}>New preparation profile</Button></Group>
    </Stack></Card>
    <Select label="Existing preparation definition" data={(definitions.data ?? []).filter(d => d.kind === 'preparation_profile').map(d => ({ value: d.definition_id, label: d.name }))} value={definition} onChange={id => { setDefinition(id); setDraftId(null); setRevisionId(null); setOffset(0); }} />
    {identity.data && <><Select label="Preparation draft to load" value={draftId} data={identity.data.drafts.map(d => ({ value: d.draft_id, label: `${d.draft_id} · ${d.state}` }))} onChange={setDraftId} /><Button disabled={!draftId} onClick={() => load.mutate()}>Load preparation draft</Button><Select label="Frozen preparation revision" value={revisionId} data={identity.data.revisions.map(r => ({ value: r.revision_id, label: `Revision ${r.number} · ${r.revision_id}` }))} onChange={setRevisionId} /><Group><Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous preparation history</Button><Button disabled={Math.max(identity.data.drafts.length, identity.data.revisions.length) < 50} onClick={() => setOffset(offset + 50)}>Next preparation history</Button></Group></>}
    {revisionId && <FrozenProfile key={revisionId} revisionId={revisionId} onDenied={() => setBlocked(true)} />}
    <CutCalculation definitions={definitions.data ?? []} />
    </>}
  </Stack>;
}
export function FrozenProfile({ revisionId, onDenied }: { revisionId: string; onDenied?: () => void }) {
  const query = useQuery({ queryKey: ['preparation-frozen', revisionId], queryFn: () => read<Frozen>(`preparation/revisions/${revisionId}`) });
  useEffect(() => { if (query.isError) onDenied?.(); }, [query.isError, onDenied]);
  return <Card withBorder><Stack><Title order={3}>Frozen preparation profile</Title><Button loading={query.isFetching} onClick={() => query.refetch()}>Refresh frozen preparation access</Button>{query.isError && <Alert color="red">{query.error.message}</Alert>}{query.data && !query.isError && !query.isFetching && <><Text>Profile {query.data.revision_id} · {query.data.sha256}</Text><Text>Stock {query.data.profile.stock_revision_id} · {query.data.stock_sha256}</Text>{query.data.profile.formulas.map(f => <FormulaInspection key={f.local_id} formula={f} />)}</>}</Stack></Card>;
}
