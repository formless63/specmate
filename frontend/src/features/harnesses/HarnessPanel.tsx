import { Alert, Button, Card, Group, NumberInput, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { HarnessEditor } from './HarnessEditor';
import { command, read, initialHarness, terminalKey, terminalLabel, type Harness, type Definition, type Draft, type Identity, type Inspection } from './api';

export function HarnessPanel({ projectId }: { projectId: string }) { return <Workspace key={projectId} projectId={projectId} />; }
function Workspace({ projectId }: { projectId: string }) {
  const cache = useQueryClient();
  const [name, setName] = useState("");
  const [value, setValue] = useState<Harness>(initialHarness());
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [createSourceDenied, setCreateSourceDenied] = useState(false);
  const [draftSourceDenied, setDraftSourceDenied] = useState(false);
  const definitions = useQuery({ queryKey: ["harness-definitions", projectId], queryFn: () => read<Definition[]>(`projects/${projectId}/definitions`) });
  const identity = useQuery({ queryKey: ["harness-identity", definitionId, offset], queryFn: () => read<Identity>(`catalog/definitions/${definitionId}?offset=${offset}`), enabled: !!definitionId });
  const draft = useQuery({ queryKey: ["harness-draft", draftId], queryFn: () => read<Draft>(`harnesses/drafts/${draftId}`), enabled: !!draftId });
  const create = useMutation({ mutationFn: () => command<Draft>("harness.create", { project_id: projectId, name, harness: value }), onSuccess: async (data) => {
    setDefinitionId(data.definition_id); setDraftId(data.draft_id); setRevisionId(null); setOffset(0);
    await cache.invalidateQueries({ queryKey: ["harness-definitions", projectId] });
  } });
  const freeze = useMutation({ mutationFn: () => command<{ revision_id: string }>("harness.freeze", { draft_id: draftId }, draft.data?.state), onSuccess: async (data) => {
    setRevisionId(data.revision_id);
    await cache.invalidateQueries({ queryKey: ["harness-draft", draftId] });
    await cache.invalidateQueries({ queryKey: ["harness-identity", definitionId] });
  } });
  const currentDefinitions = definitions.isError ? [] : definitions.data ?? [];
  const workspaceDenied = definitions.isError || identity.isError;
  return <Stack>
    <Title order={2}>Branched harnesses</Title>
    <Text>Physical sections count original stock pieces once. Segments and breakout declarations preserve feature identity; joints and shield bonds require explicit targets and a basis. Continuity and physical qualification remain unevaluated.</Text>
    <Card withBorder><Stack>
      <Title order={3}>New reusable definition</Title>
      <TextInput label="Definition name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
      <HarnessEditor value={value} onChange={setValue} definitions={currentDefinitions} onAuthorityChange={setCreateSourceDenied} />
      <Button disabled={!name.trim() || definitions.isError || createSourceDenied} loading={create.isPending} onClick={() => create.mutate()}>Create harness draft</Button>
      {create.isError && <Alert color="red">{create.error.message}</Alert>}
    </Stack></Card>
    {definitions.isError && <Alert color="red">{definitions.error.message}</Alert>}
    <Select label="Existing harness definition" searchable data={currentDefinitions.filter((d) => d.kind === "harness").map((d) => ({ value: d.definition_id, label: `${d.name} (${d.kind})` }))} value={definitions.isError ? null : definitionId} disabled={definitions.isError} onChange={(id) => { setDefinitionId(id); setDraftId(null); setRevisionId(null); setOffset(0); }} />
    {identity.isError && <Alert color="red">{identity.error.message}</Alert>}
    {identity.data && !workspaceDenied && <>
      <Select label="Edit harness draft" value={draftId} onChange={setDraftId} data={identity.data.drafts.map((d) => ({ value: d.draft_id, label: `${d.draft_id} · ${d.state}` }))} />
      <Select label="Inspect frozen harness" value={revisionId} onChange={setRevisionId} data={identity.data.revisions.map((r) => ({ value: r.revision_id, label: `Revision ${r.number} · ${r.revision_id}` }))} />
      <Group><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous revisions</Button><Button disabled={Math.max(identity.data.revisions.length, identity.data.drafts.length) < 50} onClick={() => setOffset(offset + 50)}>Next revisions</Button></Group>
    </>}
    {draft.isError && <Alert color="red">{draft.error.message}</Alert>}
    {draft.data && !draft.isError && !workspaceDenied && <><DraftEditor key={`${draft.data.draft_id}:${draft.data.state}`} draft={draft.data} definitions={currentDefinitions} onAuthorityChange={setDraftSourceDenied} onSaved={async () => { await cache.invalidateQueries({ queryKey: ["harness-draft", draftId] }); }} /><Button disabled={draftSourceDenied} loading={freeze.isPending} onClick={() => freeze.mutate()}>Freeze harness revision</Button></>}
    {freeze.isError && <Alert color="red">{freeze.error.message}</Alert>}
    {revisionId && !workspaceDenied && !draft.isError && <HarnessInspector key={revisionId} revisionId={revisionId} />}
  </Stack>;
}

function DraftEditor({ draft, definitions, onSaved, onAuthorityChange }: { draft: Draft; definitions: Definition[]; onSaved: () => Promise<void>; onAuthorityChange: (denied: boolean) => void }) {
  const [sourceDenied, setSourceDenied] = useState(false);
  useEffect(() => onAuthorityChange(sourceDenied), [sourceDenied, onAuthorityChange]);
  const [value, setValue] = useState(() => draft.content.harness ?? initialHarness());
  const save = useMutation({ mutationFn: () => command("harness.update", { draft_id: draft.draft_id, harness: value }, draft.state), onSuccess: onSaved });
  return <Card withBorder><Stack><Title order={3}>Edit draft</Title><Text size="sm">{draft.state}</Text><HarnessEditor value={value} onChange={setValue} definitions={definitions} onAuthorityChange={setSourceDenied} /><Button disabled={sourceDenied} loading={save.isPending} onClick={() => save.mutate()}>Save harness draft</Button>{save.isError && <Alert color="red">{save.error.message}</Alert>}</Stack></Card>;
}
export function HarnessInspector({ revisionId }: { revisionId: string }) {
  const [quantity, setQuantity] = useState(1);
  const [terminal, setTerminal] = useState<string | null>(null);
  const result = useQuery({ queryKey: ['harness-inspect', revisionId, quantity], queryFn: () => read<Inspection>(`harnesses/revisions/${revisionId}?quantity=${quantity}`) });
  const value = result.isError ? undefined : result.data;
  const relationships = value?.declared_relationships.filter(r => r.members.some(t => terminalKey(t) === terminal)) ?? [];
  return <Card withBorder><Stack><Title order={3}>Frozen harness inspection</Title><Text>Exact revision {revisionId}</Text>
    <NumberInput label="Harness quantity" min={1} max={1000000} allowDecimal={false} value={quantity} onChange={v => { if (typeof v === 'number' && Number.isInteger(v) && v >= 1) setQuantity(v); }} />
    {result.isError && <Alert color="red">{result.error.message}</Alert>}
    {value && <><Text>Planned stock pieces: {value.quantities.physical_piece_count ?? 'unknown'}; segment spans: {value.quantities.segment_count ?? 'unknown'}</Text><Text>Continuity: {value.continuity}. Compatibility: {value.compatibility}. Physical qualification: {value.physical_qualification}.</Text>
      <Table><Table.Thead><Table.Tr><Table.Th>Exact stock</Table.Th><Table.Th>Planned sections</Table.Th><Table.Th>Pieces</Table.Th><Table.Th>Planned cut total (mm)</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{value.quantities.stock.map(row => <Table.Tr key={row.stock_revision_id}><Table.Td>{row.stock_revision_id}</Table.Td><Table.Td>{row.section_ids.join(', ')}</Table.Td><Table.Td>{row.piece_count ?? 'unknown'}</Table.Td><Table.Td>{row.planned_cut_total_mm ?? 'unknown'}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
      <Title order={4}>Segments and retained material</Title>{value.harness.segments.map(s => <Text key={s.local_id}>{s.local_id} → section {s.section_id}; conductive paths: {s.element_paths?.join(', ') ?? 'all declared conductive features'}</Text>)}
      <Title order={4}>Declared relationships</Title><Text>Only explicit relationships touching a selected terminal are shown. This does not trace longitudinal copper or establish measured continuity.</Text>
      <Select label="Inspect terminal declarations" searchable value={terminal} onChange={setTerminal} data={value.terminals.map(row => ({ value: terminalKey(row.terminal), label: `${terminalLabel(row.terminal)} (${row.feature_kind})` }))} />
      {terminal && (relationships.length ? relationships.map(r => <Card key={`${r.breakout_id ?? 'joint'}:${r.id}`} withBorder><Text>{r.kind}: {r.id}{r.breakout_id ? ` at ${r.breakout_id}` : ''}</Text><Text>{r.members.map(terminalLabel).join(' ↔ ')}</Text><Text>Basis: {r.basis}</Text></Card>) : <Text>No relationship declared for this terminal; continuity remains unknown.</Text>)}
      <Title order={4}>Breakout accountability</Title><Table><Table.Thead><Table.Tr><Table.Th>Breakout</Table.Th><Table.Th>Exact terminal</Table.Th><Table.Th>Declared fate</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{value.breakout_fates.map(row => <Table.Tr key={`${row.breakout_id}:${terminalKey(row.terminal)}`}><Table.Td>{row.breakout_id}</Table.Td><Table.Td>{terminalLabel(row.terminal)}</Table.Td><Table.Td>{row.fate}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
    </>}
  </Stack></Card>;
}
