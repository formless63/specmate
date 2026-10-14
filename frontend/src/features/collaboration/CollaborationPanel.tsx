import { Alert, Button, Fieldset, Group, Select, Stack, Table, Text, Textarea, TextInput, Title } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { randomUUID } from '../../lib/random-id';
import { RevisionChoice } from '../preparation-documents/RevisionChoice';
import { fresh, mutate, read, type Comparison, type Definition, type Evidence, type Notification, type Pair, type Page, type Project, type Review } from './api';

type Props = { projectId: string; principalKey: string; canEdit: boolean; active?: boolean; onAccessLost?: () => void; onOpenUpgrade?: (id: string) => void };
type Intent = { operation: string; payload: object; state?: string; key: string };
const denied = (error: unknown) => !!error && typeof error === 'object' && 'status' in error && [401, 403, 404].includes(Number(error.status));
const value = (v: unknown, present: boolean) => present ? JSON.stringify(v) : 'Absent';

export function CollaborationPanel(props: Props) { return <Workspace key={`${props.projectId}:${props.principalKey}`} {...props} />; }
function Workspace({ projectId, canEdit, active = true, onAccessLost, onOpenUpgrade }: Props) {
  const [oldScopeOpen, setOldScopeOpen] = useState(false), [candidateScopeOpen, setCandidateScopeOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]), [oldScope, setOldScope] = useState(projectId), [candidateScope, setCandidateScope] = useState(projectId);
  const [oldDefs, setOldDefs] = useState<Definition[]>([]), [candidateDefs, setCandidateDefs] = useState<Definition[]>([]);
  const [pair, setPair] = useState<Pair>({ old_revision_id: '', candidate_revision_id: '' });
  const [comparison, setComparison] = useState<Comparison | null>(null), [changesOffset, setChangesOffset] = useState(0), [parentAfter, setParentAfter] = useState<string | null>(null), [parentSide, setParentSide] = useState<'old' | 'candidate'>('old');
  const [reviews, setReviews] = useState<Review[]>([]), [reviewAfter, setReviewAfter] = useState<string | null>(null), [reviewNext, setReviewNext] = useState<string | null>(null);
  const [notices, setNotices] = useState<Notification[]>([]), [inboxAfter, setInboxAfter] = useState<string | null>(null), [inboxNext, setInboxNext] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null), [selected, setSelected] = useState<Review | null>(null), [token, setToken] = useState<string | undefined>();
  const [title, setTitle] = useState(''), [basis, setBasis] = useState(''), [recipients, setRecipients] = useState('');
  const [knowledgeId, setKnowledgeId] = useState(''), [knowledgeNumber, setKnowledgeNumber] = useState('');
  const [action, setAction] = useState('comment'), [responseBasis, setResponseBasis] = useState('');
  const [evidenceStatus, setEvidenceStatus] = useState<Evidence['status']>('unknown'), [citation, setCitation] = useState(''), [bundleRevision, setBundleRevision] = useState(''), [sourcePath, setSourcePath] = useState('');
  const [owningSnapshot, setOwningSnapshot] = useState(''), [paths, setPaths] = useState(''), [upgradeBasis, setUpgradeBasis] = useState('');
  const [busy, setBusy] = useState(false), [choiceBusy, setChoiceBusy] = useState(0), [fenced, setFenced] = useState(true), [blocked, setBlocked] = useState(false), [focused, setFocused] = useState(true), [refreshTick, setRefreshTick] = useState(0), [error, setError] = useState<string | null>(null);
  const pending = useRef<Intent | null>(null), mounted = useRef(false), epoch = useRef(0), lifecycle = useRef(0), needsRefresh = useRef(true), activeRef = useRef(active), focusedRef = useRef(focused);
  activeRef.current = active; focusedRef.current = focused;
  const current = (e: number, life: number) => mounted.current && epoch.current === e && lifecycle.current === life && activeRef.current && focusedRef.current;
  useEffect(() => { mounted.current = true; needsRefresh.current = true; setBusy(false); return () => { mounted.current = false; epoch.current++; lifecycle.current++; }; }, []);
  function fail(e: unknown) { setFenced(true); if (denied(e)) { setBlocked(true); setProjects([]); setOldDefs([]); setCandidateDefs([]); setReviews([]); setNotices([]); onAccessLost?.(); } setError(e instanceof Error ? e.message : 'Review unavailable.'); }
  async function protect(id = selectedId, explicitPair = pair) {
    const [scopes, left, right, history, inbox] = await Promise.all([
      read<Project[]>('projects'), read<Definition[]>(`projects/${oldScope}/definitions`), read<Definition[]>(`projects/${candidateScope}/definitions`),
      fresh<Page<Review>>('collaboration.list', { project_id: projectId, after: reviewAfter }), fresh<Page<Notification>>('collaboration.inbox', { project_id: projectId, after: inboxAfter }),
    ]);
    const selectedProof = id ? await fresh<Review>('collaboration.read', { review_id: id }) : null;
    const declared = explicitPair.old_revision_id && explicitPair.candidate_revision_id ? await fresh<Comparison>('collaboration.compare', { ...explicitPair, changes_offset: changesOffset, parents_after: parentAfter, parents_side: parentSide }) : null;
    return { scopes, left, right, history, inbox, selectedProof, declared };
  }
  function accept(p: Awaited<ReturnType<typeof protect>>) { setProjects(p.scopes); setOldDefs(p.left); setCandidateDefs(p.right); setReviews(p.history.results); setReviewNext(p.history.next_after); setNotices(p.inbox.results); setInboxNext(p.inbox.next_after); setSelected(p.selectedProof); setComparison(p.declared ?? p.selectedProof?.comparison ?? null); setFenced(false); setBlocked(false); needsRefresh.current = false; }
  async function refresh() {
    if (!activeRef.current || !focusedRef.current) return;
    const e = ++epoch.current, life = lifecycle.current; needsRefresh.current = false; setBusy(true); setFenced(true); setError(null);
    try { const proof = await protect(); if (current(e, life)) accept(proof); }
    catch (failure) { if (current(e, life)) fail(failure); }
    finally { if (mounted.current && e === epoch.current) setBusy(false); }
  }
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  useEffect(() => {
    const blur = () => { focusedRef.current = false; setFocused(false); lifecycle.current++; setFenced(true); needsRefresh.current = true; };
    const focus = () => { focusedRef.current = true; setFocused(true); needsRefresh.current = true; };
    window.addEventListener('blur', blur); window.addEventListener('focus', focus);
    return () => { window.removeEventListener('blur', blur); window.removeEventListener('focus', focus); };
  }, []);
  useEffect(() => {
    if (!active || !focused) { lifecycle.current++; setFenced(true); needsRefresh.current = true; return; }
    if (!busy && choiceBusy === 0 && needsRefresh.current) void refreshRef.current();
  }, [active, focused, busy, choiceBusy, refreshTick]);
  function changed(work: () => void, protectedBasis = false) { epoch.current++; pending.current = null; setBusy(false); work(); if (protectedBasis) { setFenced(true); needsRefresh.current = true; setRefreshTick(t => t + 1); } }
  function choices(started: boolean) { setChoiceBusy(n => Math.max(0, n + (started ? 1 : -1))); epoch.current++; setFenced(true); needsRefresh.current = true; }
  function pickPair(side: keyof Pair, id: string | null) { changed(() => { setPair(p => ({ ...p, [side]: id ?? '' })); setComparison(null); setChangesOffset(0); setParentAfter(null); }, true); }
  function selectReview(id: string | null) { changed(() => { setSelectedId(id); setSelected(null); setToken(undefined); }, true); }
  async function run(intent: Intent, selectCommitted = false) {
    const e = ++epoch.current, life = lifecycle.current; setBusy(true); setFenced(true); setError(null); needsRefresh.current = false;
    try {
      const result = await mutate<Review | Notification>(intent.operation, intent.payload, intent.state, intent.key);
      if (!mounted.current || e !== epoch.current) return;
      const id = selectCommitted && 'entries' in result ? result.review_id : selectedId;
      if (selectCommitted && 'entries' in result) { setSelectedId(result.review_id); setToken(result.state); }
      pending.current = null;
      if (!current(e, life)) { needsRefresh.current = true; return; }
      const proof = await protect(id); if (current(e, life)) accept(proof);
    } catch (failure) {
      if (!current(e, life)) return;
      if (denied(failure)) fail(failure);
      else {
        try { const proof = await protect(); if (current(e, life)) { accept(proof); setError(failure instanceof Error ? failure.message : 'Operation failed. Prepared fields, original token and retry key remain.'); } }
        catch (authorityError) { if (current(e, life)) fail(authorityError); }
      }
    } finally { if (mounted.current && e === epoch.current) setBusy(false); }
  }
  function submit(operation: string, payload: object, state?: string, selectCommitted = false) { if (pending.current?.operation !== operation) pending.current = null; pending.current ??= { operation, payload: structuredClone(payload), state, key: randomUUID() }; void run(pending.current, selectCommitted); }
  function discard() { epoch.current++; lifecycle.current++; pending.current = null; setOldScope(projectId); setCandidateScope(projectId); setReviewAfter(null); setInboxAfter(null); setParentAfter(null); setChangesOffset(0); setPair({ old_revision_id: '', candidate_revision_id: '' }); setSelectedId(null); setSelected(null); setToken(undefined); setComparison(null); setResponseBasis(''); setBasis(''); setTitle(''); setRecipients(''); setKnowledgeId(''); setKnowledgeNumber(''); setCitation(''); setBundleRevision(''); setSourcePath(''); setOwningSnapshot(''); setPaths(''); setUpgradeBasis(''); setError(null); setBlocked(false); setBusy(false); setFenced(true); needsRefresh.current = true; setRefreshTick(t => t + 1); }
  const visible = active && focused && !busy && choiceBusy === 0 && !fenced && !blocked;
  const evidence: Evidence = evidenceStatus === 'unknown' ? { status: 'unknown' } : evidenceStatus === 'unverified_citation' ? { status: evidenceStatus, citation } : { status: evidenceStatus, source_bundle_revision_id: bundleRevision, source_path: sourcePath };
  return <Stack><Title order={2}>Team changes</Title><Text>Compare exact declared facts, discuss a pinned change and inspect internal notifications. Recommendations do not establish compatibility, release approval or physical qualification. Engineering adoption is separate.</Text>
    <Group><Button disabled={busy || !active || !focused || choiceBusy > 0} onClick={() => void refresh()}>Refresh review access</Button><Button variant="subtle" onClick={discard}>Discard prepared review selection</Button>{selectedId && <Button variant="subtle" onClick={() => changed(() => { setSelectedId(null); setSelected(null); setToken(undefined); }, true)}>Close selected team review</Button>}</Group>
    {error && <Alert color="red">{error}</Alert>}{blocked && <Alert color="red">Current access is unavailable. Protected labels and prepared fields are hidden; staging and original retry intent remain inert.</Alert>}{!visible && <Alert>Review display is fenced until exact inputs, selected history and inbox are freshly authorized.</Alert>}
    <Fieldset legend="Prepared change review" disabled={!visible} inert={!visible} aria-hidden={!visible} style={{ display: visible ? undefined : 'none' }}><Stack>
      <Select dropdownOpened={visible && oldScopeOpen} onDropdownOpen={() => setOldScopeOpen(true)} onDropdownClose={() => setOldScopeOpen(false)} label="Old revision project" data={projects.map(p => ({ value: p.project_id, label: p.name }))} value={oldScope} onChange={id => { if (id) changed(() => { setOldScope(id); setPair(p => ({ ...p, old_revision_id: '' })); }, true); }} />
      <RevisionChoice label="Old exact pin" kinds={oldDefs.map(d => d.kind)} definitions={oldDefs} value={pair.old_revision_id || null} onChange={id => pickPair('old_revision_id', id)} onDenied={fail} disabled={!visible} active={active && focused} onActivity={choices} />
      <Select dropdownOpened={visible && candidateScopeOpen} onDropdownOpen={() => setCandidateScopeOpen(true)} onDropdownClose={() => setCandidateScopeOpen(false)} label="Candidate revision project" data={projects.map(p => ({ value: p.project_id, label: p.name }))} value={candidateScope} onChange={id => { if (id) changed(() => { setCandidateScope(id); setPair(p => ({ ...p, candidate_revision_id: '' })); }, true); }} />
      <RevisionChoice label="Candidate exact pin" kinds={candidateDefs.map(d => d.kind)} definitions={candidateDefs} value={pair.candidate_revision_id || null} onChange={id => pickPair('candidate_revision_id', id)} onDenied={fail} disabled={!visible} active={active && focused} onActivity={choices} />
      <TextInput label="Change review title" value={title} onChange={e => changed(() => setTitle(e.currentTarget.value))} />
      <Textarea label="Opening review basis" value={basis} onChange={e => changed(() => setBasis(e.currentTarget.value))} />
      <TextInput label="Explicit recipient usernames (comma separated)" value={recipients} onChange={e => changed(() => setRecipients(e.currentTarget.value))} />
      <TextInput label="Existing knowledge identity (optional)" value={knowledgeId} onChange={e => changed(() => setKnowledgeId(e.currentTarget.value))} />
      <TextInput label="Exact knowledge entry number" value={knowledgeNumber} onChange={e => changed(() => setKnowledgeNumber(e.currentTarget.value))} />
      <Button disabled={!canEdit || !pair.old_revision_id || !pair.candidate_revision_id || !title.trim() || !basis.trim() || !!knowledgeId && !/^\d+$/.test(knowledgeNumber)} onClick={() => submit('collaboration.create', { project_id: projectId, ...pair, title, basis, recipients: recipients.split(',').map(n => n.trim()).filter(Boolean), knowledge: knowledgeId ? { item_id: knowledgeId, entry_number: Number(knowledgeNumber) } : null }, undefined, true)}>Open team review</Button>
    </Stack></Fieldset>
    {visible && comparison && <Stack><Title order={3}>Exact declared comparison</Title><Text>{comparison.old.name} revision {comparison.old.number} · {comparison.old.revision_id} · {comparison.old.sha256}</Text><Text>{comparison.candidate.name} revision {comparison.candidate.number} · {comparison.candidate.revision_id} · {comparison.candidate.sha256}</Text><Text>Identity: {comparison.identity_relation}. Feature correspondence, compatibility and qualification: not evaluated.</Text>
      <Table><Table.Thead><Table.Tr><Table.Th>Declared JSON path</Table.Th><Table.Th>Change</Table.Th><Table.Th>Old declared value</Table.Th><Table.Th>Candidate declared value</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{comparison.changes.map((c, i) => <Table.Tr key={i}><Table.Td>{JSON.stringify(c.path)}</Table.Td><Table.Td>{c.change}</Table.Td><Table.Td>{value(c.old, c.old_present)}</Table.Td><Table.Td>{value(c.candidate, c.candidate_present)}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
      <Group><Button disabled={changesOffset === 0} onClick={() => changed(() => setChangesOffset(0), true)}>First changes</Button><Button disabled={comparison.next_changes_offset === null} onClick={() => changed(() => setChangesOffset(comparison.next_changes_offset ?? 0), true)}>Next changes</Button></Group>
      <Select label="Captured parent pin side" data={['old', 'candidate']} value={parentSide} onChange={v => { if (v === 'old' || v === 'candidate') changed(() => { setParentSide(v); setParentAfter(null); }, true); }} />
      <Title order={4}>Authorized captured parents</Title>{comparison.parents.results.map(p => <Text key={p.snapshot_id}>{p.label} · exact snapshot {p.snapshot_id}</Text>)}<Text>Hidden parents are omitted without counts. This is captured dependency use, not complete physical or artifact impact.</Text>
      <Group><Button disabled={!parentAfter} onClick={() => changed(() => setParentAfter(null), true)}>First parents</Button><Button disabled={!comparison.parents.next_after} onClick={() => changed(() => setParentAfter(comparison.parents.next_after), true)}>Next parents</Button></Group>
      {comparison.limitations.map(x => <Text key={x} size="sm">{x}</Text>)}
    </Stack>}
    {visible && <Stack><Title order={3}>Internal notifications</Title>{notices.map(n => <Group key={n.notification_id}><Text>{n.title} · {n.action} · {n.read_at ? 'Read' : 'Unread'}</Text><Button onClick={() => selectReview(n.review_id)}>Open notified review</Button><Button disabled={!!n.read_at} onClick={() => submit('collaboration.mark_read', { notification_id: n.notification_id }, n.state)}>Mark notification read</Button></Group>)}<Group><Button disabled={!inboxAfter} onClick={() => changed(() => setInboxAfter(null), true)}>First notifications</Button><Button disabled={!inboxNext} onClick={() => changed(() => setInboxAfter(inboxNext), true)}>Next notifications</Button></Group>
      <Select label="Retained team review" clearable data={reviews.map(r => ({ value: r.review_id, label: `${r.title} · ${r.review_id}` }))} value={selectedId} onChange={selectReview} /><Group><Button disabled={!reviewAfter} onClick={() => changed(() => setReviewAfter(null), true)}>First reviews</Button><Button disabled={!reviewNext} onClick={() => changed(() => setReviewAfter(reviewNext), true)}>Next reviews</Button></Group>
    </Stack>}
    {visible && selected && <Stack><Title order={3}>Selected exact review history</Title><Text>{selected.title} · {selected.status} · {selected.state}</Text><Text>Old: {selected.old.name} · {selected.old.revision_id} · {selected.old.sha256}</Text><Text>Candidate: {selected.candidate.name} · {selected.candidate.revision_id} · {selected.candidate.sha256}</Text><Text>Recipients: {selected.recipients.map(r => r.username).join(', ') || 'Personal review'}</Text>
      {selected.knowledge && <Stack><Text>Knowledge {selected.knowledge.item_id}, exact entry {selected.knowledge.number}: {selected.knowledge.title}</Text><Text style={{ whiteSpace: 'pre-wrap' }}>{selected.knowledge.body}</Text>{selected.knowledge.attachments.map(a => <Text key={a.path}>{a.path} · {a.sha256} · {a.rights}</Text>)}</Stack>}
      {selected.entries.map(e => <Stack key={e.entry_id} gap="xs"><Text>{e.number} · {e.action} · {e.author} · {e.created_at}</Text><Text style={{ whiteSpace: 'pre-wrap' }}>{e.basis}</Text><Text>Evidence: {e.evidence.status}{e.evidence.citation ? ` · ${e.evidence.citation}` : ''}{e.evidence.source_path ? ` · ${e.evidence.source_bundle_revision_id} / ${e.evidence.source_path} · ${e.evidence.sha256} · ${e.evidence.rights}` : ''}</Text>{e.upgrade_proposal_id && <Group><Text>Separate exact upgrade proposal: {e.upgrade_proposal_id}</Text>{onOpenUpgrade && <Button onClick={() => onOpenUpgrade(e.upgrade_proposal_id!)}>Inspect upgrade separately</Button>}</Group>}</Stack>)}
      <Text>Compatibility, physical qualification and release approval remain not evaluated. A recommendation changes only this discussion.</Text>
      <Button disabled={!canEdit} onClick={() => { pending.current = null; setToken(selected.state); setError(null); }}>Review latest state and use a new response token</Button><Text>Prepared response token: {token ?? 'Deliberate latest-state review required'}{token && token !== selected.state ? ' · Historic; inspect current history before replacing it' : ''}</Text>
    </Stack>}
    <Fieldset legend="Prepared team response" disabled={!visible || !selected || !canEdit} inert={!visible} aria-hidden={!visible} style={{ display: visible ? undefined : 'none' }}><Stack><Select label="Team response" data={['comment', 'recommend', 'request_changes', 'decline', 'close', 'reopen']} value={action} onChange={v => changed(() => setAction(v ?? 'comment'))} /><Textarea label="Prepared response basis" value={responseBasis} onChange={e => changed(() => setResponseBasis(e.currentTarget.value))} /><Select label="Review evidence status" data={['unknown', 'unverified_citation', 'registered_file']} value={evidenceStatus} onChange={v => changed(() => setEvidenceStatus(v as Evidence['status']))} />{evidenceStatus === 'unverified_citation' && <TextInput label="Unverified citation" value={citation} onChange={e => changed(() => setCitation(e.currentTarget.value))} />}{evidenceStatus === 'registered_file' && <><TextInput label="Exact evidence source revision" value={bundleRevision} onChange={e => changed(() => setBundleRevision(e.currentTarget.value))} /><TextInput label="Exact evidence file path" value={sourcePath} onChange={e => changed(() => setSourcePath(e.currentTarget.value))} /></>}
      <Button disabled={!selected || !canEdit || !token || !responseBasis.trim()} onClick={() => { if (selected) submit('collaboration.respond', { review_id: selected.review_id, action, basis: responseBasis, evidence }, token, true); }}>Submit prepared team response</Button>
      <TextInput label="Exact owning assembly snapshot for proposal" value={owningSnapshot} onChange={e => changed(() => setOwningSnapshot(e.currentTarget.value))} /><Textarea label="Explicit direct occurrence IDs (one per line)" value={paths} onChange={e => changed(() => setPaths(e.currentTarget.value))} /><Textarea label="Separate upgrade proposal basis" value={upgradeBasis} onChange={e => changed(() => setUpgradeBasis(e.currentTarget.value))} /><Text>Supported upgrade proposals use later revisions of one identity and direct assembly occurrences. Replacement identities and further contexts need a reviewed adapter. Nothing is adopted by this button.</Text>
      <Button disabled={!selected || !canEdit || !token || !owningSnapshot || !paths.trim() || !upgradeBasis.trim()} onClick={() => { if (selected) submit('collaboration.propose_upgrade', { review_id: selected.review_id, owning_snapshot_id: owningSnapshot, paths: paths.split('\n').map(x => x.trim()).filter(Boolean).map(x => [x]), basis: upgradeBasis }, token, true); }}>Propose separate exact upgrade</Button>
    </Stack></Fieldset>
  </Stack>;
}
