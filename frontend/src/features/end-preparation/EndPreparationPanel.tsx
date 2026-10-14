import { ReadOnlyNote, usePermission, InspectionScope } from '../../lib/permissions';
import { Alert, Button, Card, Group, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { authorityDenied, command, emptyProfile, loadStock, postRead, read, stockFeatures, type Definition, type Draft, type Frozen, type Identity, type Profile, type Request, type HarnessRequest } from './api';
import { EndInspection, ProfileEditor } from './ProfileEditor';
import { ApplyHarnessPreparation } from './ApplyHarnessPreparation';
import { ApplyPreparation } from './ApplyPreparation';
import { revisionOptionLabel } from "../../lib/revision-labels";
import { RevisionLabel } from "../../lib/IdentityLabel";

type Denial = { profile?: Profile; application?: Request; harnessApplication?: HarnessRequest; revision?: string; draft?: string; definition?: string };
export function EndPreparationPanel({ projectId }: { projectId: string }) { return <Workspace key={projectId} projectId={projectId} />; }
function Workspace({ projectId }: { projectId: string }) {
  const editGate = usePermission('design.edit');
  // Saving a new profile or plan creates a workspace item (item.create); revising one needs design.edit.
  const createGate = usePermission('item.create');
  const freezeGate = usePermission('design.freeze');
  const cache = useQueryClient();
  const [name, setName] = useState(''); const [profile, setProfile] = useState<Profile>(emptyProfile()); const [current, setCurrent] = useState<Draft | null>(null);
  const [definition, setDefinition] = useState<string | null>(null); const [draftId, setDraftId] = useState<string | null>(null); const [revision, setRevision] = useState<string | null>(null); const [offset, setOffset] = useState(0);
  const [blocked, setBlocked] = useState(false); const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  // Browsing choices does not replace editor authority. Accepted Load and New do.
  const scope = useRef(0); const selection = useRef(0); const edits = useRef(0); const denialEpoch = useRef(0); const denied = useRef<Denial[]>([]);
  const mounted = useRef(true); useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const active = (generation: number) => mounted.current && generation === scope.current;
  const onDenied = useCallback((dependency: Denial, generation: number) => { if (!mounted.current || generation !== scope.current) return; denied.current.push(dependency); denialEpoch.current += 1; setBlocked(true); }, []);
  const guardedRead = async <T,>(path: string, dependency: Denial): Promise<T> => { const generation = scope.current; try { return await read<T>(path); } catch (reason) { if (authorityDenied(reason)) onDenied(dependency, generation); throw reason; } };
  const definitions = useQuery({ queryKey: ['end-preparation-definitions', projectId], queryFn: () => guardedRead<Definition[]>('workspace/definitions', {}), retry: false });
  const history = useQuery({ queryKey: ['end-preparation-history', definition, offset], queryFn: () => guardedRead<Identity>(`catalog/definitions/${definition}?offset=${offset}`, { definition: definition! }), enabled: !!definition && !blocked, retry: false });
  const stock = useQuery({ queryKey: ['end-preparation-stock', profile.stock_revision_id], queryFn: async () => { const generation = scope.current; const submitted = profile; try { return await loadStock(submitted.stock_revision_id); } catch (reason) { if (authorityDenied(reason)) onDenied({ profile: submitted }, generation); throw reason; } }, enabled: !!profile.stock_revision_id && !blocked, retry: false });
  const change = (value: Profile) => { edits.current += 1; setProfile(value); };
  const fail = (reason: unknown, generation: number, dependency: Denial) => { if (!active(generation)) return; setError(reason instanceof Error ? reason.message : 'Request failed'); if (authorityDenied(reason)) onDenied(dependency, generation); };
  async function save() {
    const generation = scope.current; const selected = selection.current; const edit = edits.current; const submitted = profile; const accepted = current; setBusy('save'); setError(null);
    try {
      const data = await command<Draft>(accepted ? 'end_preparation.update' : 'end_preparation.create', accepted ? { draft_id: accepted.draft_id, profile: submitted } : { name, profile: submitted }, accepted?.state);
      if (!active(generation)) return;
      // Accepted token advances even when fields changed during the request.
      setCurrent(data); if (edit === edits.current) setProfile(data.content.end_preparation_profile);
      if (selected === selection.current) { setDefinition(data.definition_id); setDraftId(data.draft_id); }
      await cache.invalidateQueries({ queryKey: ['end-preparation-definitions', projectId] }); await cache.invalidateQueries({ queryKey: ['end-preparation-history', data.definition_id] });
    } catch (reason) { fail(reason, generation, { profile: submitted, draft: accepted?.draft_id }); } finally { if (active(generation)) setBusy(null); }
  }
  async function load() {
    const generation = scope.current; const selected = ++selection.current; const edit = edits.current; const submitted = draftId!; setBusy('load'); setError(null);
    try {
      const data = await read<Draft>(`end-preparation/drafts/${submitted}`);
      if (!active(generation) || selected !== selection.current || edit !== edits.current) return;
      scope.current += 1; denied.current = []; setBlocked(false); setRevision(null); setCurrent(data); setProfile(data.content.end_preparation_profile); setBusy(null);
    } catch (reason) { fail(reason, generation, { draft: submitted }); } finally { if (active(generation)) setBusy(null); }
  }
  async function freeze() {
    const generation = scope.current; const selected = selection.current; const submitted = current!; setBusy('freeze'); setError(null);
    try {
      const data = await command<{ revision_id: string; draft: { state: string } }>('end_preparation.freeze', { draft_id: submitted.draft_id }, submitted.state);
      if (!active(generation)) return;
      setCurrent(value => value ? { ...value, state: data.draft.state } : value);
      if (selected === selection.current) setRevision(data.revision_id);
      await cache.invalidateQueries({ queryKey: ['end-preparation-history', submitted.definition_id] });
    } catch (reason) { fail(reason, generation, { draft: submitted.draft_id, profile: submitted.content.end_preparation_profile }); } finally { if (active(generation)) setBusy(null); }
  }
  const refresh = async () => {
    if (busy) return; const generation = scope.current; const epoch = denialEpoch.current; setBusy('refresh'); setError(null);
    try {
      await read('workspace/definitions');
      if (current) await read(`end-preparation/drafts/${current.draft_id}`);
      if (profile.stock_revision_id) await postRead('authority', profile);
      if (revision) await read(`end-preparation/revisions/${revision}`);
      for (const dependency of denied.current.slice()) {
        if (dependency.profile) await postRead('authority', dependency.profile);
        if (dependency.draft) await read(`end-preparation/drafts/${dependency.draft}`);
        if (dependency.revision) await read(`end-preparation/revisions/${dependency.revision}`);
        if (dependency.definition) await read(`catalog/definitions/${dependency.definition}`);
        if (dependency.harnessApplication?.harness_revision_id) await read(`harnesses/revisions/${dependency.harnessApplication.harness_revision_id}`);
        if (dependency.harnessApplication?.profile_revision_id) await read(`end-preparation/revisions/${dependency.harnessApplication.profile_revision_id}`);
        if (dependency.application?.cable_revision_id) await read(`revisions/${dependency.application.cable_revision_id}/snapshot`);
        if (dependency.application?.profile_revision_id) await read(`end-preparation/revisions/${dependency.application.profile_revision_id}`);
      }
      if (!active(generation) || epoch !== denialEpoch.current) return;
      await cache.refetchQueries({ queryKey: ['end-preparation-definitions', projectId] }, { throwOnError: true });
      if (profile.stock_revision_id) await cache.refetchQueries({ queryKey: ['end-preparation-stock', profile.stock_revision_id] }, { throwOnError: true });
      if (definition) await cache.refetchQueries({ queryKey: ['end-preparation-history', definition] }, { throwOnError: true });
      if (active(generation) && epoch === denialEpoch.current) { denied.current = []; setBlocked(false); }
    } catch (reason) { fail(reason, generation, {}); } finally { if (active(generation)) setBusy(null); }
  };
  useEffect(() => { if (!blocked) return; const listener = () => { void refresh(); }; window.addEventListener('focus', listener); return () => window.removeEventListener('focus', listener); });
  const hidden = blocked || authorityDenied(definitions.error) || authorityDenied(history.error) || authorityDenied(stock.error);
  const renderedScope = scope.current;
  return <Stack><Title order={2}>Per-end preparation</Title><Text>Reviewed stripping, drain treatment, shield leads and expected bonds. Applications show instructions only. Copper continuity, actual bonds, measured preparation and physical qualification remain not evaluated.</Text>
    {error && <Alert color="red">{error}</Alert>}{[definitions.error, history.error, stock.error].filter(Boolean).map((value, index) => <Alert color="red" key={index}>{value!.message}</Alert>)}
    {hidden && <Alert color="red"><Stack><Text>End preparation access must be rechecked before retained evidence is shown. Unsaved fields and their original editing token are retained.</Text><Button loading={busy === 'refresh'} onClick={() => { void refresh(); }}>Refresh end preparation access</Button></Stack></Alert>}
    {!hidden && <><Card withBorder><Stack><Title order={3}>{current ? 'Edit end preparation draft' : 'New end preparation profile'}</Title>{current ? <Text>{current.draft_id} · {current.state}</Text> : <InspectionScope permission="item.create"><TextInput label="End preparation profile name" value={name} onChange={e => setName(e.currentTarget.value)} /></InspectionScope>}
      <InspectionScope permission={current ? 'design.edit' : 'item.create'}>
      <RevisionPicker label="End preparation stock" kinds={['wire_stock']} definitions={definitions.data ?? []} value={profile.stock_revision_id} onChange={stock_revision_id => change({ ...profile, stock_revision_id })} onDenied={id => onDenied({ definition: id }, renderedScope)} />
      <ProfileEditor value={profile} onChange={change} features={stock.data && !stock.isFetching && !stock.isError ? stockFeatures(stock.data.structure) : []} />
      </InspectionScope>
      <Group><Button disabled={!!busy || !profile.stock_revision_id || (!current && !name.trim())} {...(current ? editGate : createGate).props} onClick={() => { void save(); }}>Save end preparation profile</Button>{current && <Button disabled={!!busy} {...freezeGate.props} onClick={() => { void freeze(); }}>Freeze end preparation profile</Button>}</Group><ReadOnlyNote permission={current ? "design.edit" : "item.create"}>Saving and freezing end preparation profiles are unavailable.</ReadOnlyNote>
    </Stack></Card><Select label="Existing end preparation definition" data={(definitions.data ?? []).filter(d => d.kind === 'end_preparation_profile').map(d => ({ value: d.definition_id, label: d.name }))} value={definition} onChange={id => { selection.current += 1; setDefinition(id); setDraftId(null); setRevision(null); setOffset(0); }} />
    {history.data && !history.isFetching && <><Select label="End preparation draft to load" data={history.data.drafts.map(d => ({ value: d.draft_id, label: `${d.draft_id} · ${d.state}` }))} value={draftId} onChange={id => { selection.current += 1; setDraftId(id); }} /><Button disabled={!!busy || !draftId} onClick={() => { void load(); }}>Load end preparation draft</Button><Select label="Frozen end preparation revision" data={history.data.revisions.map((r) => ({ value: r.revision_id, label: revisionOptionLabel(history.data.name, r.number) }))} value={revision} onChange={id => { selection.current += 1; setRevision(id); }} /><Group><Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous end preparation history</Button><Button disabled={Math.max(history.data.drafts.length, history.data.revisions.length) < 50} onClick={() => setOffset(offset + 50)}>Next end preparation history</Button></Group></>}
    {revision && <FrozenProfile key={revision} revisionId={revision} authorityScope={scope.current} onDenied={onDenied} />}
    </>}
    {hidden && <Text>Starting a new profile discards the retained unsaved editor and endpoint mapping.</Text>}
    <Button variant="subtle" onClick={() => { scope.current += 1; selection.current += 1; edits.current += 1; denied.current = []; setBlocked(false); setBusy(null); setError(null); setCurrent(null); setProfile(emptyProfile()); setName(''); setDefinition(null); setDraftId(null); setRevision(null); }}>New end preparation profile</Button>
    <ApplyHarnessPreparation key={`harness-${scope.current}`} hidden={hidden} definitions={definitions.data ?? []} authorityScope={scope.current} onDenied={(harnessApplication, generation) => onDenied({ harnessApplication }, generation)} onReferenceDenied={(id, generation) => onDenied({ definition: id }, generation)} />
    <ApplyPreparation key={scope.current} hidden={hidden} definitions={definitions.data ?? []} authorityScope={scope.current} onDenied={(application, generation) => onDenied({ application }, generation)} onReferenceDenied={(id, generation) => onDenied({ definition: id }, generation)} />
  </Stack>;
}
export function RevisionPicker({ label, kinds, value, onChange, definitions, onDenied }: { label: string; kinds: string[]; value: string; onChange: (value: string) => void; definitions: Definition[]; onDenied?: (id: string) => void }) {
  const [definition, setDefinition] = useState<string | null>(null); const [offset, setOffset] = useState(0);
  const query = useQuery({ queryKey: ['end-preparation-picker', definition, offset], queryFn: async () => { const id = definition!; try { return await read<Identity>(`catalog/definitions/${id}?offset=${offset}`); } catch (reason) { if (authorityDenied(reason)) onDenied?.(id); throw reason; } }, enabled: !!definition, retry: false });
  return <Stack gap="xs"><Select label={`${label} definition`} searchable data={definitions.filter(d => kinds.includes(d.kind)).map(d => ({ value: d.definition_id, label: d.name }))} value={definition} onChange={id => { setDefinition(id); setOffset(0); }} /><Select label={`${label} revision`} disabled={query.isError || query.isFetching} value={value || null} data={(query.isError || query.isFetching ? [] : query.data?.revisions ?? []).map((r) => ({ value: r.revision_id, label: revisionOptionLabel(query.data?.name, r.number) }))} onChange={id => onChange(id ?? '')} /><TextInput label={`${label} exact revision ID`} value={value} onChange={e => onChange(e.currentTarget.value)} />{query.error && <Alert color="red">{query.error.message}</Alert>}{query.data && !query.isError && <Group><Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>Earlier {label} revisions</Button><Button disabled={query.data.revisions.length < 50} onClick={() => setOffset(offset + 50)}>Later {label} revisions</Button></Group>}</Stack>;
}
export function FrozenProfile({ revisionId, authorityScope = 0, onDenied }: { revisionId: string; authorityScope?: number; onDenied?: (dependency: Denial, generation: number) => void }) {
  const query = useQuery({ queryKey: ['end-preparation-frozen', revisionId], queryFn: async () => { try { return await read<Frozen>(`end-preparation/revisions/${revisionId}`); } catch (reason) { if (authorityDenied(reason)) onDenied?.({ revision: revisionId }, authorityScope); throw reason; } }, retry: false });
  return <Card withBorder><Stack><Title order={3}>Frozen end preparation profile</Title><Button loading={query.isFetching} onClick={() => { void query.refetch(); }}>Refresh frozen end preparation access</Button>{query.error && <Alert color="red">{query.error.message}</Alert>}{query.data && !query.isError && !query.isFetching && <><Text><RevisionLabel id={query.data.revision_id} role="Profile" sha256={query.data.sha256} /></Text><Text><RevisionLabel id={query.data.profile.stock_revision_id} role="Stock" sha256={query.data.stock_sha256} /></Text>{query.data.body_revisions.map(body => <Text key={body.revision_id}><RevisionLabel id={body.revision_id} role="Bond target body" sha256={body.sha256} /></Text>)}<EndInspection label="Frozen end A" end={query.data.profile.a} /><EndInspection label="Frozen end B" end={query.data.profile.b} /><Text>Physical qualification: {query.data.physical_qualification}</Text></>}</Stack></Card>;
}
