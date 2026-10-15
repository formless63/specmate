import { useRevisionLabel } from "../../lib/revision-labels";
import { ReadOnlyNote, usePermission, InspectionScope } from "../../lib/permissions";
import { LengthsEditor, LengthInspection, LengthImpactView } from "./Lengths";
import { Alert, Anchor, Button, Card, Group, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useMutation, useQueries, useQuery, useQueryClient, type Query, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadFrozenStock } from '../wire-stock/viewer-api';
import { CableViews } from '../cable-views/CableViews';
import { useProbedSelection } from '../cable-views/useProbedSelection';
import { useProbe } from '../probe';
import type { StockElement } from '../../../../packages/section-layout/src';
import type { Inspection as InterfaceInspection } from '../interfaces/api';
import { CableOperationError, authorityDenied, command, read, initialCable, type Cable, type Endpoint, type Definition, type Draft, type Identity, type Inspection } from './api';
import { revisionOptionLabel, useRevisionLabel as useLabel } from "../../lib/revision-labels";
import { CableSummary, StockLink, endName } from './CableSummary';
import { Swatch } from '../cable-views/Swatch';
import { appearanceOf } from '../../../../packages/section-layout/src';
import { RevisionLabel } from "../../lib/IdentityLabel";
import { FromPreference, usePreferenceDefaults } from "../preferences/usePreferenceDefaults";

export function CablePanel({ projectId, workspaceId }: { projectId: string | null; workspaceId?: string | null }) { return <Workspace key={projectId ?? 'workspace'} projectId={projectId} workspaceId={workspaceId} />; }
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
  const pickDefinition = useCallback((id: string) => { setDefinitionId(id); setDraftId(null); setRevisionId(null); setDraftToken(undefined); setCommittedDraft(null); setOffset(0); }, []);
  useProbedSelection({ kind: 'cable', definitions: definitions.isError ? undefined : definitions.data, definitionId,
    revisions: identity.data?.definition_id === definitionId && offset === 0 ? identity.data.revisions : undefined, pickDefinition, pickRevision: setRevisionId });
  // The Library row for the probed definition already shows these views; show them once.
  const probedObject = useProbe()?.probe?.object ?? null;
  const shownAbove = !!definitionId && probedObject === definitionId;
  const createErrors = create.error instanceof CableOperationError ? create.error.fieldErrors : undefined;
  const workspaceDenied = authorityBlocked || definitions.isError || identity.isError;
  return <Stack>
    <Title order={2}>Cables</Title>
    <Text>A cable is a finished assembly: a wire stock cut to length with a connector and pinout at each end, and each conductor, shield and drain terminated to a contact. Review records declared terminations; continuity and physical qualification remain unevaluated.</Text>
    {authorityBlocked && <Alert color="red"><Stack><Text>Cable access must be rechecked before retained content can be shown.</Text><Button loading={checkingAuthority} onClick={() => void refreshAuthority()}>Refresh cable access</Button></Stack></Alert>}
    {!authorityBlocked && <Card withBorder><Stack>
      <Title order={3}>New cable</Title>
      <InspectionScope permission="item.create"><TextInput label="Cable name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
      <CableEditor errors={createErrors} value={value} onChange={setValue} definitions={currentDefinitions} workspaceId={workspaceId} onAuthorityChange={setCreateSourceDenied} /></InspectionScope>
      <Button disabled={!name.trim() || definitions.isError || createSourceDenied} loading={create.isPending} {...createGate.props} onClick={() => create.mutate()}>Create cable draft</Button><ReadOnlyNote permission="item.create">Creating drafts is unavailable.</ReadOnlyNote>
    </Stack></Card>}
    {create.isError && <Alert color="red">{create.error.message}</Alert>}
    {definitions.isError && <Alert color="red">{definitions.error.message}</Alert>}
    {!authorityBlocked && <Select label="Existing cable definition" searchable data={currentDefinitions.filter((d) => d.kind === "cable").map((d) => ({ value: d.definition_id, label: `${d.name} (${d.kind})` }))} value={definitions.isError ? null : definitionId} disabled={definitions.isError} onChange={(id) => { setDefinitionId(id); setDraftId(null); setRevisionId(null); setDraftToken(undefined); setCommittedDraft(null); setOffset(0); }} />}
    {identity.isError && <Alert color="red">{identity.error.message}</Alert>}
    {identity.data && !workspaceDenied && <>
      <Select label="Edit cable draft" value={draftId} onChange={id => { if (id !== draftId) { setDraftId(id); setDraftToken(undefined); setCommittedDraft(null); } }} data={identity.data.drafts.map((d) => ({ value: d.draft_id, label: `${d.draft_id} · ${d.state}` }))} />
      <Select label="Inspect frozen cable" value={revisionId} onChange={setRevisionId} data={identity.data.revisions.map((r) => ({ value: r.revision_id, label: revisionOptionLabel(identity.data.name, r.number) }))} />
      <Group><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous revisions</Button><Button disabled={Math.max(identity.data.revisions.length, identity.data.drafts.length) < 50} onClick={() => setOffset(offset + 50)}>Next revisions</Button></Group>
    </>}
    {draft.isError && <Alert color="red">{draft.error.message}</Alert>}
    {draft.data && draftId && <DraftEditor key={draft.data.draft_id} draft={draft.data} committedDraft={committedDraft} hidden={draft.isError || workspaceDenied} definitions={currentDefinitions} workspaceId={workspaceId} onStateChange={setDraftToken} onMutationError={mutationError} onAuthorityChange={setDraftSourceDenied} onSaved={async () => { await cache.invalidateQueries({ queryKey: ["cable-draft", draftId] }); }} />}
    {draft.data && !draft.isError && !workspaceDenied && <Button disabled={draftSourceDenied || !draftToken} loading={freeze.isPending} {...freezeGate.props} onClick={() => freeze.mutate()}>Freeze cable revision</Button>}
    {freeze.isError && <Alert color="red">{freeze.error.message}</Alert>}
    {revisionId && shownAbove && !workspaceDenied && <Text role="status" data-testid="views-shown-above">Frozen cable views are shown above, in the selected library row.</Text>}
    {revisionId && !shownAbove && !workspaceDenied && !draft.isError && <CableInspector key={revisionId} revisionId={revisionId} revisions={identity.data?.revisions ?? []} />}
  </Stack>;
}

