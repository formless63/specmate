import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { RecipeBar, emptyRecipe, type Recipe } from '../../components/editor/RecipeBar';
import { useNavigation } from '../navigation';
import { FrozenConnections } from './FrozenConnections';
import { usePermission } from '../../lib/permissions';
import { randomUUID } from '../../lib/random-id';
import type { Cable } from '../cables/api';
import { emptyLengths } from '../cables/Lengths';
import { connectorCommand } from '../interfaces/connector-api';
import { requestJson, ApiError } from '../workspace/api';
import { emptyIntent, proposalPath, type CableIntent, type IntentDraft, type Proposal as IntentProposal } from '../intents/api';
import { IntentReview } from '../intents/IntentPanel';
import { requestProposal, type Proposal } from '../intent-propose/ProposeWiring';
import { ProposalReview } from './ProposalReview';

type IntentState = { revision_id: string; interface: CableIntent };
function initialRecipe(current: Cable | null): Recipe {
  return { ...emptyRecipe(), stock: current?.stock_revision_id ?? '', fromEnd: current?.endpoints[0]?.end_assembly_revision_id ?? '', toEnd: current?.endpoints[1]?.end_assembly_revision_id ?? '', lengthMm: current?.lengths?.finished.declaration.amount_mm ? Number(current.lengths.finished.declaration.amount_mm) : null };
}
export function RecipeComposer(props: { active: boolean; workspaceId: string; principalKey: string; name: string; current: Cable | null; draftId?: string | null; disabled?: boolean; onApply: (value: Cable) => void }) {
  return <RecipeComposerSession key={`${props.principalKey}:${props.workspaceId}`} {...props} />;
}
function RecipeComposerSession({ active, workspaceId, principalKey, name, current, draftId, disabled = false, onApply }: Parameters<typeof RecipeComposer>[0]) {
  const navigation = useNavigation();
  const create = usePermission('item.create'), freeze = usePermission('design.freeze');
  const [recipe, setRecipe] = useState(() => initialRecipe(current)), [intent, setIntent] = useState<CableIntent | null>(null), [frozen, setFrozen] = useState<IntentState | null>(null), [projection, setProjection] = useState<{ signature: string; bufferSignature: string; proposal: Proposal } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [review, setReview] = useState(false);
  const [activation, setActivation] = useState({ active, generation: 0 });
  const generation = activation.generation + (activation.active !== active ? 1 : 0); if (activation.active !== active) setActivation({ active, generation });
  const signature = JSON.stringify(recipe), alive = useRef(true), latest = useRef({ active, signature }); latest.current = { active, signature };
  const touchedRecipe = useRef(false);
  const keys = useRef(new Map<string, string>()), savedIntent = useRef<{ value: string; draft: IntentDraft } | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const safe = (selected: string) => alive.current && latest.current.active && latest.current.signature === selected;
  const operation = <T,>(op: string, payload: object, state?: string) => { const input = JSON.stringify([op, payload, state]); if (!keys.current.has(input)) keys.current.set(input, randomUUID()); return connectorCommand<T>(op, payload, state, keys.current.get(input)!); };
  const intentIds = [...new Set([current?.intent_revision_id, frozen?.revision_id].filter((id): id is string => !!id))];
  const authority = useQuery({ queryKey: ['recipe-authority', principalKey, workspaceId, JSON.stringify([recipe.fromPort,recipe.toPort,recipe.fromEnd,recipe.toEnd,recipe.stock]), intentIds.join('|'), generation], enabled: active, retry: false, refetchOnWindowFocus: 'always', queryFn: async ({ signal }) => {
    const workspace = await requestJson<{ workspace_id: string; permissions: string[] }>('/api/v0/access/workspace', { signal, cache: 'no-store' }); if (workspace.workspace_id !== workspaceId) throw new ApiError(404, 'Workspace unavailable.');
    const refs = [['fromPort', 'port'], ['toPort', 'port'], ['fromEnd', 'end_assembly'], ['toEnd', 'end_assembly'], ['stock', 'wire_stock']] as const;
    let labels: { revision_id: string; readable: boolean; kind: string; name?: string; number?: number; definition_id?: string }[] = [];
    const params = new URLSearchParams(); intentIds.forEach(id => params.append('revision_ids', id)); refs.forEach(([field]) => { if (recipe[field]) params.append('revision_ids', recipe[field]); });
    if (params.size) { const page = await requestJson<{ labels: { revision_id: string; readable: boolean; kind: string }[] }>('/api/v0/catalog/revision-labels?'+params, { signal, cache: 'no-store' }); labels = page.labels; if (intentIds.some(id => !labels.some(row => row.revision_id === id && row.readable && row.kind === 'cable_intent')) || refs.some(([field, kind]) => recipe[field] && !page.labels.some(row => row.revision_id === recipe[field] && row.readable && row.kind === kind))) throw new ApiError(404, 'An exact recipe reference is unavailable.'); }
    return { ...workspace, labels };
  } });
  useEffect(() => { if (!active) return; const focus = () => { void authority.refetch(); }; window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus); }, [active, authority.refetch]);
  const readable = active && !authority.isFetching && !authority.isError && !!authority.data;
  const permitted = !disabled && readable && create.allowed && authority.data!.permissions.includes('item.create');
  const existingIntent = useQuery({ queryKey: ['recipe-intent', principalKey, workspaceId, current?.intent_revision_id], enabled: readable && !!current?.intent_revision_id, retry: false, queryFn: ({ signal }) => requestJson<IntentState>(`/api/v0/interfaces/revisions/${current!.intent_revision_id}`, { signal, cache: 'no-store' }) });
  useEffect(() => { const value = existingIntent.data; if (value && !touchedRecipe.current && !existingIntent.isError && !recipe.fromPort && !recipe.toPort && !intent) setRecipe(previous => ({ ...previous, fromPort: value.interface.from_revision_id, toPort: value.interface.to_revision_id })); }, [existingIntent.data, existingIntent.isError, recipe.fromPort, recipe.toPort, intent]);
  const chosen = frozen ?? (!intent && !existingIntent.isError ? existingIntent.data : null);
  const selectedIntent = chosen?.interface.from_revision_id === recipe.fromPort && chosen.interface.to_revision_id === recipe.toPort ? chosen : null;
  const change = (next: Recipe) => { touchedRecipe.current = true; if (next.fromPort !== recipe.fromPort || next.toPort !== recipe.toPort) { setIntent(null); setFrozen(null); } setRecipe(next); setError(''); };
  const proposeCable = async (id: string, selected: string) => {
    const value = await requestProposal({ intent_revision_id: id, ...(draftId ? { draft_id: draftId } : {}), stock_revision_id: recipe.stock, from_end: { end_assembly_revision_id: recipe.fromEnd }, to_end: { end_assembly_revision_id: recipe.toEnd } });
    if (!safe(selected)) return;
    const lengths = structuredClone(current?.lengths ?? emptyLengths()); lengths.finished.declaration = recipe.lengthMm === null ? { amount_mm: null, basis: 'unknown', explanation: null } : { amount_mm: String(recipe.lengthMm), basis: 'human_declaration', explanation: 'Finished length chosen in recipe' };
    setProjection({ signature: selected, bufferSignature: JSON.stringify(current), proposal: { ...value, cable: { ...value.cable, lengths } } });
  };
  const propose = async () => {
    if (!permitted || busy) return; const selected = signature; setBusy(true); setError('');
    try { await authority.refetch({ throwOnError: true }); if (!safe(selected)) return;
      if (selectedIntent) await proposeCable(selectedIntent.revision_id, selected);
      else { const result = await requestJson<IntentProposal>('/api/v0/'+proposalPath(recipe.fromPort, recipe.toPort), { cache: 'no-store' }); if (safe(selected)) { setIntent({ ...emptyIntent(), from_revision_id: recipe.fromPort, to_revision_id: recipe.toPort, rows: result.rows }); setReview(true); } }
    } catch (failure) { if (safe(selected)) { setError(failure instanceof Error ? failure.message : 'Proposal unavailable.'); if (failure instanceof ApiError && [401,403,404].includes(failure.status)) void authority.refetch(); } }
    finally { if (alive.current) setBusy(false); }
  };
  const freezeRequirements = async () => {
    if (!intent || !permitted || !freeze.allowed || !authority.data!.permissions.includes('design.freeze') || busy || intent.rows.some(row => row.question)) return;
    const selected = signature; setBusy(true); setError('');
    try { await authority.refetch({ throwOnError: true }); if (!safe(selected)) return;
      const content = JSON.stringify(intent); let draft = savedIntent.current?.value === content ? savedIntent.current.draft : null;
      if (!draft) { draft = await operation<IntentDraft>('interface.create', { workspace_id: workspaceId, name: `${name.trim() || 'Cable'} connection requirements`, interface: intent }); if (!safe(selected)) return; savedIntent.current = { value: content, draft }; }
      const result = await operation<{ revision_id: string; number: number; draft: IntentDraft }>('interface.freeze', { draft_id: draft.draft_id }, draft.state);
      if (!safe(selected)) return; savedIntent.current = { value: content, draft: result.draft }; setFrozen({ revision_id: result.revision_id, interface: intent }); setIntent(null); await proposeCable(result.revision_id, selected);
    } catch (failure) { if (safe(selected)) { setError(failure instanceof Error ? failure.message : 'Requirements could not be frozen.'); if (failure instanceof ApiError && [401,403,404].includes(failure.status)) void authority.refetch(); } }
    finally { if (alive.current) setBusy(false); }
  };
  return <Stack gap="xs">{active && !readable && <Alert color={authority.isError ? 'red' : 'blue'}>{authority.isError ? 'Recipe references are unavailable. Prepared values remain hidden.' : 'Rechecking recipe access…'}{authority.isError && <Button onClick={() => void authority.refetch()}>Retry recipe access</Button>}</Alert>}
    <RecipeBar value={recipe} onChange={change} active={readable} workspaceId={workspaceId} principalKey={principalKey} disabled={!permitted} busy={busy} questions={intent?.rows.filter(row => row.question).length ?? projection?.proposal.questions.length ?? 0} onQuestions={() => setReview(!review)} onPropose={() => void propose()} />
    {readable && <><FrozenConnections active={readable} workspaceId={workspaceId} principalKey={principalKey} from={recipe.fromPort} to={recipe.toPort} />{error && <Alert color="red">{error}</Alert>}{selectedIntent && authority.data!.labels.filter(row => row.revision_id === selectedIntent.revision_id && row.readable).map(row => <Button key={row.revision_id} variant="quiet" size="xs" disabled={!row.definition_id || !row.number} onClick={() => navigation?.navigate({ area: 'designs', lens: 'intents', project: null, probe: { object: row.definition_id!, rev: row.number!, path: [] }, filters: {} })}>Recipe record · {row.name} · r{row.number}</Button>)}{existingIntent.isError && <Alert color="red">The pinned recipe record is unavailable.</Alert>}{intent && review && <Stack><Text fw={600}>Review connection requirements</Text><IntentReview value={intent} onChange={permitted && !busy ? next => { setIntent(next); setFrozen(null); } : undefined} /><Group><Button disabled={!permitted || !freeze.allowed || busy || intent.rows.some(row => row.question)} loading={busy} onClick={() => void freezeRequirements()}>Freeze requirements and propose cable</Button><Text size="xs">Freezes a separate exact recipe record; the cable is not saved.</Text></Group></Stack>}{projection && projection.signature === signature && projection.bufferSignature !== JSON.stringify(current) && <Alert color="yellow">The cable changed after this proposal was requested. Re-propose before applying; your newer edits are kept.</Alert>}{projection && projection.signature === signature && projection.bufferSignature === JSON.stringify(current) && <ProposalReview key={JSON.stringify(projection)} proposal={projection.proposal} current={current} disabled={!permitted || busy} onApply={onApply} />}</>}
  </Stack>;
}
