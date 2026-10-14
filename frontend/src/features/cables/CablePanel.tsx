import { ReadOnlyNote, usePermission } from "../../lib/permissions";
import { LengthsEditor, LengthInspection, LengthImpactView } from "./Lengths";
import { Alert, Button, Card, Group, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useMutation, useQueries, useQuery, useQueryClient, type Query, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { loadFrozenStock } from '../wire-stock/viewer-api';
import { CableViews } from '../cable-views/CableViews';
import type { StockElement } from '../../../../packages/section-layout/src';
import type { Inspection as InterfaceInspection } from '../interfaces/api';
import { authorityDenied, command, read, initialCable, type Cable, type Definition, type Draft, type Identity, type Inspection } from './api';

export function CablePanel({ projectId }: { projectId: string }) { return <Workspace key={projectId} projectId={projectId} />; }
function Workspace({ projectId }: { projectId: string }) {
  const cache = useQueryClient();
  const editGate = usePermission('design.edit');
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
  const definitions = useQuery({ queryKey: ["cable-definitions", projectId], queryFn: () => read<Definition[]>(`projects/${projectId}/definitions`) });
  const identity = useQuery({ queryKey: ["cable-identity", definitionId, offset], queryFn: () => read<Identity>(`catalog/definitions/${definitionId}?offset=${offset}`), enabled: !!definitionId });
  const draft = useQuery({ queryKey: ["cable-draft", draftId], queryFn: () => read<Draft>(`cables/drafts/${draftId}`), enabled: !!draftId });
  const create = useMutation({ mutationFn: () => command<Draft>("cable.create", { project_id: projectId, name, cable: value }), onSuccess: async (data) => {
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
  const workspaceDenied = authorityBlocked || definitions.isError || identity.isError;
  return <Stack>
    <Title order={2}>Cable endpoints and terminations</Title>
    <Text>Compose exact stock, body and pinout revisions. Assignments preserve each conductor, shield and drain identity. Review records declared terminations; continuity and physical qualification remain unevaluated.</Text>
    {authorityBlocked && <Alert color="red"><Stack><Text>Cable access must be rechecked before retained content can be shown.</Text><Button loading={checkingAuthority} onClick={() => void refreshAuthority()}>Refresh cable access</Button></Stack></Alert>}
    {!authorityBlocked && <Card withBorder><Stack>
      <Title order={3}>New reusable definition</Title>
      <TextInput label="Definition name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
      <CableEditor value={value} onChange={setValue} definitions={currentDefinitions} onAuthorityChange={setCreateSourceDenied} />
      <Button disabled={!name.trim() || definitions.isError || createSourceDenied} loading={create.isPending} {...editGate.props} onClick={() => create.mutate()}>Create cable draft</Button><ReadOnlyNote permission="design.edit">Creating drafts is unavailable.</ReadOnlyNote>
    </Stack></Card>}
    {create.isError && <Alert color="red">{create.error.message}</Alert>}
    {definitions.isError && <Alert color="red">{definitions.error.message}</Alert>}
    {!authorityBlocked && <Select label="Existing cable definition" searchable data={currentDefinitions.filter((d) => d.kind === "cable").map((d) => ({ value: d.definition_id, label: `${d.name} (${d.kind})` }))} value={definitions.isError ? null : definitionId} disabled={definitions.isError} onChange={(id) => { setDefinitionId(id); setDraftId(null); setRevisionId(null); setDraftToken(undefined); setCommittedDraft(null); setOffset(0); }} />}
    {identity.isError && <Alert color="red">{identity.error.message}</Alert>}
    {identity.data && !workspaceDenied && <>
      <Select label="Edit cable draft" value={draftId} onChange={id => { if (id !== draftId) { setDraftId(id); setDraftToken(undefined); setCommittedDraft(null); } }} data={identity.data.drafts.map((d) => ({ value: d.draft_id, label: `${d.draft_id} · ${d.state}` }))} />
      <Select label="Inspect frozen cable" value={revisionId} onChange={setRevisionId} data={identity.data.revisions.map((r) => ({ value: r.revision_id, label: `Revision ${r.number} · ${r.revision_id}` }))} />
      <Group><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous revisions</Button><Button disabled={Math.max(identity.data.revisions.length, identity.data.drafts.length) < 50} onClick={() => setOffset(offset + 50)}>Next revisions</Button></Group>
    </>}
    {draft.isError && <Alert color="red">{draft.error.message}</Alert>}
    {draft.data && draftId && <DraftEditor key={draft.data.draft_id} draft={draft.data} committedDraft={committedDraft} hidden={draft.isError || workspaceDenied} definitions={currentDefinitions} onStateChange={setDraftToken} onMutationError={mutationError} onAuthorityChange={setDraftSourceDenied} onSaved={async () => { await cache.invalidateQueries({ queryKey: ["cable-draft", draftId] }); }} />}
    {draft.data && !draft.isError && !workspaceDenied && <Button disabled={draftSourceDenied || !draftToken} loading={freeze.isPending} {...freezeGate.props} onClick={() => freeze.mutate()}>Freeze cable revision</Button>}
    {freeze.isError && <Alert color="red">{freeze.error.message}</Alert>}
    {revisionId && !workspaceDenied && !draft.isError && <CableInspector key={revisionId} revisionId={revisionId} revisions={identity.data?.revisions ?? []} />}
  </Stack>;
}

function DraftEditor({ draft, committedDraft, hidden, definitions, onSaved, onAuthorityChange, onStateChange, onMutationError }: { draft: Draft; committedDraft: Draft | null; hidden: boolean; definitions: Definition[]; onSaved: () => Promise<void>; onAuthorityChange: (denied: boolean) => void; onStateChange: (state: string) => void; onMutationError: (error: Error) => void }) {
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
  if (hidden) return null;
  return <Card withBorder><Stack><Title order={3}>Edit draft</Title><Text size="sm">{base.state}</Text><CableEditor value={value} onChange={setValue} definitions={definitions} onAuthorityChange={setSourceDenied} /><Button disabled={sourceDenied} loading={save.isPending} {...editGate.props} onClick={() => save.mutate()}>Save cable draft</Button><ReadOnlyNote permission="design.edit">Saving cable drafts is unavailable.</ReadOnlyNote>{save.isError && <Alert color="red">{save.error.message}</Alert>}</Stack></Card>;
}
function RevisionPicker({ label, kind, value, onChange, definitions }: { label: string; kind: string; value: string; onChange: (v: string) => void; definitions: Definition[] }) {
  const [definition, setDefinition] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const identity = useQuery({ queryKey: ["cable-reference", definition, offset], queryFn: () => read<Identity>(`catalog/definitions/${definition}?offset=${offset}`), enabled: !!definition });
  return <Stack gap="xs"><Select label={`${label} definition`} searchable value={definitions.some(d => d.definition_id === definition) ? definition : null} data={definitions.filter((d) => d.kind === kind).map((d) => ({ value: d.definition_id, label: d.name }))} onChange={(v) => { setDefinition(v); setOffset(0); }} /><Select label={`${label} revision`} value={identity.isError ? null : value || null} disabled={identity.isError} onChange={(v) => onChange(v ?? "")} data={(identity.isError ? [] : identity.data?.revisions ?? []).map((r) => ({ value: r.revision_id, label: `Revision ${r.number} · ${r.revision_id}` }))} />{identity.data && !identity.isError && <Group><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Earlier {label} revisions</Button><Button disabled={identity.data.revisions.length < 50} onClick={() => setOffset(offset + 50)}>Later {label} revisions</Button></Group>}<TextInput label={`${label} exact revision ID`} description="An accessible revision from another project can also be supplied." value={value} onChange={(e) => onChange(e.currentTarget.value)} />{identity.isError && <Alert color="red">{identity.error.message}</Alert>}</Stack>;
}

function elements(node: StockElement, prefix = ''): { value: string; label: string }[] {
  const path = prefix ? `${prefix}.${node.id}` : node.id;
  if (node.kind === 'group') return node.children.flatMap(child => elements(child, path));
  return ['conductor', 'shield', 'drain'].includes(node.kind) ? [{ value: path, label: `${path} · ${node.label} (${node.kind})` }] : [];
}
export function CableEditor({ value, onChange, definitions, onAuthorityChange }: { value: Cable; onChange: (value: Cable) => void; definitions: Definition[]; onAuthorityChange?: (denied: boolean) => void }) {
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
  return <Stack>
    <RevisionPicker label="Cable stock" kind="wire_stock" value={value.stock_revision_id} onChange={stock_revision_id => onChange({ ...value, stock_revision_id })} definitions={definitions} />
    {stock.isError && <Alert color="red">{stock.error.message}</Alert>}
    {value.endpoints.map((endpoint, index) => <Card key={index} withBorder><Stack>
      <Title order={4}>Endpoint {index + 1}</Title>
      <TextInput label={`Endpoint ${index + 1} stable ID`} description="Renaming an ID retains its current assignments." value={endpoint.local_id} onChange={event => { const local_id = event.currentTarget.value; onChange({ ...value, endpoints: value.endpoints.map((e, i) => i === index ? { ...e, local_id } : e), assignments: value.assignments.map(a => a.endpoint_id === endpoint.local_id ? { ...a, endpoint_id: local_id } : a) }); }} />
      <TextInput label={`Endpoint ${index + 1} label`} value={endpoint.label ?? ''} onChange={event => onChange({ ...value, endpoints: value.endpoints.map((e, i) => i === index ? { ...e, label: event.currentTarget.value || null } : e) })} />
      <RevisionPicker label={`Endpoint ${index + 1} body`} kind="connector_body" value={endpoint.body_revision_id} onChange={body_revision_id => onChange({ ...value, endpoints: value.endpoints.map((e, i) => i === index ? { ...e, body_revision_id } : e) })} definitions={definitions} />
      <RevisionPicker label={`Endpoint ${index + 1} pinout`} kind="pinout" value={endpoint.pinout_revision_id} onChange={pinout_revision_id => onChange({ ...value, endpoints: value.endpoints.map((e, i) => i === index ? { ...e, pinout_revision_id } : e) })} definitions={definitions} />
      <TerminationEditor value={value} index={index} choices={choices} onChange={onChange} denied={denied} body={sourceFor('cable-body', endpoint.body_revision_id)} pinout={sourceFor('cable-pinout', endpoint.pinout_revision_id)} />
    </Stack></Card>)}
    {!denied && <LengthsEditor value={value.lengths} onChange={lengths => onChange({ ...value, lengths })} choices={choices} endpoints={value.endpoints.map(e => e.local_id)} />}
    <Select label="Cable review" data={['unreviewed', 'reviewed']} value={value.review} onChange={review => onChange({ ...value, review: review as Cable['review'] })} />
    <TextInput label="Cable review basis" value={value.review_basis ?? ''} onChange={event => onChange({ ...value, review_basis: event.currentTarget.value || null })} />
  </Stack>;
}
function TerminationEditor({ value, index, choices, onChange, denied, body, pinout }: { value: Cable; index: number; choices: { value: string; label: string }[]; onChange: (value: Cable) => void; denied: boolean; body: UseQueryResult<InterfaceInspection>; pinout: UseQueryResult<InterfaceInspection> }) {
  const endpoint = value.endpoints[index]!;
  const [element, setElement] = useState<string | null>(null);
  const [contact, setContact] = useState<string | null>(null);
  const [basis, setBasis] = useState('');
  const contacts = !denied && body.data?.interface.kind === 'connector_body' ? body.data.interface.contacts.filter(c => c.physical_role !== 'key') : [];
  const sameBody = !denied && pinout.data?.interface.kind === 'pinout' && pinout.data.interface.body_revision_id === endpoint.body_revision_id;
  const own = denied ? [] : value.assignments.filter(a => a.endpoint_id === endpoint.local_id);
  const availableElements = choices.filter(c => !own.some(a => a.element_path === c.value));
  const availableContacts = contacts.filter(c => !own.some(a => a.contact_id === c.contact_id));
  const canAdd = sameBody && availableElements.some(e => e.value === element) && availableContacts.some(c => c.contact_id === contact) && basis.trim();
  return <Stack>
    {body.isError && <Alert color="red">{body.error.message}</Alert>}{pinout.isError && <Alert color="red">{pinout.error.message}</Alert>}
    {pinout.data && !denied && !sameBody && <Alert color="orange">The pinout must reference this exact body revision.</Alert>}
    {own.map(a => <Group key={a.element_path}><Text>{a.element_path} → {a.contact_id} · {a.basis}</Text><Button variant="subtle" onClick={() => onChange({ ...value, assignments: value.assignments.filter(other => other !== a) })}>Remove {endpoint.local_id} {a.element_path}</Button></Group>)}
    <Select label={`Endpoint ${index + 1} conductive element`} data={availableElements} disabled={denied} value={denied ? null : element} onChange={setElement} />
    <Select label={`Endpoint ${index + 1} physical contact`} data={availableContacts.map(c => ({ value: c.contact_id, label: `${c.contact_id} (${c.physical_role})` }))} disabled={denied} value={denied ? null : contact} onChange={setContact} />
    <TextInput label={`Endpoint ${index + 1} termination basis`} value={basis} onChange={event => setBasis(event.currentTarget.value)} />
    <Button disabled={!canAdd} onClick={() => { if (element && contact) { onChange({ ...value, assignments: [...value.assignments, { endpoint_id: endpoint.local_id, element_path: element, contact_id: contact, basis }] }); setElement(null); setContact(null); } }}>Assign endpoint {index + 1} terminal</Button>
  </Stack>;
}
export function CableInspector({ revisionId, revisions = [] }: { revisionId: string; revisions?: { revision_id: string; number: number }[] }) {
  const result = useQuery({ queryKey: ['cable-inspection', revisionId], queryFn: () => read<Inspection>(`cables/revisions/${revisionId}`) });
  const stockId = result.data?.cable.stock_revision_id;
  const stock = useQuery({ queryKey: ['cable-stock', stockId], queryFn: () => loadFrozenStock(stockId!), enabled: !!stockId && !result.isError });
  // The cable record does not say which stock end each endpoint is, so every endpoint's contact is listed.
  const terminationLabels = Object.fromEntries((result.data?.conductors ?? []).map(row => [row.element_path,
    row.ends.map(end => `${result.data!.cable.endpoints.find(e => e.local_id === end.endpoint_id)?.label ?? end.endpoint_id}: ${end.assignment?.contact_id ?? 'unassigned'}`).join('; ')]));
  return <Card withBorder><Stack><Title order={3}>Frozen cable inspection</Title><Text>Exact revision {revisionId}</Text>
    {result.isError && <Alert color="red">{result.error.message}</Alert>}
    {result.data && !result.isError && <><Text>Stock revision: {result.data.cable.stock_revision_id}</Text><Text>Review: {result.data.cable.review}; basis: {result.data.cable.review_basis ?? 'unknown'}</Text>
      <Text>Continuity: {result.data.continuity}. Compatibility: {result.data.compatibility}. Physical qualification: {result.data.physical_qualification}.</Text>
      {stock.isError && <Alert color="red">{stock.error.message}</Alert>}
      {stock.data && !stock.isError && <CableViews stock={stock.data} name={`Cable stock ${stockId}`} revisionId={stockId} terminationLabels={terminationLabels} />}
      {result.data.lengths && <LengthInspection projection={result.data.lengths} />}
      <LengthImpactView key={`impact:${revisionId}`} afterRevision={revisionId} revisions={revisions} />
      <Table><Table.Thead><Table.Tr><Table.Th>Stable stock feature</Table.Th>{result.data.cable.endpoints.map(e => <Table.Th key={e.local_id}>{e.label ?? e.local_id} ({e.local_id})</Table.Th>)}</Table.Tr></Table.Thead><Table.Tbody>
        {result.data.conductors.map(row => <Table.Tr key={row.element_path}><Table.Td>{row.element_path} · {row.kind}</Table.Td>{row.ends.map(end => <Table.Td key={end.endpoint_id}>{end.assignment ? `${end.assignment.contact_id} · ${end.assignment.basis}` : 'unknown / unassigned'}</Table.Td>)}</Table.Tr>)}
      </Table.Tbody></Table>
      {result.data.endpoints.map(endpoint => <Card key={endpoint.local_id} withBorder><Text fw={600}>Endpoint {endpoint.local_id}</Text><Text>Body {endpoint.body_revision_id}; pinout {endpoint.pinout_revision_id}</Text><Text>Body drawing side: {endpoint.body.drawing_orientation.viewing_side}; pinout viewing side: {endpoint.pinout.orientation.viewing_side}</Text>
        <Table><Table.Thead><Table.Tr><Table.Th>Contact</Table.Th><Table.Th>Signal / role</Table.Th><Table.Th>Voltage range (V)</Table.Th><Table.Th>Current limit (A)</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{endpoint.body.contacts.map(contact => { const electrical = endpoint.pinout.assignments.find(a => a.contact_id === contact.contact_id)?.electrical; return <Table.Tr key={contact.contact_id}><Table.Td>{contact.contact_id} ({contact.physical_role})</Table.Td><Table.Td>{electrical?.signal ?? 'unknown'} / {electrical?.role ?? 'unknown'}</Table.Td><Table.Td>{electrical?.voltage_min_v ?? 'unknown'} to {electrical?.voltage_max_v ?? 'unknown'}</Table.Td><Table.Td>{electrical?.current_max_a ?? 'unknown'}</Table.Td></Table.Tr>; })}</Table.Tbody></Table>
      </Card>)}
    </>}
  </Stack></Card>;
}