function DraftEditor({ workspaceId, draft, committedDraft, hidden, definitions, onSaved, onAuthorityChange, onStateChange, onMutationError }: { workspaceId?: string | null; draft: Draft; committedDraft: Draft | null; hidden: boolean; definitions: Definition[]; onSaved: () => Promise<void>; onAuthorityChange: (denied: boolean) => void; onStateChange: (state: string) => void; onMutationError: (error: Error) => void }) {
  const [sourceDenied, setSourceDenied] = useState(false);
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
  const save = useMutation({ mutationFn: () => command<Draft>("cable.update", { draft_id: base.draft_id, cable: value }, base.state), onSuccess: async data => { setBase(data); setValue(data.content.cable ?? initialCable()); await onSaved(); }, onError: onMutationError });
  const saveErrors = save.error instanceof CableOperationError ? save.error.fieldErrors : undefined;
  if (hidden) return null;
  return <Card withBorder><Stack><Title order={3}>Edit draft</Title><Text size="sm">{base.state}</Text><InspectionScope permission="design.edit"><CableEditor errors={saveErrors} value={value} onChange={setValue} definitions={definitions} workspaceId={workspaceId} onAuthorityChange={setSourceDenied} /></InspectionScope><Button disabled={sourceDenied} loading={save.isPending} {...editGate.props} onClick={() => save.mutate()}>Save cable draft</Button><ReadOnlyNote permission="design.edit">Saving cable drafts is unavailable.</ReadOnlyNote>{save.isError && <Alert color="red">{save.error.message}</Alert>}</Stack></Card>;
}
/**
 * Picks one exact revision by name: a searchable definition select, then a revision select that
 * defaults to the latest frozen revision (older ones stay selectable). Pasting an exact revision
 * ID, including one from another project, is kept behind an Advanced disclosure.
 */
