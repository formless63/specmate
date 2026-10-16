import { useEffect, useState } from 'react';
import { Alert, Select, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { SbUnknown } from '../../components/sb';
import { useProbe } from '../probe';
import type { LibraryRecord } from '../workspace/api';
import { read as readIdentity, type Identity } from '../identity/api';
import { CableInspector } from '../cables/CableInspector';
import { CableSummary } from '../cables/CableSummary';
import type { Draft as CableDraft } from '../cables/api';
import type { Harness } from '../harnesses/api';
import { HarnessInspector } from '../harnesses/HarnessInspector';
import { read as readHarness, type Draft as HarnessDraft } from '../harnesses/api';
import { HarnessViews } from '../harness-views/HarnessViews';
import { loadFrozenStock } from '../wire-stock/viewer-api';
import { CableViews, type CableEnd } from './CableViews';

import { newestFirst } from '../../lib/revision-labels';
const PAGE = 50;
/** Revisions are listed oldest first, 50 to a page; this is the offset of the page that holds `number`. */
export const revisionPageOffset = (number: number) => Math.floor((number - 1) / PAGE) * PAGE;

/**
 * The views of the cable or harness selected in the Library: cross-section, end faces, 3D and
 * information for a cable, formboard and build sheet for a harness. The probe's revision picks
 * the exact frozen revision; without one the latest frozen revision shows, and a definition that
 * was never frozen shows its draft's current state. Nothing is drawn that is not recorded.
 */
export function SelectedDefinitionViews({ record }: { record: LibraryRecord }) {
  const kind = record.kind === 'harness' ? 'harness' : 'cable';
  const shared = useProbe();
  const probeRev = shared?.probe?.object === record.record_id ? shared.probe.rev : null;
  const frozenNumber = probeRev ?? record.latest_revision;
  const identity = useQuery({
    queryKey: ['selected-definition', record.record_id, frozenNumber === null ? 0 : revisionPageOffset(frozenNumber)],
    queryFn: () => readIdentity<Identity>(`catalog/definitions/${record.record_id}?offset=${frozenNumber === null ? 0 : revisionPageOffset(frozenNumber)}`),
    retry: false,
  });
  const revisions = identity.data?.revisions ?? [];
  const exact = frozenNumber === null ? undefined : revisions.find(revision => revision.number === frozenNumber);
  const frozenId = probeRev === null ? record.latest_revision_id ?? exact?.revision_id ?? null : exact?.revision_id ?? null;
  const drafts = identity.data?.drafts ?? [];
  const hasFrozen = frozenNumber !== null;
  const [mode, setMode] = useState<'frozen' | 'draft'>(hasFrozen ? 'frozen' : 'draft');
  const [draftId, setDraftId] = useState<string | null>(null);
  // A different selection starts on its own most useful view.
  useEffect(() => { setMode(hasFrozen ? 'frozen' : 'draft'); setDraftId(null); }, [record.record_id, hasFrozen]);
  const draft = drafts.find(d => d.draft_id === draftId) ?? drafts[0] ?? null;
  const options = [
    ...newestFirst(revisions).map(revision => ({ value: String(revision.number), label: `r${revision.number}` })),
    ...(drafts.length ? [{ value: 'draft', label: 'Draft (current state)' }] : []),
  ];
  const value = mode === 'draft' ? 'draft' : frozenNumber === null ? null : String(frozenNumber);
  const choose = (next: string | null) => {
    if (next === null) return;
    if (next === 'draft') { setMode('draft'); return; }
    setMode('frozen');
    shared?.setProbe({ object: record.record_id, rev: Number(next), path: [] });
  };
  return <Stack gap="xs" aria-label={`Views of ${record.label}`} className="sb-selected-views">
    {identity.isError && <Alert color="red" role="alert">{identity.error instanceof Error ? identity.error.message : 'The revisions could not be read.'}</Alert>}
    {options.length > 0 && <Select size="xs" w={260} label={`Inspect frozen ${kind}`} value={value} data={options} onChange={choose} allowDeselect={false} />}
    {mode === 'frozen' && frozenNumber !== null && !frozenId && !identity.isPending && !identity.isError &&
      <Alert color="yellow" role="status">r{frozenNumber} is not available for {record.label}. Nothing is drawn for it.</Alert>}
    {mode === 'frozen' && frozenId && (kind === 'cable'
      ? <CableInspector key={frozenId} revisionId={frozenId} revisions={revisions} />
      : <HarnessInspector key={frozenId} revisionId={frozenId} />)}
    {mode === 'draft' && !identity.isPending && (draft
      ? <>
        {drafts.length > 1 && <Select size="xs" w={260} label={`${kind === 'cable' ? 'Cable' : 'Harness'} draft`} value={draft.draft_id} allowDeselect={false}
          data={drafts.map(d => ({ value: d.draft_id, label: `${d.draft_id} · ${d.state}` }))} onChange={setDraftId} />}
        {kind === 'cable' ? <CableDraftViews key={draft.draft_id} draftId={draft.draft_id} name={record.label} /> : <HarnessDraftViews key={draft.draft_id} draftId={draft.draft_id} name={record.label} />}
      </>
      : <Text className="sb-dash-note" role="status">{record.label} has no frozen revision and no draft to show.</Text>)}
    {identity.isPending && <Text role="status" className="sb-dash-note">Reading {record.label}…</Text>}
  </Stack>;
}

function DraftNote({ state }: { state: string }) {
  return <Text className="sb-dash-note" role="status">Unfrozen draft, shown as saved now ({state}). It is not a revision; freeze it to pin what is drawn.</Text>;
}

/** The draft's current stock; a draft with no stock chosen yet says so rather than drawing a default. */
function CableDraftViews({ draftId, name }: { draftId: string; name: string }) {
  const draft = useQuery({ queryKey: ['cable-draft', draftId], queryFn: () => readIdentity<CableDraft>(`cables/drafts/${draftId}`), retry: false });
  const stockId = draft.data?.content.cable?.stock_revision_id || null;
  const stock = useQuery({ queryKey: ['cable-stock', stockId], queryFn: () => loadFrozenStock(stockId!), enabled: !!stockId, retry: false });
  const cable = draft.data?.content.cable;
  const sectionGraph = (cable as { schema_version?: string } | undefined)?.schema_version === '0.3';
  // A draft is not resolved here: landings show their layer and terminal IDs as saved.
  const cableEnds: CableEnd[] | undefined = (!sectionGraph ? cable : undefined)?.endpoints.map(e => ({ endpointId: e.local_id, label: e.label ?? `End ${e.local_id.toUpperCase()}`, stockEnd: e.stock_end ?? 'unknown',
    terminations: Object.fromEntries((cable?.assignments ?? []).filter(a => a.endpoint_id === e.local_id).map(a => [a.element_path, `${a.layer_id} ${a.terminal_id}`])) }));
  if (sectionGraph && cable && !draft.isError) return <Stack><DraftNote state={draft.data!.state} /><HarnessViews revisionId={null} harness={cable as unknown as Harness} title={`${name} (draft cable)`} /></Stack>;
  return <Stack gap="xs" aria-label="Cable draft views">
    {draft.isError && <Alert color="red" role="alert">{draft.error instanceof Error ? draft.error.message : 'The draft could not be read.'}</Alert>}
    {draft.data && <DraftNote state={draft.data.state} />}
    {draft.data?.content.cable && <CableSummary cable={draft.data.content.cable} />}
    {draft.data && !stockId && <Text role="status">No stock is chosen in this draft, so no section or 3D model can be drawn. <SbUnknown /></Text>}
    {stock.isError && <Alert color="red" role="alert">{stock.error instanceof Error ? stock.error.message : 'The stock could not be read.'}</Alert>}
    {stock.data && !stock.isError && <Stack gap="xs"><Title order={4}>Stock used</Title><CableViews stock={stock.data} name={`${name} (draft)`} revisionId={null} cableEnds={cableEnds} /></Stack>}
  </Stack>;
}

function HarnessDraftViews({ draftId, name }: { draftId: string; name: string }) {
  const draft = useQuery({ queryKey: ['harness-draft', draftId], queryFn: () => readHarness<HarnessDraft>(`harnesses/drafts/${draftId}`), retry: false });
  const harness = draft.data?.content.harness;
  return <Stack gap="xs" aria-label="Harness draft views">
    {draft.isError && <Alert color="red" role="alert">{draft.error.message}</Alert>}
    {draft.data && <DraftNote state={draft.data.state} />}
    {draft.data && !harness && <Text role="status">This draft has no harness declaration yet, so nothing can be drawn. <SbUnknown /></Text>}
    {harness && <HarnessViews revisionId={null} harness={harness} title={`${name} (draft)`} />}
  </Stack>;
}
