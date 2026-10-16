import { useRevisionLabel, newestFirst } from "../../lib/revision-labels";
import { ReadOnlyNote, usePermission, InspectionScope } from "../../lib/permissions";
import { LengthsEditor, LengthInspection, LengthImpactView } from "./Lengths";
import { Alert, Anchor, Button, Card, Group, SegmentedControl, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useMutation, useQueries, useQuery, useQueryClient, type Query, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { loadFrozenStock } from '../wire-stock/viewer-api';
import { CableViews, type CableEnd } from '../cable-views/CableViews';
import { useProbedSelection } from '../cable-views/useProbedSelection';
import { useProbe } from '../probe';
import type { Body, Inspection as InterfaceInspection } from '../interfaces/api';
import { CableOperationError, authorityDenied, cableProblems, command, read, initialCable, type Cable, type Endpoint, type Definition, type Draft, type Identity, type Inspection, type ResolvedTermination } from './api';
import { ContinueDraftButton } from '../scope/ContinueDraftButton';
import { RevisionPicker } from './RevisionPicker';
import { NewIntent } from '../intents/IntentPanel';
import { ProposeWiring } from '../intent-propose/ProposeWiring';
import { SbUnknown } from '../../components/sb';
import { connectorStack, resolveDenied, splitKey, terminalKey, type ResolvedStack } from '../end-assemblies/api';
import { SignalCell, StackDiagram, StackEditor, StackView, findTerminal, resolvedChips, targetOptions, useResolvedStacks } from '../end-assemblies/StackEditor';
import { revisionOptionLabel } from "../../lib/revision-labels";
import { CableSummary, StockLink, endName } from './CableSummary';
import { Swatch } from '../cable-views/Swatch';
import { appearanceOf } from '../../../../packages/section-layout/src';
import { RevisionLabel } from "../../lib/IdentityLabel";
import { FromPreference, usePreferenceDefaults } from "../preferences/usePreferenceDefaults";
import { CableWorkbench } from '../cable-workbench/CableWorkbench';
import { conductiveElements } from '../cable-workbench/model';
import { IntentCheckPanel } from '../intent-check/IntentCheckPanel';

export function CablePanel({ projectId = null, workspaceId }: { projectId?: string | null; workspaceId?: string | null }) { return <Workspace key={projectId ?? "library"} projectId={projectId} workspaceId={workspaceId} />; }
function Workspace({ projectId, workspaceId }: { projectId: string | null; workspaceId?: string | null }) {
  const cache = useQueryClient();
  const createGate = usePermission('item.create');
  const freezeGate = usePermission('design.freeze');
  const [name, setName] = useState("");
  const [value, setValue] = useState<Cable>(initialCable());
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [createSourceDenied, setCreateSourceDenied] = useState(false);
  const [draftSourceDenied, setDraftSourceDenied] = useState(false);
  const [draftToken, setDraftToken] = useState<string>();
  const [committedDraft, setCommittedDraft] = useState<Draft | null>(null);
  const [authorityBlocked, setAuthorityBlocked] = useState(false);
  const [checkingAuthority, setCheckingAuthority] = useState(false);
  const affectedQueries = useRef<Query[]>([]);
  const checking = useRef(false);
  const refreshAuthority = useCallback(async () => {
    if (checking.current) return;
    checking.current = true; setCheckingAuthority(true);
    try {
      // Preserve the read functions as well as keys: hidden reference queries can be
      // garbage-collected while access is denied, and must still be reauthorized.
      await Promise.all(affectedQueries.current.map(query => cache.fetchQuery({
        queryKey: query.queryKey, queryFn: query.options.queryFn, staleTime: 0,
      })));
      setAuthorityBlocked(false);
    } catch { /* Keep retained form state hidden until every affected read is authorized. */ }
    finally { checking.current = false; setCheckingAuthority(false); }
  }, [cache]);
  const mutationError = useCallback((error: Error) => {
    if (!authorityDenied(error)) return;
    affectedQueries.current = cache.getQueryCache().findAll({ type: 'active' })
      .filter(query => String(query.queryKey[0]).startsWith('cable-'));
    setAuthorityBlocked(true);
    void refreshAuthority();
  }, [cache, refreshAuthority]);
  useEffect(() => {
    if (!authorityBlocked) return;
    const refresh = () => { void refreshAuthority(); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [authorityBlocked, refreshAuthority]);
  const definitions = useQuery({ queryKey: ["cable-definitions", projectId], queryFn: () => read<Definition[]>('workspace/definitions') });
  const identity = useQuery({ queryKey: ["cable-identity", definitionId, offset], queryFn: () => read<Identity>(`catalog/definitions/${definitionId}?offset=${offset}`), enabled: !!definitionId });
  const draft = useQuery({ queryKey: ["cable-draft", draftId], queryFn: () => read<Draft>(`cables/drafts/${draftId}`), enabled: !!draftId });
  const [tried, setTried] = useState(false);
  const create = useMutation({ mutationFn: () => command<Draft>("cable.create", { name, cable: value, ...(projectId ? { project_id: projectId } : {}) }), onSuccess: async (data) => {
    setDefinitionId(data.definition_id); setDraftId(data.draft_id); setDraftToken(data.state); setCommittedDraft(null); setRevisionId(null); setOffset(0);
    await cache.invalidateQueries({ queryKey: ["cable-definitions", projectId] });
  }, onError: mutationError });
  const freeze = useMutation({ mutationFn: () => command<{ revision_id: string; draft?: Draft }>("cable.freeze", { draft_id: draftId }, draftToken), onSuccess: async (data) => {
    setRevisionId(data.revision_id);
    if (data.draft) { setCommittedDraft(data.draft); setDraftToken(data.draft.state); }
    await cache.invalidateQueries({ queryKey: ["cable-draft", draftId] });
    await cache.invalidateQueries({ queryKey: ["cable-identity", definitionId] });
  }, onError: mutationError });
  const currentDefinitions = definitions.isError ? [] : definitions.data ?? [];
  const pickDefinition = useCallback((id: string | null) => { setDefinitionId(id); setDraftId(null); setRevisionId(null); setDraftToken(undefined); setCommittedDraft(null); setOffset(0); }, []);
  const openDraft = useCallback((id: string) => { setDraftId(id); setDraftToken(undefined); setCommittedDraft(null); }, []);
  useProbedSelection({ kind: 'cable', definitions: definitions.isError ? undefined : definitions.data, definitionId,
    revisions: identity.data?.definition_id === definitionId && offset === 0 ? identity.data.revisions : undefined,
    drafts: identity.data?.definition_id === definitionId && offset === 0 ? identity.data.drafts : undefined, pickDraft: openDraft, pickDefinition, pickRevision: setRevisionId });
  // The Library row for the probed definition already shows these views; show them once.
  const probedObject = useProbe()?.probe?.object ?? null;
  const shownAbove = !!definitionId && probedObject === definitionId;
  const createErrors = create.error instanceof CableOperationError ? create.error.fieldErrors : undefined;
  const workspaceDenied = authorityBlocked || definitions.isError || identity.isError;
  const creating = !definitionId;
  const cableName = currentDefinitions.find(d => d.definition_id === definitionId)?.name ?? identity.data?.name ?? 'Cable';
  // A draft and a frozen revision open together share one place: a toggle shows one at a time, both stay mounted.
  const [shown, setShown] = useState<'draft' | 'frozen'>('draft');
  const bothOpen = !!draft.data && !!draftId && !!revisionId && !shownAbove && !workspaceDenied && !draft.isError;
  const frozenNumber = identity.data?.revisions.find(r => r.revision_id === revisionId)?.number;
  const freezeButton = draft.data && !draft.isError && !workspaceDenied
    ? <Button size="xs" disabled={draftSourceDenied || !draftToken} loading={freeze.isPending} {...freezeGate.props} onClick={() => freeze.mutate()}>Freeze cable revision</Button> : null;
  return <Stack>
    <Group justify="space-between" align="flex-end" gap="xs" wrap="wrap">
      <Title order={2}>Cables</Title>
      {!creating && !authorityBlocked && <Button size="xs" variant="default" onClick={() => pickDefinition(null)}>New cable</Button>}
    </Group>
    <Text size="sm" c="dimmed">A cable is drawn as it is built: End A's stack, the stock cut to length with every conductor, shield and drain, and End B's stack. Click any part of the drawing to probe it; landings are declarations, and continuity and physical qualification remain unevaluated.</Text>
    {authorityBlocked && <Alert color="red"><Stack><Text>Cable access must be rechecked before retained content can be shown.</Text><Button loading={checkingAuthority} onClick={() => void refreshAuthority()}>Refresh cable access</Button></Stack></Alert>}
    {!authorityBlocked && <Group align="flex-end" gap="xs" wrap="wrap" aria-label="Open a cable">
      <Select label="Existing cable definition" searchable data={currentDefinitions.filter((d) => d.kind === "cable").map((d) => ({ value: d.definition_id, label: `${d.name} (${d.kind})` }))} value={definitions.isError ? null : definitionId} disabled={definitions.isError} onChange={(id) => pickDefinition(id)} style={{ flex: '1 1 16rem' }} />
      {identity.data && !workspaceDenied && <>
        <Select label="Edit cable draft" value={draftId} onChange={id => { if (id !== draftId) { setDraftId(id); setDraftToken(undefined); setCommittedDraft(null); } }} data={identity.data.drafts.map((d) => ({ value: d.draft_id, label: `${d.draft_id} · ${d.state}` }))} style={{ flex: '1 1 12rem' }} />
        <Select label="Inspect frozen cable" value={revisionId} onChange={setRevisionId} data={newestFirst(identity.data.revisions).map((r) => ({ value: r.revision_id, label: revisionOptionLabel(identity.data.name, r.number) }))} style={{ flex: '1 1 12rem' }} />
        <ContinueDraftButton drafts={identity.data.drafts} revisionId={revisionId} draftId={draftId} onOpen={openDraft} />
        {(offset > 0 || Math.max(identity.data.revisions.length, identity.data.drafts.length) >= 50) && <Group gap="xs"><Button size="xs" variant="subtle" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous revisions</Button><Button size="xs" variant="subtle" disabled={Math.max(identity.data.revisions.length, identity.data.drafts.length) < 50} onClick={() => setOffset(offset + 50)}>Next revisions</Button></Group>}
      </>}
    </Group>}
    {definitions.isError && <Alert color="red">{definitions.error.message}</Alert>}
    {identity.isError && <Alert color="red">{identity.error.message}</Alert>}
    {creating && !authorityBlocked && <NewCableFromIntent projectId={projectId} definitions={currentDefinitions} onUse={intent_revision_id => setValue(current => ({ ...current, intent_revision_id }))} onPropose={cable => setValue(current => ({ ...cable, lengths: current.lengths, review: current.review, review_basis: current.review_basis }))} />}
    {creating && !authorityBlocked && <NewCableBench name={name} onName={setName} value={value} onChange={setValue} definitions={currentDefinitions} workspaceId={workspaceId} errors={createErrors}
      onAuthorityChange={setCreateSourceDenied} actions={<>
        <Button size="xs" disabled={!name.trim() || definitions.isError || createSourceDenied} loading={create.isPending} {...createGate.props} onClick={() => { setTried(true); if (cableProblems(value).length === 0) create.mutate(); }}>Create cable draft</Button>
      </>} notices={<>{tried && <Missing problems={cableProblems(value)} />}<ReadOnlyNote permission="item.create">Creating drafts is unavailable.</ReadOnlyNote>{create.isError && <Alert color="red">{create.error.message}</Alert>}</>} />}
    {draft.isError && <Alert color="red">{draft.error.message}</Alert>}
    {bothOpen && <SegmentedControl size="xs" w="fit-content" aria-label="Show the draft or the frozen revision" value={shown} onChange={v => setShown(v as 'draft' | 'frozen')}
      data={[{ value: 'draft', label: 'Draft (editing)' }, { value: 'frozen', label: `Frozen ${frozenNumber ? `r${frozenNumber}` : 'revision'}` }]} />}
    {draft.data && draftId && <div hidden={bothOpen && shown !== 'draft'}><DraftBench key={draft.data.draft_id} name={cableName} draft={draft.data} committedDraft={committedDraft} hidden={draft.isError || workspaceDenied} definitions={currentDefinitions} workspaceId={workspaceId} onStateChange={setDraftToken} onMutationError={mutationError} onAuthorityChange={setDraftSourceDenied}
      onSaved={async () => { await cache.invalidateQueries({ queryKey: ["cable-draft", draftId] }); }} freezeAction={freezeButton} freezeError={freeze.isError ? freeze.error.message : null} /></div>}
    {revisionId && shownAbove && !workspaceDenied && <Text role="status" data-testid="views-shown-above">Frozen cable views are shown above, in the selected library row.</Text>}
    {revisionId && !shownAbove && !workspaceDenied && !draft.isError && <div hidden={bothOpen && shown !== 'frozen'}><CableInspector key={revisionId} revisionId={revisionId} revisions={identity.data?.revisions ?? []} /></div>}
  </Stack>;
}

/** A cable from intent: steps 1-3 state the intent, then stock and ends, then the proposed wiring. */
function NewCableFromIntent({ projectId, definitions, onUse, onPropose }: { projectId: string | null; definitions: Definition[]; onUse: (intentRevisionId: string) => void; onPropose: (cable: Cable) => void }) {
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState("");
  const [stock, setStock] = useState("");
  const [fromEnd, setFromEnd] = useState("");
  const [toEnd, setToEnd] = useState("");
  const useIntent = (id: string) => { setIntent(id); if (id) onUse(id); };
  if (!open) return <Group><Button variant="default" size="xs" onClick={() => setOpen(true)}>New cable from intent</Button><Text size="xs" c="dimmed">Start from the two ends and the signals the cable must carry.</Text></Group>;
  return <Stack gap="xs">
    <NewIntent title="New cable from intent" projectId={projectId} definitions={definitions} onFrozen={useIntent} />
    <Card withBorder><Stack gap="xs">
      <Title order={4}>4 · Stock and ends</Title>
      <RevisionPicker label="Intent to wire" title="Cable intent (frozen above, or an existing one)" kind="cable_intent" value={intent} onChange={useIntent} definitions={definitions} />
      <RevisionPicker label="Proposal stock" title="Stock" kind="wire_stock" value={stock} onChange={setStock} definitions={definitions} />
      <Group grow align="flex-start">
        <RevisionPicker label="From end assembly" title="From end assembly" kind="end_assembly" value={fromEnd} onChange={setFromEnd} definitions={definitions} />
        <RevisionPicker label="To end assembly" title="To end assembly" kind="end_assembly" value={toEnd} onChange={setToEnd} definitions={definitions} />
      </Group>
      {intent && <ProposeWiring intentRevisionId={intent} stockRevisionId={stock || null} fromEnd={fromEnd ? { end_assembly_revision_id: fromEnd } : null} toEnd={toEnd ? { end_assembly_revision_id: toEnd } : null} onAccept={onPropose} acceptLabel="Use accepted rows for the new cable" />}
    </Stack></Card>
    <Anchor component="button" type="button" size="xs" w="fit-content" onClick={() => setOpen(false)}>Close</Anchor></Stack>;
}

/** Connector bodies of each end's resolved stack, for drawing their faces. */
export function useBodies(stacks: (ResolvedStack | undefined)[]): (Body | null | undefined)[] {
  const ids = stacks.map(s => s?.body_revision_id ?? null);
  const bodies = useQueries({ queries: ids.map(id => ({
    queryKey: ['cable-body', id], queryFn: () => read<InterfaceInspection>(`interfaces/revisions/${id}`), enabled: !!id, retry: false,
  })) });
  return bodies.map(b => (b.data?.interface && (b.data.interface as { kind?: string }).kind === 'connector_body' ? b.data.interface as Body : null));
}

/** A new cable on the workbench: the drawing fills in as the stock and ends are chosen in the inspector. */
function NewCableBench({ name, onName, value, onChange, definitions, workspaceId, errors, onAuthorityChange, actions, notices }: { name: string; onName: (name: string) => void; value: Cable; onChange: (value: Cable) => void; definitions: Definition[]; workspaceId?: string | null; errors?: Record<string, string>; onAuthorityChange: (denied: boolean) => void; actions: ReactNode; notices: ReactNode }) {
  const sources = useCableSources(value, workspaceId, onAuthorityChange);
  const stacks = sources.denied ? [] : sources.resolved.map(r => r.data);
  const bodies = useBodies(stacks);
  const shown = sources.denied ? { ...value, assignments: [] } : value;
  return <CableWorkbench mode="new" name={name.trim() || 'New cable'} cable={shown} onChange={onChange} stacks={stacks} bodies={bodies} stock={sources.denied ? undefined : sources.stock.data}
    revision={{ value: 'New', sub: 'not saved yet' }} actions={actions} notices={notices} onAccept={onChange}
    cableForm={<InspectionScope permission="item.create"><Stack gap="sm"><TextInput label="Cable name" value={name} onChange={(e) => onName(e.currentTarget.value)} />
      <CableFields value={value} onChange={onChange} definitions={definitions} errors={errors} sources={sources} /></Stack></InspectionScope>}
    endForms={value.endpoints.map((_e, index) => <InspectionScope key={index} permission="item.create"><EndCard index={index} value={value} onChange={onChange} errors={errors ?? {}} family={sources.family} definitions={definitions} choices={sources.choices} denied={sources.denied} resolved={sources.resolved[index]!} /></InspectionScope>)} />;
}

function DraftBench({ name, workspaceId, draft, committedDraft, hidden, definitions, onSaved, onAuthorityChange, onStateChange, onMutationError, freezeAction, freezeError }: { name: string; workspaceId?: string | null; draft: Draft; committedDraft: Draft | null; hidden: boolean; definitions: Definition[]; onSaved: () => Promise<void>; onAuthorityChange: (denied: boolean) => void; onStateChange: (state: string) => void; onMutationError: (error: Error) => void; freezeAction: ReactNode; freezeError: string | null }) {
  const [sourceDenied, setSourceDenied] = useState(false);
  const [tried, setTried] = useState(false);
  const editGate = usePermission('design.edit');
  // Refocus/access refreshes may read a newer server state. Keep the editing baseline
  // and unsaved text together until this editor successfully saves or freezes.
  const [base, setBase] = useState(draft);
  const [value, setValue] = useState(() => draft.content.cable ?? initialCable());
  useEffect(() => onAuthorityChange(sourceDenied), [sourceDenied, onAuthorityChange]);
  useEffect(() => onStateChange(base.state), [base.state, onStateChange]);
  useEffect(() => {
    if (committedDraft?.draft_id === base.draft_id) setBase(current => ({ ...current, state: committedDraft.state }));
  }, [committedDraft, base.draft_id]);
  const sources = useCableSources(value, workspaceId, setSourceDenied);
  const stacks = sources.denied ? [] : sources.resolved.map(r => r.data);
  const bodies = useBodies(stacks);
  const save = useMutation({ mutationFn: () => command<Draft>("cable.update", { draft_id: base.draft_id, cable: value }, base.state), onSuccess: async data => { setBase(data); setValue(data.content.cable ?? initialCable()); await onSaved(); }, onError: onMutationError });
  const saveErrors = save.error instanceof CableOperationError ? save.error.fieldErrors : undefined;
  const accept = async (cable: Cable) => { const data = await command<Draft>("cable.update", { draft_id: base.draft_id, cable }, base.state); setBase(data); setValue(data.content.cable ?? initialCable()); await onSaved(); };
  if (hidden) return null;
  const shown = sources.denied ? { ...value, assignments: [] } : value;
  return <CableWorkbench mode="draft" name={name} cable={shown} onChange={editGate.allowed ? setValue : undefined} stacks={stacks} bodies={bodies} stock={sources.denied ? undefined : sources.stock.data}
    draftId={sourceDenied ? null : base.draft_id} checkVersion={base.state} revision={{ value: 'Draft', sub: base.state }} onAccept={sourceDenied ? undefined : accept}
    actions={<>
      <Button size="xs" variant="default" disabled={sourceDenied} loading={save.isPending} {...editGate.props} onClick={() => { setTried(true); if (cableProblems(value).length === 0) save.mutate(); }}>Save cable draft</Button>
      {freezeAction}
    </>}
    notices={<>{tried && <Missing problems={cableProblems(value)} />}<ReadOnlyNote permission="design.edit">Saving cable drafts is unavailable.</ReadOnlyNote>
      {save.isError && <Alert color="red">{save.error.message}</Alert>}{freezeError && <Alert color="red">{freezeError}</Alert>}
      {value !== base.content.cable && !save.isPending && base.content.cable?.intent_revision_id && <Text size="xs" c="dimmed">Check and Propose read the saved draft.</Text>}</>}
    cableForm={<InspectionScope permission="design.edit"><CableFields errors={saveErrors} value={value} onChange={setValue} definitions={definitions} sources={sources} /></InspectionScope>}
    endForms={value.endpoints.map((_e, index) => <InspectionScope key={index} permission="design.edit"><EndCard index={index} value={value} onChange={setValue} errors={saveErrors ?? {}} family={sources.family} definitions={definitions} choices={sources.choices} denied={sources.denied} resolved={sources.resolved[index]!} /></InspectionScope>)} />;
}
/** What a cable still needs before it can be saved, listed after a save was attempted. */
function Missing({ problems }: { problems: string[] }) {
  if (!problems.length) return null;
  return <Alert color="orange" role="alert" title="Not saved yet"><Stack gap={2}>{problems.map(problem => <Text key={problem} size="sm">{problem}</Text>)}</Stack></Alert>;
}
type Choice = { value: string; label: string; display: string; look: ReturnType<typeof appearanceOf> };
/** Conductive elements of a stock as termination rows: the stock's label and color for display, the path kept for identity. */
function elements(structure: Parameters<typeof conductiveElements>[0]): Choice[] {
  return conductiveElements(structure).map(e => ({ value: e.path, label: `${e.path} · ${e.label} (${e.kind})`, display: e.display, look: e.look }));
}

type Sources = ReturnType<typeof useCableSources>;
/**
 * Everything a cable's pinned references resolve to, read under the cable's authority: the stock,
 * every connector/board layer revision and each end's resolved stack. A denial withdraws retained choices.
 */
export function useCableSources(value: Cable, workspaceId: string | null | undefined, onAuthorityChange?: (denied: boolean) => void) {
  const stock = useQuery({ queryKey: ['cable-stock', value.stock_revision_id], queryFn: () => loadFrozenStock(value.stock_revision_id), enabled: !!value.stock_revision_id });
  const references = [...new Map(value.endpoints.flatMap(endpoint => (endpoint.stack?.layers ?? []).flatMap(layer =>
    layer.kind === 'connector' ? [{ key: 'cable-body', id: layer.body_revision_id }] : layer.kind === 'board' ? [{ key: 'cable-board', id: layer.board_revision_id }] : [],
  )).filter(reference => reference.id).map(reference => [`${reference.key}:${reference.id}`, reference])).values()];
  const sources = useQueries({ queries: references.map(reference => ({
    queryKey: [reference.key, reference.id],
    queryFn: () => read<InterfaceInspection>(`interfaces/revisions/${reference.id}`),
  })) });
  const resolved = useResolvedStacks(value.endpoints);
  const denied = stock.isError || sources.some(source => source.isError) || resolved.some(r => r.isError && resolveDenied(r.error));
  useEffect(() => onAuthorityChange?.(denied), [denied, onAuthorityChange]);
  const choices = stock.data && !denied ? elements(stock.data.structure) : [];
  // A connector-family preference only narrows the body picker by name; it never selects a body or asserts compatibility.
  const families = usePreferenceDefaults(workspaceId).list('connector_families');
  const familyKey = families.join('\u0000');
  const [family, setFamily] = useState<string | null>(null);
  const [familyFromPreference, setFamilyFromPreference] = useState(false);
  const [familyTouched, setFamilyTouched] = useState(false);
  useEffect(() => { if (familyKey && !familyTouched) { setFamily(familyKey.split('\u0000')[0] ?? null); setFamilyFromPreference(true); } }, [familyKey, familyTouched]);
  const chooseFamily = (next: string | null) => { setFamilyTouched(true); setFamilyFromPreference(false); setFamily(next); };
  return { stock, resolved, denied, choices, families, family, familyFromPreference, chooseFamily };
}

/** The whole-cable fields: stock, intent, connector family filter, lengths and review. */
export function CableFields({ value, onChange, definitions, sources, errors = {}, showReview = true, showSelections = true }: { showSelections?: boolean; showReview?: boolean; value: Cable; onChange: (value: Cable) => void; definitions?: Definition[]; sources: Sources; errors?: Record<string, string> }) {
  const setStock = useCallback((stock_revision_id: string) => onChange({ ...value, stock_revision_id }), [onChange, value]);
  const { stock, denied, choices, families, family, familyFromPreference, chooseFamily } = sources;
  return <Stack gap="sm">
    {showSelections && <><Stack gap="xs" aria-label="Stock">
      <Title order={4}>Stock</Title>
      <Text size="sm" c="dimmed">The wire material this cable is cut from.</Text>
      <RevisionPicker error={errors["cable.stock_revision_id"]} label="Stock" title="Stock" kind="wire_stock" value={value.stock_revision_id} onChange={setStock} definitions={definitions} />
      {stock.isError && <Alert color="red">{stock.error.message}</Alert>}
    </Stack>
    <Stack gap="xs" aria-label="Intent">
      <Title order={4}>Intent</Title>
      <Text size="sm" c="dimmed">What this cable must connect, if stated. Checking the cable against it comes later; it never passes by itself.</Text>
      <RevisionPicker label="Intent" title="Cable intent (optional)" kind="cable_intent" value={value.intent_revision_id ?? ''} onChange={intent => onChange({ ...value, intent_revision_id: intent || null })} definitions={definitions} />
    </Stack>
    </>}{families.length > 0 && <Group align="flex-end" gap="xs"><Select label="Connector family filter" description="Narrows connector body choices by name." clearable data={families} value={family} onChange={chooseFamily} />
      {familyFromPreference && family !== null && <FromPreference what="connector family filter" onClear={() => chooseFamily(null)} />}</Group>}
    {!denied && <LengthsEditor value={value.lengths} onChange={lengths => onChange({ ...value, lengths })} choices={choices} endpoints={value.endpoints.map(e => e.local_id)} />}
    {showReview && <Stack gap="xs" aria-label="Review">
      <Title order={4}>Review</Title>
      <Select label="Review status" data={['unreviewed', 'reviewed']} value={value.review} onChange={review => onChange({ ...value, review: review as Cable['review'] })} />
      <TextInput label="Review basis" description="Required once reviewed." value={value.review_basis ?? ''} onChange={event => onChange({ ...value, review_basis: event.currentTarget.value || null })} />
    </Stack>}
  </Stack>;
}

/** The whole cable as stacked forms (summary, cable fields, each end): the inspector's forms in one column. */
export function CableEditor({ value, onChange, definitions, onAuthorityChange, workspaceId, errors = {} }: { errors?: Record<string, string>; workspaceId?: string | null; value: Cable; onChange: (value: Cable) => void; definitions: Definition[]; onAuthorityChange?: (denied: boolean) => void }) {
  const sources = useCableSources(value, workspaceId, onAuthorityChange);
  const { stock, resolved, denied, choices, family } = sources;
  return <Stack>
    <CableSummary cable={denied ? { ...value, assignments: [] } : value} elementCount={stock.data && !denied ? choices.length : null} stacks={denied ? [] : resolved.map(r => r.data)} />
    <CableFields value={value} onChange={onChange} definitions={definitions} sources={sources} errors={errors} />
    {value.endpoints.map((_endpoint, index) => <EndCard key={index} index={index} value={value} onChange={onChange} errors={errors} family={family} definitions={definitions} choices={choices} denied={denied} resolved={resolved[index]!} />)}
  </Stack>;
}
const HIDDEN_LABEL = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' } as const;
const DEFAULT_NOTE = 'Declared in the cable editor';
const letter = (index: number) => String.fromCharCode(65 + index);
const STOCK_ENDS = [{ value: 'unknown', label: 'Stock end unknown' }, { value: 'a', label: 'Stock end A' }, { value: 'b', label: 'Stock end B' }];
export function EndCard({ index, value, onChange, errors, family, definitions, choices, denied, resolved }: { index: number; value: Cable; onChange: (value: Cable) => void; errors: Record<string, string>; family: string | null; definitions?: Definition[]; choices: Choice[]; denied: boolean; resolved: UseQueryResult<ResolvedStack> }) {
  const endpoint = value.endpoints[index]!;
  const [showId, setShowId] = useState(false);
  const [showLayers, setShowLayers] = useState(false);
  const patch = (change: Partial<Endpoint>) => onChange({ ...value, endpoints: value.endpoints.map((e, i) => i === index ? { ...e, ...change } : e) });
  const name = `Endpoint ${index + 1}`;
  const fromAssembly = endpoint.end_assembly_revision_id !== null;
  const data = denied ? undefined : resolved.data;
  return <Stack>
    <Title order={4}>{endName(endpoint)}</Title>
    <Group align="flex-end" gap="xs" wrap="wrap">
      <TextInput label={`End ${letter(index)} name (optional)`} aria-label={`Endpoint ${index + 1} label`} placeholder={`End ${letter(index)}`} value={endpoint.label ?? ''} onChange={event => patch({ label: event.currentTarget.value || null })} />
      <Select label="Uses stock end" aria-label={`${name} stock end`} description="Which end of the stock this end is on." data={STOCK_ENDS} value={endpoint.stock_end} onChange={v => patch({ stock_end: (v ?? 'unknown') as Endpoint['stock_end'] })} />
    </Group>
    <Anchor component="button" type="button" size="xs" w="fit-content" aria-expanded={showId} onClick={() => setShowId(open => !open)}>{showId ? '▾' : '▸'} Advanced: stable ID</Anchor>
    {showId && <TextInput label={`Endpoint ${index + 1} stable ID`} description="Renaming an ID retains its current assignments." value={endpoint.local_id} onChange={event => { const local_id = event.currentTarget.value; onChange({ ...value, endpoints: value.endpoints.map((e, i) => i === index ? { ...e, local_id } : e), assignments: value.assignments.map(a => a.endpoint_id === endpoint.local_id ? { ...a, endpoint_id: local_id } : a) }); }} />}
    <SegmentedControl size="xs" w="fit-content" aria-label={`${name} end source`} value={fromAssembly ? 'assembly' : endpoint.stack ? 'stack' : ''} onChange={mode => patch(mode === 'assembly' ? { end_assembly_revision_id: '', stack: null } : { end_assembly_revision_id: null, stack: connectorStack() })}
      data={[{ value: 'assembly', label: 'Reusable end assembly' }, { value: 'stack', label: 'Build this end here' }]} />
    {!fromAssembly && !endpoint.stack && <Text size="sm" c="orange" role="status">Choose an end assembly or build this end.</Text>}
    {fromAssembly && <>
      <RevisionPicker error={errors[`cable.endpoints.${index}.end_assembly_revision_id`]} label={`${name} end assembly`} title="End assembly" kind="end_assembly" nameFilter={family} value={endpoint.end_assembly_revision_id ?? ''} onChange={end_assembly_revision_id => patch({ end_assembly_revision_id })} definitions={definitions} />
      {data && <><StackDiagram layers={resolvedChips(data)} label={`${name} stack`} />
        <Anchor component="button" type="button" size="xs" w="fit-content" aria-expanded={showLayers} onClick={() => setShowLayers(open => !open)}>{showLayers ? '▾' : '▸'} Layers, pads and pins</Anchor>
        {showLayers && <StackView resolved={data} label={name} />}</>}
    </>}
    {!fromAssembly && endpoint.stack && <StackEditor label={name} value={endpoint.stack} onChange={stack => patch({ stack })} definitions={definitions} resolved={data} nameFilter={family} />}
    {resolved.isError && <Alert color={resolveDenied(resolved.error) ? 'red' : 'orange'}>{resolved.error.message}</Alert>}
    <TerminationEditor value={value} index={index} choices={choices} onChange={onChange} denied={denied} hasStock={!!value.stock_revision_id} resolved={data} />
  </Stack>;
}
/** One end's terminations as a table: the accessible fallback to landing wires in the drawing. */
function TerminationEditor({ value, index, choices, onChange, denied, hasStock, resolved }: { value: Cable; index: number; choices: Choice[]; onChange: (value: Cable) => void; denied: boolean; hasStock: boolean; resolved: ResolvedStack | undefined }) {
  const endpoint = value.endpoints[index]!;
  const [notes, setNotes] = useState<Record<string, string>>({});
  const own = denied ? [] : value.assignments.filter(a => a.endpoint_id === endpoint.local_id);
  const rows: Choice[] = [...choices, ...own.filter(a => !choices.some(c => c.value === a.element_path)).map(a => ({ value: a.element_path, label: a.element_path, display: `${a.element_path} (not in this stock)`, look: appearanceOf({ kind: 'conductor', color: null, material: null, construction: null }) }))];
  const groups = targetOptions(resolved);
  const known = new Set(groups.flatMap(g => g.items.map(i => i.value)));
  const stale = own.filter(a => !known.has(terminalKey(a))).map(a => ({ value: terminalKey(a), label: `${a.layer_id} / ${a.terminal_id} (not in this end)` }));
  const data = stale.length ? [...groups, { group: 'Not in this end', items: [...new Map(stale.map(s => [s.value, s])).values()] }] : groups;
  const name = `Endpoint ${index + 1}`;
  const assign = (path: string, target: string | null) => {
    const others = value.assignments.filter(a => !(a.endpoint_id === endpoint.local_id && a.element_path === path));
    const previous = own.find(a => a.element_path === path);
    onChange({ ...value, assignments: target ? [...others, { endpoint_id: endpoint.local_id, element_path: path, ...splitKey(target), basis: previous?.basis ?? (notes[path]?.trim() || DEFAULT_NOTE) }] : others });
  };
  const note = (path: string, text: string) => {
    if (own.some(a => a.element_path === path)) onChange({ ...value, assignments: value.assignments.map(a => a.endpoint_id === endpoint.local_id && a.element_path === path ? { ...a, basis: text } : a) });
    else setNotes(current => ({ ...current, [path]: text }));
  };
  return <Stack gap="xs">
    <Group justify="space-between"><Text fw={600} size="sm">Terminations at {endName(endpoint)}</Text><Text size="xs">{choices.length ? `${own.length} of ${choices.length} terminated` : `${own.length} terminated`}</Text></Group>
    {!denied && !hasStock && <Text size="sm" role="status">Choose a stock to list its conductors, shields and drains.</Text>}
    {!denied && hasStock && !resolved && <Text size="sm" role="status">Choose this end's layers to list its pads and pins.</Text>}
    {rows.length > 0 && <Table.ScrollContainer minWidth={560}><Table aria-label={`${name} terminations`} verticalSpacing={4}>
      <Table.Thead><Table.Tr><Table.Th>Conductor / shield / drain</Table.Th><Table.Th>Lands on</Table.Th><Table.Th>Signal</Table.Th><Table.Th>Note / source</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{rows.map(row => {
        const assignment = own.find(a => a.element_path === row.value);
        const target = assignment ? findTerminal(resolved, assignment.layer_id, assignment.terminal_id).terminal : undefined;
        return <Table.Tr key={row.value}><Table.Td title={row.value}><Swatch look={row.look} />{row.display}</Table.Td>
          <Table.Td><Select size="xs" clearable searchable label={`${name} ${row.value} target`} styles={{ label: HIDDEN_LABEL }} placeholder="unassigned" disabled={denied || !resolved} data={data} value={denied || !assignment ? null : terminalKey(assignment)} onChange={target => assign(row.value, target)} /></Table.Td>
          <Table.Td>{target ? <SignalCell terminal={target} /> : assignment ? <SbUnknown what="Signal" /> : null}</Table.Td>
          <Table.Td><TextInput size="xs" aria-label={`${name} ${row.value} termination basis`} placeholder={DEFAULT_NOTE} value={assignment ? assignment.basis : notes[row.value] ?? ''} onChange={event => note(row.value, event.currentTarget.value)} /></Table.Td></Table.Tr>;
      })}</Table.Tbody></Table></Table.ScrollContainer>}
  </Stack>;
}

/**
 * A frozen cable on the workbench (read-only drawing, probe and check), with the recorded
 * inspection tables and stock views kept below as details.
 */
export function CableInspector({ revisionId, revisions = [] }: { revisionId: string; revisions?: { revision_id: string; number: number }[] }) {
  const cableLabel = useRevisionLabel(revisionId).data; const cableName = cableLabel?.readable ? cableLabel.name : undefined;
  const result = useQuery({ queryKey: ['cable-inspection', revisionId], queryFn: () => read<Inspection>(`cables/revisions/${revisionId}`) });
  const stockId = result.data?.cable.stock_revision_id;
  const stock = useQuery({ queryKey: ['cable-stock', stockId], queryFn: () => loadFrozenStock(stockId!), enabled: !!stockId && !result.isError });
  const data = result.data;
  const endLabel = (id: string) => { const e = data?.endpoints.find(x => x.local_id === id); return e ? endName(e) : id; };
  const targetText = (assignment: ResolvedTermination) => assignment.contact_id ?? `${assignment.terminal_label ?? assignment.terminal_id}${assignment.reaches?.[0] ? ` → ${assignment.reaches[0].label}` : ''}`;
  // Ends with an unknown stock end are not placed on a stock end face: every end's landing is listed.
  const terminationLabels = Object.fromEntries((data?.conductors ?? []).map(row => [row.element_path,
    row.ends.map(end => `${endLabel(end.endpoint_id)}: ${end.assignment ? targetText(end.assignment) : 'unassigned'}`).join('; ')]));
  // Each cable end is drawn on the stock end face it records; its own landings label that face.
  const cableEnds: CableEnd[] = (data?.endpoints ?? []).map(e => ({ endpointId: e.local_id, label: endName(e), stockEnd: e.stock_end ?? 'unknown',
    terminations: Object.fromEntries((data?.conductors ?? []).flatMap(row => { const end = row.ends.find(x => x.endpoint_id === e.local_id); return end?.assignment ? [[row.element_path, targetText(end.assignment)]] : []; })) }));
  const number = revisions.find(r => r.revision_id === revisionId)?.number ?? (cableLabel?.readable ? cableLabel.number : undefined);
  const endDetails = (data?.endpoints ?? []).map(endpoint => <Stack key={endpoint.local_id} gap="xs"><Text fw={600}>{endName(endpoint)} ({endpoint.local_id})</Text>
    <Text size="sm">{endpoint.stock_end && endpoint.stock_end !== 'unknown' ? `Uses stock end ${endpoint.stock_end.toUpperCase()}` : <SbUnknown what="Stock end" />}</Text>
    {endpoint.end_assembly_revision_id && <Text size="sm"><RevisionLabel id={endpoint.end_assembly_revision_id} role="End assembly" /></Text>}
    {endpoint.resolved_stack && <StackView resolved={endpoint.resolved_stack} label={endName(endpoint)} />}
    {endpoint.body && endpoint.pinout && <>
      <Text size="sm"><RevisionLabel id={endpoint.body_revision_id!} role="Body" />; <RevisionLabel id={endpoint.pinout_revision_id!} role="pinout" /></Text><Text size="sm">Body drawing side: {endpoint.body.drawing_orientation.viewing_side}; pinout viewing side: {endpoint.pinout.orientation.viewing_side}</Text>
      <Table.ScrollContainer minWidth={420}><Table><Table.Thead><Table.Tr><Table.Th>Contact</Table.Th><Table.Th>Signal / role</Table.Th><Table.Th>Voltage range (V)</Table.Th><Table.Th>Current limit (A)</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{endpoint.body.contacts.map(contact => { const electrical = endpoint.pinout!.assignments.find(a => a.contact_id === contact.contact_id)?.electrical; return <Table.Tr key={contact.contact_id}><Table.Td>{contact.contact_id} ({contact.physical_role})</Table.Td><Table.Td>{electrical?.signal ?? 'unknown'} / {electrical?.role ?? 'unknown'}</Table.Td><Table.Td>{electrical?.voltage_min_v ?? 'unknown'} to {electrical?.voltage_max_v ?? 'unknown'}</Table.Td><Table.Td>{electrical?.current_max_a ?? 'unknown'}</Table.Td></Table.Tr>; })}</Table.Tbody></Table></Table.ScrollContainer>
    </>}
    {!endpoint.body && <Text size="xs" c="dimmed">No connector layer: contact ratings are not evaluated for this end.</Text>}
  </Stack>);
  return <Stack gap="xs" aria-label="Frozen cable inspection">
    {result.isError && <Alert color="red">{result.error.message}</Alert>}
    {data && !result.isError && <CableWorkbench mode="frozen" name={cableName ?? 'Frozen cable'} cable={data.cable} stacks={data.endpoints.map(e => e.resolved_stack)} bodies={data.endpoints.map(e => e.body)}
      stock={stock.isError ? undefined : stock.data} conductors={data.conductors} revisionId={revisionId}
      revision={{ value: number ? `r${number}` : 'Frozen', sub: 'frozen · immutable' }}
      notices={data.stored_schema_version === '0.1' ? <Text size="xs" c="dimmed">Recorded before end stacks: each end reads as one connector layer, stock end unknown.</Text> : null}
      cableForm={<Stack gap="xs">
        <Text size="sm"><RevisionLabel id={revisionId} /></Text>
        <Text size="sm">Review: {data.cable.review}; basis: {data.cable.review_basis ?? 'unknown'}</Text>
        {data.intent && <Text size="sm">Intent: <RevisionLabel id={data.intent.revision_id} /></Text>}
        <Text size="sm">Continuity: {data.continuity}. Compatibility: {data.compatibility}. Physical qualification: {data.physical_qualification}.</Text>
        <StockLink revisionId={data.cable.stock_revision_id} />
        {data.lengths && <LengthInspection projection={data.lengths} />}
      </Stack>}
      endForms={endDetails}
      details={<details className="cwb-details">
        <summary>Recorded tables, check evidence and stock views</summary>
        <Stack gap="sm" mt="xs">
          <CableSummary cable={data.cable} elementCount={data.conductors.length} stacks={data.endpoints.map(e => e.resolved_stack)} />
          <IntentCheckPanel revisionId={revisionId} intentRevisionId={data.cable.intent_revision_id ?? null} />
          <Title order={4}>Terminations</Title>
          <Table.ScrollContainer minWidth={420}><Table aria-label="Cable terminations"><Table.Thead><Table.Tr><Table.Th>Stable stock feature</Table.Th>{data.endpoints.map(e => <Table.Th key={e.local_id}>{endName(e)} ({e.local_id})</Table.Th>)}</Table.Tr></Table.Thead><Table.Tbody>
            {data.conductors.map(row => <Table.Tr key={row.element_path}><Table.Td>{row.element_path} · {row.kind}</Table.Td>{row.ends.map(end => <Table.Td key={end.endpoint_id}>{end.assignment ? <>{end.assignment.layer_kind && end.assignment.layer_kind !== 'connector' ? `${end.assignment.layer_kind} ` : ''}{targetText(end.assignment)}{end.assignment.signal ? ` · ${end.assignment.signal.name}` : end.assignment.reaches?.[0]?.signal ? ` · ${end.assignment.reaches[0].signal.name}` : ''} · {end.assignment.basis}</> : 'unknown / unassigned'}</Table.Td>)}</Table.Tr>)}
          </Table.Tbody></Table></Table.ScrollContainer>
          <LengthImpactView key={`impact:${revisionId}`} afterRevision={revisionId} name={cableName} revisions={revisions} />
          <Card withBorder aria-label="Stock used"><Stack gap="xs">
            <Title order={4}>Stock used: <RevisionLabel id={data.cable.stock_revision_id} /></Title>
            <Text size="sm" c="dimmed">The wire material this cable is cut from. Its cross-section and end faces are the stock's, not the finished cable's.</Text>
            <StockLink revisionId={data.cable.stock_revision_id} />
            {stock.isError && <Alert color="red">{stock.error.message}</Alert>}
            {stock.data && !stock.isError && <CableViews stock={stock.data} name={`Stock ${stockId}`} revisionId={stockId} terminationLabels={terminationLabels} cableEnds={cableEnds} choosePreparation />}
          </Stack></Card>
        </Stack>
      </details>} />}
  </Stack>;
}