function RevisionPicker({ label, title, kind, value, onChange, definitions, nameFilter, error }: { error?: string; label: string; title?: string; kind: string; value: string; onChange: (v: string) => void; definitions: Definition[]; nameFilter?: string | null }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [advanced, setAdvanced] = useState(false);
  const autoPick = useRef<string | null>(null);
  // A value that arrives pinned (a saved draft, a pasted ID) names its own definition.
  const known = useLabel(value || null).data;
  const definition = chosen ?? (known?.readable ? known.definition_id ?? null : null);
  const identity = useQuery({ queryKey: ["cable-reference", definition, offset], queryFn: () => read<Identity>(`catalog/definitions/${definition}?offset=${offset}`), enabled: !!definition });
  const revisions = identity.isError ? [] : identity.data?.revisions ?? [];
  const single = offset === 0 && revisions.length < 50;
  // Choosing a definition selects its latest frozen revision once; the user may then pick an older one.
  useEffect(() => {
    if (!chosen || autoPick.current !== chosen || identity.data?.definition_id !== chosen || identity.isError) return;
    autoPick.current = null;
    const latest = single ? identity.data.revisions[identity.data.revisions.length - 1] : undefined;
    if (latest) onChange(latest.revision_id);
  }, [chosen, identity.data, identity.isError, single, onChange]);
  const latestId = single ? revisions[revisions.length - 1]?.revision_id : undefined;
  return <Stack gap="xs">
    <Group align="flex-start" gap="xs" grow wrap="wrap">
      <Select label={title ?? `${label} definition`} aria-label={`${label} definition`} searchable placeholder="Search by name" nothingFoundMessage="No match" value={definitions.some(d => d.definition_id === definition) ? definition : null}
        data={definitions.filter((d) => d.kind === kind && (!nameFilter || d.name.toLowerCase().includes(nameFilter.toLowerCase()))).map((d) => ({ value: d.definition_id, label: d.name }))}
        onChange={(v) => { setChosen(v); setOffset(0); autoPick.current = v; if (v !== definition) onChange(""); }} />
      <Select label={title ? 'Revision' : `${label} revision`} aria-label={`${label} revision`} value={identity.isError ? null : revisions.some(r => r.revision_id === value) ? value : null} disabled={identity.isError || !definition} error={error} onChange={(v) => onChange(v ?? "")}
        data={revisions.map((r) => ({ value: r.revision_id, label: revisionOptionLabel(identity.data?.name, r.number, r.revision_id === latestId ? 'latest' : undefined) }))} />
    </Group>
    {identity.data && !identity.isError && (offset > 0 || revisions.length >= 50) && <Group><Button size="xs" variant="subtle" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Earlier {label} revisions</Button><Button size="xs" variant="subtle" disabled={revisions.length < 50} onClick={() => setOffset(offset + 50)}>Later {label} revisions</Button></Group>}
    {identity.isError && <Alert color="red">{identity.error.message}</Alert>}
    <Anchor component="button" type="button" size="xs" w="fit-content" aria-label={`Advanced: paste exact revision ID for ${label}`} aria-expanded={advanced || !!error} onClick={() => setAdvanced(open => !open)}>{advanced || error ? '▾' : '▸'} Advanced: paste exact revision ID</Anchor>
    {(advanced || !!error) && <TextInput label={`${label} exact revision ID`} error={error} description="An accessible revision from another project can also be supplied." value={value} onChange={(e) => onChange(e.currentTarget.value)} />}
  </Stack>;
}

