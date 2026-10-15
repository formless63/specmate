import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Group, Select, Stack, Text, TextInput } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { StockSpecification } from '../../../../packages/section-layout/src';
import { InspectionScope, usePermission } from '../../lib/permissions';
import { listLibraryTable } from '../library-gallery/table-api';
import { CableOperationError } from '../cables/api';
import { ApiError, requestJson } from '../workspace/api';
import { authorityDenied, command, postRead as cutAuthority, emptyProfile as emptyCut, type Profile as Cut, type Frozen as FrozenCut } from '../preparation/api';
import { postRead as endAuthority, emptyProfile as emptyEnd, stockFeatures, type Profile as End, type Frozen as FrozenEnd } from '../end-preparation/api';
import { conductiveChoices, FormulaInspection, ProfileEditor as CutEditor } from '../preparation/ProfileEditor';
import { EndInspection, ProfileEditor as EndEditor } from '../end-preparation/ProfileEditor';
import type { Identity } from '../identity/api';

type Kind = 'cut' | 'end';
type Draft = { definition_id: string; draft_id: string; state: string; content: { preparation_profile?: Cut; end_preparation_profile?: End } };
const extract = (kind: Kind, draft: Draft): Cut | End | undefined => kind === 'cut' ? draft.content.preparation_profile : draft.content.end_preparation_profile;
/** Reuses the existing typed practice editors and operation contracts against one exact stock. */
export function StockPreparationEditor({ kind, stock, revisionId, principalKey, active }: { kind: Kind; stock: StockSpecification; revisionId: string; principalKey: string; active: boolean }) {
  const cache = useQueryClient(); const path = kind === 'cut' ? 'preparation' : 'end-preparation'; const operation = kind === 'cut' ? 'preparation' : 'end_preparation';
  const noun = kind === 'cut' ? 'cut preparation' : 'end preparation'; const definitionKind = kind === 'cut' ? 'preparation_profile' : 'end_preparation_profile';
  const blank = (): Cut | End => ({ ...(kind === 'cut' ? emptyCut() : emptyEnd()), stock_revision_id: revisionId });
  const [profile, setProfile] = useState<Cut | End>(blank); const [name, setName] = useState(''); const [current, setCurrent] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(true); const [blocked, setBlocked] = useState(false); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [definition, setDefinition] = useState<string | null>(null); const [draftId, setDraft] = useState<string | null>(null); const [frozenId, setFrozen] = useState<string | null>(null); const [offset, setOffset] = useState(0); const [after, setAfter] = useState<string | null>(null);
  const edits = useRef(0); const generation = useRef(0); const gate = usePermission(current ? 'design.edit' : 'item.create'); const freezeGate = usePermission('design.freeze');
  const choices = useQuery({ queryKey: ['stock-preparation-choices', principalKey, kind, after], enabled: active, retry: false, queryFn: () => listLibraryTable({ kinds: [definitionKind], query: '', after, projectFilterId: null }) });
  const history = useQuery({ queryKey: ['stock-preparation-history', principalKey, definition, offset], enabled: active && !!definition, retry: false, queryFn: ({ signal }) => requestJson<Identity>(`/api/v0/catalog/definitions/${definition}?offset=${offset}&limit=50`, { signal }) });
  const frozen = useQuery({ queryKey: ['stock-preparation-frozen', principalKey, kind, frozenId], enabled: active && !!frozenId, retry: false, queryFn: ({ signal }) => requestJson<FrozenCut | FrozenEnd>(`/api/v0/${path}/revisions/${frozenId}`, { signal }) });
  const authority = useQuery({ queryKey: ['stock-preparation-authority', principalKey, kind, revisionId, current?.draft_id ?? null, generation.current], enabled: active, retry: false, refetchOnWindowFocus: 'always',
    queryFn: async () => { const submitted = profile; const draft = current; if (draft) await requestJson(`/api/v0/${path}/drafts/${draft.draft_id}`); if (kind === 'cut') await cutAuthority('authority', submitted); else await endAuthority('authority', submitted); return true; } });
  useEffect(() => { if (!active) return; const check = () => { void authority.refetch(); }; window.addEventListener('focus', check); return () => window.removeEventListener('focus', check); }, [active, authority.refetch]);
  const fail = (failure: unknown) => { setError(failure instanceof Error ? failure.message : String(failure)); if (authorityDenied(failure) || failure instanceof ApiError && [401, 403, 404].includes(failure.status)) setBlocked(true); };
  const change = (next: Cut | End) => { if (!gate.allowed) return; edits.current += 1; setProfile(next); setDirty(true); };
  const save = async () => {
    if (busy || !gate.allowed || (!current && !name.trim())) return; const edit = edits.current; const scope = generation.current; const submitted = profile; setBusy(true); setError('');
    try { const result = await command<Draft>(`${operation}.${current ? 'update' : 'create'}`, current ? { draft_id: current.draft_id, profile: submitted } : { name: name.trim(), profile: submitted }, current?.state);
      if (scope !== generation.current) return; const saved = extract(kind, result); if (!saved || saved.stock_revision_id !== revisionId) throw new Error('Saved preparation did not retain the selected exact stock pin.');
      setCurrent(result); if (edit === edits.current) { setProfile(saved); setDirty(false); } void cache.invalidateQueries({ queryKey: ['stock-preparation-choices', principalKey, kind] }); void cache.invalidateQueries({ queryKey: ['stock-preparation-history', principalKey, result.definition_id] });
    } catch (failure) { if (scope === generation.current) fail(failure); } finally { if (scope === generation.current) setBusy(false); }
  };
  const load = async () => {
    if (!draftId || busy) return; const scope = generation.current; const edit = edits.current; setBusy(true); setError('');
    try { const loaded = await requestJson<Draft>(`/api/v0/${path}/drafts/${draftId}`); if (scope !== generation.current || edit !== edits.current) return; const value = extract(kind, loaded); if (!value || value.stock_revision_id !== revisionId) throw new Error('This preparation pins another stock revision. Its editor was not substituted.'); setCurrent(loaded); setProfile(value); setDirty(false); setFrozen(null); }
    catch (failure) { if (scope === generation.current) fail(failure); } finally { if (scope === generation.current) setBusy(false); }
  };
  const freeze = async () => {
    if (!current || dirty || busy || !freezeGate.allowed) return; const scope = generation.current; const edit = edits.current; setBusy(true); setError('');
    try { const result = await command<{ revision_id: string; draft: { state: string } }>(`${operation}.freeze`, { draft_id: current.draft_id }, current.state); if (scope !== generation.current) return; setCurrent(value => value ? { ...value, state: result.draft.state } : value); if (edit === edits.current) setFrozen(result.revision_id); void cache.invalidateQueries({ queryKey: ['stock-preparation-history', principalKey, current.definition_id] }); }
    catch (failure) { if (scope === generation.current) fail(failure); } finally { if (scope === generation.current) setBusy(false); }
  };
  const refresh = async () => {
    setBusy(true); setError(''); try { await authority.refetch({ throwOnError: true }); await choices.refetch({ throwOnError: true }); if (definition) await history.refetch({ throwOnError: true }); if (frozenId) await frozen.refetch({ throwOnError: true }); setBlocked(false); } catch (failure) { fail(failure); } finally { setBusy(false); }
  };
  const checking = authority.isPending || authority.isFetching;
  const incomplete = (authority.error instanceof ApiError || authority.error instanceof CableOperationError) && authority.error.status === 422;
  const hidden = blocked || choices.isError || history.isError || frozen.isError || authority.isError && !incomplete || checking;
  return <Stack gap="xs"><Text size="sm">Pinned stock: {revisionId}. Formulas and instructions are separate versioned records; they never rewrite construction or establish physical qualification.</Text>{error && <Alert color="red">{error}</Alert>}{incomplete && <Alert color="yellow">Local preparation is incomplete. Correct its fields before saving; authority will be checked again.</Alert>}
    {hidden ? <Alert color={checking ? "blue" : "red"}><Text>{checking ? 'Rechecking preparation authority…' : 'Preparation access must be rechecked. The unsaved buffer and its original editing token are retained.'}</Text><Button size="xs" loading={busy} onClick={refresh}>Refresh {noun} access</Button></Alert> : <>
      <InspectionScope permission={current ? 'design.edit' : 'item.create'}>{!current && <TextInput label={`${noun} name`} value={name} disabled={busy} onChange={event => { if (!busy) setName(event.currentTarget.value); }} />}{kind === 'cut' ? <CutEditor value={profile as Cut} onChange={change} choices={conductiveChoices(stock.structure)} /> : <EndEditor value={profile as End} onChange={change} features={stockFeatures(stock.structure)} />}</InspectionScope>
      <Text size="xs">{current ? `${current.state}${dirty ? ' · unsaved' : ' · saved draft'}` : 'New · unsaved'}</Text><Group gap="xs"><Button size="xs" disabled={busy || !current && !name.trim()} {...gate.props} onClick={save}>Save {noun}</Button><Button size="xs" variant="quiet" disabled={busy || !current || dirty} {...freezeGate.props} onClick={freeze}>Freeze {noun}</Button></Group>
      <details><summary>Saved {noun} profiles</summary><Stack gap="xs"><Select label={`${noun} definition`} data={(choices.isError ? [] : choices.data?.results ?? []).map(item => ({ value: item.record_id, label: item.label }))} value={definition} disabled={busy} onChange={value => { if (busy) return; setDefinition(value); setDraft(null); setFrozen(null); setOffset(0); }} />
        <Group gap="xs"><Button size="xs" variant="quiet" disabled={busy || !after} onClick={() => setAfter(null)}>First profiles</Button><Button size="xs" variant="quiet" disabled={busy || !choices.data?.next_after} onClick={() => setAfter(choices.data!.next_after)}>More profiles</Button></Group>
        {history.data && !history.isError && <><Select label={`${noun} draft`} value={draftId} disabled={busy} onChange={value => { if (!busy) setDraft(value); }} data={history.data.drafts.map(item => ({ value: item.draft_id, label: item.state }))} /><Button size="xs" variant="quiet" disabled={!draftId || busy} onClick={load}>Load {noun} draft (replace local edits)</Button><Select label={`${noun} frozen revision`} value={frozenId} disabled={busy} onChange={value => { if (!busy) setFrozen(value); }} data={history.data.revisions.map(item => ({ value: item.revision_id, label: `r${item.number}` }))} /><Group><Button size="xs" variant="quiet" disabled={busy || !offset} onClick={() => setOffset(value => Math.max(0, value - 50))}>Earlier history</Button><Button size="xs" variant="quiet" disabled={busy || Math.max(history.data.revisions.length, history.data.drafts.length) < 50} onClick={() => setOffset(value => value + 50)}>Later history</Button></Group></>}
      </Stack></details>
      {frozen.data && !frozen.isError && !frozen.isFetching && (frozen.data.profile.stock_revision_id !== revisionId ? <Alert color="yellow">This frozen profile pins another stock revision; its instructions are not shown for this stock.</Alert> : kind === 'cut' ? <Stack><Text size="sm" fw={600}>Frozen cut preparation · {frozenId}</Text>{(frozen.data as FrozenCut).profile.formulas.map(formula => <FormulaInspection key={formula.local_id} formula={formula} />)}</Stack> : <Stack><EndInspection label="Frozen end A" end={(frozen.data as FrozenEnd).profile.a} /><EndInspection label="Frozen end B" end={(frozen.data as FrozenEnd).profile.b} /></Stack>)}
    </>}
    <Button size="xs" variant="quiet" disabled={busy} onClick={() => { generation.current += 1; edits.current += 1; setCurrent(null); setProfile(blank()); setName(''); setDirty(true); setBlocked(false); setError(''); setBusy(false); setFrozen(null); }}>New {noun} (discard local edits)</Button>
  </Stack>;
}