type Choice = { value: string; label: string; display: string; look: ReturnType<typeof appearanceOf> };
/** Conductive elements of a stock: the stock's own label and recorded colour for display, the path kept for identity. */
function elements(node: StockElement, prefix = ''): Choice[] {
  const path = prefix ? `${prefix}.${node.id}` : node.id;
  if (node.kind === 'group') return node.children.flatMap(child => elements(child, path));
  if (!['conductor', 'shield', 'drain'].includes(node.kind)) return [];
  const look = appearanceOf({ kind: node.kind, color: node.color, material: node.material, construction: 'construction' in node ? node.construction : null });
  const name = node.label?.trim() || path;
  return [{ value: path, label: `${path} · ${node.label} (${node.kind})`, display: node.color ? `${name} (${node.color})` : name, look }];
}
export function CableEditor({ value, onChange, definitions, onAuthorityChange, workspaceId, errors = {} }: { errors?: Record<string, string>; workspaceId?: string | null; value: Cable; onChange: (value: Cable) => void; definitions: Definition[]; onAuthorityChange?: (denied: boolean) => void }) {
  const stock = useQuery({ queryKey: ['cable-stock', value.stock_revision_id], queryFn: () => loadFrozenStock(value.stock_revision_id), enabled: !!value.stock_revision_id });
  const references = [...new Map(value.endpoints.flatMap(endpoint => [
    { key: 'cable-body', id: endpoint.body_revision_id },
    { key: 'cable-pinout', id: endpoint.pinout_revision_id },
  ]).map(reference => [`${reference.key}:${reference.id}`, reference])).values()];
  const sources = useQueries({ queries: references.map(reference => ({
    queryKey: [reference.key, reference.id],
    queryFn: () => read<InterfaceInspection>(`interfaces/revisions/${reference.id}`),
    enabled: !!reference.id,
  })) });
  const sourceFor = (key: string, id: string) => sources[references.findIndex(reference => reference.key === key && reference.id === id)]!;
  const denied = stock.isError || sources.some(source => source.isError);
  useEffect(() => onAuthorityChange?.(denied), [denied, onAuthorityChange]);
  const choices = stock.data && !denied ? elements(stock.data.structure) : [];
  // A connector-family preference only narrows the body picker by name; it never selects a body or asserts compatibility.
  const families = usePreferenceDefaults(workspaceId).list('connector_families');
  const familyKey = families.join('\u0000');
  const [family, setFamily] = useState<string | null>(null);
  const [familyFromPreference, setFamilyFromPreference] = useState(false);
  const [familyTouched, setFamilyTouched] = useState(false);
  useEffect(() => { if (familyKey && !familyTouched) { setFamily(familyKey.split('\u0000')[0] ?? null); setFamilyFromPreference(true); } }, [familyKey, familyTouched]);
  const setStock = useCallback((stock_revision_id: string) => onChange({ ...value, stock_revision_id }), [onChange, value]);
  return <Stack>
    <CableSummary cable={denied ? { ...value, assignments: [] } : value} elementCount={stock.data && !denied ? choices.length : null} />
    <Stack gap="xs" aria-label="Stock">
      <Title order={4}>Stock</Title>
      <Text size="sm" c="dimmed">The wire material this cable is cut from.</Text>
      <RevisionPicker error={errors["cable.stock_revision_id"]} label="Stock" title="Stock" kind="wire_stock" value={value.stock_revision_id} onChange={setStock} definitions={definitions} />
      {stock.isError && <Alert color="red">{stock.error.message}</Alert>}
    </Stack>
    {families.length > 0 && <Group align="flex-end" gap="xs"><Select label="Connector family filter" description="Narrows connector body choices by name." clearable data={families} value={family} onChange={v => { setFamilyTouched(true); setFamilyFromPreference(false); setFamily(v); }} />
      {familyFromPreference && family !== null && <FromPreference what="connector family filter" onClear={() => { setFamilyTouched(true); setFamilyFromPreference(false); setFamily(null); }} />}</Group>}
    {value.endpoints.map((endpoint, index) => <EndCard key={index} index={index} value={value} onChange={onChange} errors={errors} family={family} definitions={definitions} choices={choices} denied={denied} body={sourceFor('cable-body', endpoint.body_revision_id)} pinout={sourceFor('cable-pinout', endpoint.pinout_revision_id)} />)}
    {!denied && <LengthsEditor value={value.lengths} onChange={lengths => onChange({ ...value, lengths })} choices={choices} endpoints={value.endpoints.map(e => e.local_id)} />}
    <Stack gap="xs" aria-label="Review">
      <Title order={4}>Review</Title>
      <Select label="Review status" data={['unreviewed', 'reviewed']} value={value.review} onChange={review => onChange({ ...value, review: review as Cable['review'] })} />
      <TextInput label="Review basis" description="Required once reviewed." value={value.review_basis ?? ''} onChange={event => onChange({ ...value, review_basis: event.currentTarget.value || null })} />
    </Stack>
  </Stack>;
}
const HIDDEN_LABEL = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' } as const;
const DEFAULT_NOTE = 'Declared in the cable editor';
const letter = (index: number) => String.fromCharCode(65 + index);
function EndCard({ index, value, onChange, errors, family, definitions, choices, denied, body, pinout }: { index: number; value: Cable; onChange: (value: Cable) => void; errors: Record<string, string>; family: string | null; definitions: Definition[]; choices: Choice[]; denied: boolean; body: UseQueryResult<InterfaceInspection>; pinout: UseQueryResult<InterfaceInspection> }) {
  const endpoint = value.endpoints[index]!;
  const [showId, setShowId] = useState(false);
  const patch = (change: Partial<Endpoint>) => onChange({ ...value, endpoints: value.endpoints.map((e, i) => i === index ? { ...e, ...change } : e) });
  return <Card withBorder><Stack>
    <Title order={4}>{endName(endpoint)}</Title>
    <TextInput label={`End ${letter(index)} name (optional)`} aria-label={`Endpoint ${index + 1} label`} placeholder={`End ${letter(index)}`} value={endpoint.label ?? ''} onChange={event => patch({ label: event.currentTarget.value || null })} />
    <Anchor component="button" type="button" size="xs" w="fit-content" aria-expanded={showId} onClick={() => setShowId(open => !open)}>{showId ? '\u25BE' : '\u25B8'} Advanced: stable ID</Anchor>
    {showId && <TextInput label={`Endpoint ${index + 1} stable ID`} description="Renaming an ID retains its current assignments." value={endpoint.local_id} onChange={event => { const local_id = event.currentTarget.value; onChange({ ...value, endpoints: value.endpoints.map((e, i) => i === index ? { ...e, local_id } : e), assignments: value.assignments.map(a => a.endpoint_id === endpoint.local_id ? { ...a, endpoint_id: local_id } : a) }); }} />}
    <RevisionPicker error={errors[`cable.endpoints.${index}.body_revision_id`]} label={`Endpoint ${index + 1} body`} title="Connector" kind="connector_body" nameFilter={family} value={endpoint.body_revision_id} onChange={body_revision_id => patch({ body_revision_id })} definitions={definitions} />
    <RevisionPicker error={errors[`cable.endpoints.${index}.pinout_revision_id`]} label={`Endpoint ${index + 1} pinout`} title="Pinout" kind="pinout" value={endpoint.pinout_revision_id} onChange={pinout_revision_id => patch({ pinout_revision_id })} definitions={definitions} />
    <TerminationEditor value={value} index={index} choices={choices} onChange={onChange} denied={denied} hasStock={!!value.stock_revision_id} body={body} pinout={pinout} />
  </Stack></Card>;
}
/** One end's terminations: a row per conductor, shield and drain of the stock. Choosing a contact assigns it; clearing removes it. */
function TerminationEditor({ value, index, choices, onChange, denied, hasStock, body, pinout }: { value: Cable; index: number; choices: Choice[]; onChange: (value: Cable) => void; denied: boolean; hasStock: boolean; body: UseQueryResult<InterfaceInspection>; pinout: UseQueryResult<InterfaceInspection> }) {
  const endpoint = value.endpoints[index]!;
  const [notes, setNotes] = useState<Record<string, string>>({});
  const contacts = !denied && body.data?.interface.kind === 'connector_body' ? body.data.interface.contacts.filter(c => c.physical_role !== 'key') : [];
  const sameBody = !denied && pinout.data?.interface.kind === 'pinout' && pinout.data.interface.body_revision_id === endpoint.body_revision_id;
  const signals = new Map((pinout.data?.interface.kind === 'pinout' ? pinout.data.interface.assignments : []).map(a => [a.contact_id, a.electrical.signal] as const));
  const contactLabel = (c: (typeof contacts)[number]) => `${c.number ?? c.contact_id}${c.label ? ` ${c.label}` : ''}${signals.get(c.contact_id) ? ` · ${signals.get(c.contact_id)}` : ''} (${c.physical_role})`;
  const own = denied ? [] : value.assignments.filter(a => a.endpoint_id === endpoint.local_id);
  const rows: Choice[] = [...choices, ...own.filter(a => !choices.some(c => c.value === a.element_path)).map(a => ({ value: a.element_path, label: a.element_path, display: `${a.element_path} (not in this stock)`, look: appearanceOf({ kind: 'conductor', color: null, material: null, construction: null }) }))];
  const name = `Endpoint ${index + 1}`;
  const assign = (path: string, contact: string | null) => {
    const others = value.assignments.filter(a => !(a.endpoint_id === endpoint.local_id && a.element_path === path));
    const previous = own.find(a => a.element_path === path);
    onChange({ ...value, assignments: contact ? [...others, { endpoint_id: endpoint.local_id, element_path: path, contact_id: contact, basis: previous?.basis ?? (notes[path]?.trim() || DEFAULT_NOTE) }] : others });
  };
  const note = (path: string, text: string) => {
    if (own.some(a => a.element_path === path)) onChange({ ...value, assignments: value.assignments.map(a => a.endpoint_id === endpoint.local_id && a.element_path === path ? { ...a, basis: text } : a) });
    else setNotes(current => ({ ...current, [path]: text }));
  };
  return <Stack gap="xs">
    <Group justify="space-between"><Text fw={600} size="sm">Terminations at {endName(endpoint)}</Text><Text size="xs">{choices.length ? `${own.length} of ${choices.length} terminated` : `${own.length} terminated`}</Text></Group>
    {body.isError && <Alert color="red">{body.error.message}</Alert>}{pinout.isError && <Alert color="red">{pinout.error.message}</Alert>}
    {pinout.data && !denied && !sameBody && <Alert color="orange">The pinout must reference this exact body revision.</Alert>}
    {!denied && !hasStock && <Text size="sm" role="status">Choose a stock to list its conductors, shields and drains.</Text>}
    {rows.length > 0 && <Table.ScrollContainer minWidth={420}><Table aria-label={`${name} terminations`} verticalSpacing={4}>
      <Table.Thead><Table.Tr><Table.Th>Conductor / shield / drain</Table.Th><Table.Th>Contact</Table.Th><Table.Th>Note / source</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{rows.map(row => {
        const assignment = own.find(a => a.element_path === row.value);
        const free = contacts.filter(c => c.contact_id === assignment?.contact_id || !own.some(a => a.contact_id === c.contact_id));
        return <Table.Tr key={row.value}><Table.Td title={row.value}><Swatch look={row.look} />{row.display}</Table.Td>
          <Table.Td><Select size="xs" clearable label={`${name} ${row.value} contact`} styles={{ label: HIDDEN_LABEL }} placeholder="unassigned" disabled={denied || !sameBody} data={free.map(c => ({ value: c.contact_id, label: contactLabel(c) }))} value={denied ? null : assignment?.contact_id ?? null} onChange={contact => assign(row.value, contact)} /></Table.Td>
          <Table.Td><TextInput size="xs" aria-label={`${name} ${row.value} termination basis`} placeholder={DEFAULT_NOTE} value={assignment ? assignment.basis : notes[row.value] ?? ''} onChange={event => note(row.value, event.currentTarget.value)} /></Table.Td></Table.Tr>;
      })}</Table.Tbody></Table></Table.ScrollContainer>}
  </Stack>;
}
export function CableInspector({ revisionId, revisions = [] }: { revisionId: string; revisions?: { revision_id: string; number: number }[] }) {
  const cableLabel = useRevisionLabel(revisionId).data; const cableName = cableLabel?.readable ? cableLabel.name : undefined;
  const result = useQuery({ queryKey: ['cable-inspection', revisionId], queryFn: () => read<Inspection>(`cables/revisions/${revisionId}`) });
  const stockId = result.data?.cable.stock_revision_id;
  const stock = useQuery({ queryKey: ['cable-stock', stockId], queryFn: () => loadFrozenStock(stockId!), enabled: !!stockId && !result.isError });
  // The cable record does not say which stock end each endpoint is, so every endpoint's contact is listed.
  const terminationLabels = Object.fromEntries((result.data?.conductors ?? []).map(row => [row.element_path,
    row.ends.map(end => `${result.data!.cable.endpoints.find(e => e.local_id === end.endpoint_id)?.label ?? end.endpoint_id}: ${end.assignment?.contact_id ?? 'unassigned'}`).join('; ')]));
  const data = result.data;
  return <Card withBorder><Stack><Title order={3}>Frozen cable inspection</Title><Text><RevisionLabel id={revisionId} /></Text>
    {result.isError && <Alert color="red">{result.error.message}</Alert>}
    {data && !result.isError && <>
      <CableSummary cable={data.cable} elementCount={data.conductors.length} />
      <Text>Review: {data.cable.review}; basis: {data.cable.review_basis ?? 'unknown'}</Text>
      <Text>Continuity: {data.continuity}. Compatibility: {data.compatibility}. Physical qualification: {data.physical_qualification}.</Text>
      {data.lengths && <LengthInspection projection={data.lengths} />}
      <Title order={4}>Terminations</Title>
      <Table.ScrollContainer minWidth={420}><Table aria-label="Cable terminations"><Table.Thead><Table.Tr><Table.Th>Stable stock feature</Table.Th>{data.cable.endpoints.map(e => <Table.Th key={e.local_id}>{endName(e)} ({e.local_id})</Table.Th>)}</Table.Tr></Table.Thead><Table.Tbody>
        {data.conductors.map(row => <Table.Tr key={row.element_path}><Table.Td>{row.element_path} · {row.kind}</Table.Td>{row.ends.map(end => <Table.Td key={end.endpoint_id}>{end.assignment ? `${end.assignment.contact_id} · ${end.assignment.basis}` : 'unknown / unassigned'}</Table.Td>)}</Table.Tr>)}
      </Table.Tbody></Table></Table.ScrollContainer>
      {data.endpoints.map(endpoint => <Card key={endpoint.local_id} withBorder><Text fw={600}>{endName(endpoint)} ({endpoint.local_id})</Text><Text><RevisionLabel id={endpoint.body_revision_id} role="Body" />; <RevisionLabel id={endpoint.pinout_revision_id} role="pinout" /></Text><Text>Body drawing side: {endpoint.body.drawing_orientation.viewing_side}; pinout viewing side: {endpoint.pinout.orientation.viewing_side}</Text>
        <Table.ScrollContainer minWidth={420}><Table><Table.Thead><Table.Tr><Table.Th>Contact</Table.Th><Table.Th>Signal / role</Table.Th><Table.Th>Voltage range (V)</Table.Th><Table.Th>Current limit (A)</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{endpoint.body.contacts.map(contact => { const electrical = endpoint.pinout.assignments.find(a => a.contact_id === contact.contact_id)?.electrical; return <Table.Tr key={contact.contact_id}><Table.Td>{contact.contact_id} ({contact.physical_role})</Table.Td><Table.Td>{electrical?.signal ?? 'unknown'} / {electrical?.role ?? 'unknown'}</Table.Td><Table.Td>{electrical?.voltage_min_v ?? 'unknown'} to {electrical?.voltage_max_v ?? 'unknown'}</Table.Td><Table.Td>{electrical?.current_max_a ?? 'unknown'}</Table.Td></Table.Tr>; })}</Table.Tbody></Table></Table.ScrollContainer>
      </Card>)}
      <LengthImpactView key={`impact:${revisionId}`} afterRevision={revisionId} name={cableName} revisions={revisions} />
      <Card withBorder aria-label="Stock used"><Stack gap="xs">
        <Title order={4}>Stock used: <RevisionLabel id={data.cable.stock_revision_id} /></Title>
        <Text size="sm" c="dimmed">The wire material this cable is cut from. Its cross-section and end faces are the stock's, not the finished cable's.</Text>
        <StockLink revisionId={data.cable.stock_revision_id} />
        {stock.isError && <Alert color="red">{stock.error.message}</Alert>}
        {stock.data && !stock.isError && <CableViews stock={stock.data} name={`Stock ${stockId}`} revisionId={stockId} terminationLabels={terminationLabels} choosePreparation />}
      </Stack></Card>
    </>}
  </Stack></Card>;
}
