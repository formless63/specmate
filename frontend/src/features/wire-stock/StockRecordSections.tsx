import { lazy, Suspense, useMemo, useState } from 'react';
import { Alert, Button, Group, Select, Stack, Table, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import type { Section, StockSpecification } from '../../../../packages/section-layout/src';
import { RecordSections } from '../../components/record';
import { RevisionWhereUsed } from '../../components/record/RevisionWhereUsed';
import { rowLook, Swatch } from '../cable-views/Swatch';
import { useText, type StockConventions } from '../interfaces/api';
import { requestJson, type LibraryRecord, type Project } from '../workspace/api';
import { listLibraryTable } from '../library-gallery/table-api';
import { adaptFrozenProfile } from './profile-adapter';
import { readProfileRevision, type ProfileRevision } from '../workshop-profiles/api';
import { WorkshopProfileProvenance } from '../workshop-profiles/PracticeProvenance';
import { useNavigation } from '../navigation';
import { applicabilityPath, type ApplicabilityList } from '../evidence/api';
import { AddButton, UsedInList, useReferenceActions } from '../scope/LibraryView';
import { usePermission } from '../../lib/permissions';
import { command } from '../identity/api';
import type { Subject } from '../facts/api';
const RevisionCatalog = lazy(() => import('../identity/RevisionCatalog').then(module => ({ default: module.RevisionCatalog })));
const StockPreparationEditor = lazy(() => import('./StockPreparationEditor').then(module => ({ default: module.StockPreparationEditor })));
const FactLedger = lazy(() => import('../facts/FactLedger').then(module => ({ default: module.FactLedger })));

/** Numbers are the section renderer's existing stable material tags. Use remains a cited preference. */
export function StockLegend({ section, revisionId, active, principalKey }: { section: Section; revisionId: string | null; active: boolean; principalKey: string }) {
  const conventions = useQuery({ queryKey: ['stock-conventions', principalKey, revisionId], enabled: active && !!revisionId, retry: false,
    queryFn: ({ signal }) => requestJson<StockConventions>(`/api/v0/interfaces/stock-revisions/${revisionId}/conventions`, { signal }) });
  const entries = !conventions.isError && !conventions.isFetching ? conventions.data?.conventions ?? [] : [];
  return <Table.ScrollContainer minWidth={380}><Table verticalSpacing={4} aria-label="Numbered section legend"><Table.Thead><Table.Tr><Table.Th>No. / element</Table.Th><Table.Th>Color / material</Table.Th><Table.Th>Use</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{section.rows.map(row => {
    const uses = entries.flatMap(entry => (entry.matches ?? []).filter(match => match.element_path === row.path).map(match => `${useText(match.rule.use)} · ${match.rule.preference} (${entry.name} r${entry.number})`));
    const look = rowLook(row);
    return <Table.Tr key={row.path}><Table.Td>{row.tag} · {row.label}<Text size="xs">{row.kind}</Text></Table.Td><Table.Td><Swatch look={look} />{look.colorLabel}<br />{row.material ?? 'Material unknown'}</Table.Td><Table.Td>{uses.length ? uses.join('; ') : 'Unknown'}</Table.Td></Table.Tr>;
  })}</Table.Tbody></Table>{conventions.isError && <Text size="xs">Conventions unavailable; use is unknown.</Text>}<Text size="xs" c="dimmed">Use comes only from recorded convention preferences; it does not establish a signal assignment.</Text></Table.ScrollContainer>;
}

/** One metadata page, then one explicitly chosen exact profile. No per-row content reads. */
export function StockPractices({ active, principalKey, revisionId, stock, onApply }: { active: boolean; principalKey: string; revisionId: string; stock: StockSpecification; onApply: (profile: ProfileRevision) => void }) {
  const nav = useNavigation(); const [after, setAfter] = useState<string | null>(null); const [query, setQuery] = useState(''); const [chosen, setChosen] = useState<string | null>(null);
  const profiles = useQuery({ queryKey: ['stock-practice-choices', principalKey, after, query], enabled: active, retry: false,
    queryFn: () => listLibraryTable({ kinds: ['workshop_profile'], query, projectFilterId: null, after }) });
  const exact = useQuery({ queryKey: ['stock-practice', principalKey, chosen], enabled: active && !!chosen, retry: false, queryFn: () => readProfileRevision(chosen!) });
  const profile: ProfileRevision | null = exact.isError || exact.isFetching ? null : exact.data ?? null;
  const matches = profile?.content.profile.stock_revision_id === revisionId;
  const applied = useMemo(() => matches && profile ? adaptFrozenProfile(profile, revisionId, stock) : null, [matches, profile, revisionId, stock]);
  return <Stack gap="xs"><Text size="sm">A practice is a versioned suggestion pinned to one frozen construction. It does not change stock facts.</Text>
    <Select label="Frozen practice" searchable searchValue={query} onSearchChange={value => { setQuery(value); setAfter(null); }} clearable value={chosen} onChange={setChosen}
      data={(profiles.isError ? [] : profiles.data?.results ?? []).filter(item => item.latest_revision_id).map(item => ({ value: item.latest_revision_id!, label: `${item.label} · r${item.latest_revision}` }))} nothingFoundMessage="No frozen practices on this page" />
    <Group gap="xs"><Button size="xs" variant="quiet" disabled={!after} onClick={() => setAfter(null)}>First page</Button><Button size="xs" variant="quiet" disabled={!profiles.data?.next_after || profiles.isError} onClick={() => setAfter(profiles.data!.next_after)}>More practices</Button></Group>
    {(profiles.isError || exact.isError) && <Alert color="yellow">Practices unavailable. No retained practice is applied.</Alert>}
    {profile && !matches && <Alert color="yellow">This practice pins another stock revision. Its display is not applied to this construction.</Alert>}
    {profile && matches && <><Text size="sm">{profile.name} · frozen r{profile.number}</Text><Button size="xs" onClick={() => applied && onApply(profile!)}>Apply to this display</Button><WorkshopProfileProvenance profile={profile.content.profile} />{applied?.notices.map((notice, i) => <Text size="xs" key={i}>{notice}</Text>)}</>}
    <Button variant="quiet" size="xs" onClick={() => nav?.navigate({ area: 'library', lens: 'workshop-profiles', probe: null, filters: {} })}>Open practice authoring</Button>
    <RecordSections sections={[
      { id: 'cut', label: 'Cut arithmetic profiles', content: () => <Suspense fallback={<Text>Loading cut preparation…</Text>}><StockPreparationEditor key={`cut:${revisionId}`} kind="cut" stock={stock} revisionId={revisionId} principalKey={principalKey} active={active} /></Suspense> },
      { id: 'end', label: 'Per-end strip, shield and drain rules', content: () => <Suspense fallback={<Text>Loading end preparation…</Text>}><StockPreparationEditor key={`end:${revisionId}`} kind="end" stock={stock} revisionId={revisionId} principalKey={principalKey} active={active} /></Suspense> },
    ]} />
  </Stack>;
}

function StockEvidence({ active, principalKey, workspaceId, revisionId }: { active: boolean; principalKey: string; workspaceId: string; revisionId: string }) {
  const [offset, setOffset] = useState(0);
  const evidence = useQuery({ queryKey: ['stock-evidence', principalKey, revisionId, offset], enabled: active, retry: false,
    queryFn: ({ signal }) => requestJson<ApplicabilityList>(`/api/v0/${applicabilityPath(workspaceId, revisionId, offset)}`, { signal }) });
  if (evidence.isError) return <Alert color="yellow">Evidence unavailable. Retained observations are hidden.</Alert>;
  return <Stack gap="xs">{evidence.isPending ? <Text role="status">Reading evidence…</Text> : <>{evidence.data?.items.length === 0 && <Text>No applicable evidence on this page.</Text>}{evidence.data?.items.map(({ item, applicability }) => <div key={item.evidence_id}><Text fw={600} size="sm">{item.kind_label} · {item.status}</Text><Text size="sm">{item.statement}</Text><Text size="xs">{applicability.status.replaceAll('_', ' ')} · {applicability.reason}</Text><Text size="xs">{item.basis.origin} · {item.basis.references.join('; ') || 'Source unknown'}</Text></div>)}{evidence.data?.scan_limit_reached && <Text size="xs">Bounded evidence scan reached; results may be incomplete.</Text>}<Group><Button size="xs" variant="quiet" disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 50))}>Previous evidence</Button><Button size="xs" variant="quiet" disabled={!evidence.data?.has_more} onClick={() => setOffset(value => value + 50)}>More evidence</Button></Group></>}</Stack>;
}

function StockAttachedFacts({ definitionId, revisionId, workspaceId, principalKey, active }: { definitionId: string; revisionId: string | null; workspaceId: string; principalKey: string; active: boolean }) {
  const [subjectId, setSubject] = useState<string | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const gate = usePermission('item.create');
  const [offset, setOffset] = useState(0);
  const subjects = useQuery({ queryKey: ['stock-fact-subjects', principalKey, definitionId, revisionId, offset], enabled: active, retry: false,
    queryFn: ({ signal }) => requestJson<Subject[]>(`/api/v0/facts/workspaces/${workspaceId}/subjects?offset=${offset}&limit=50`, { signal }) });
  if (subjects.isError) return <Alert color="yellow">Fact ledgers unavailable. Retained assertions are hidden.</Alert>;
  const matching = (subjects.isError ? [] : subjects.data ?? []).filter(subject => !('feature_id' in subject.target) || !subject.target.feature_id).filter(subject => revisionId ? subject.target.kind === 'revision' && subject.target.revision_id === revisionId : subject.target.kind === 'definition' && subject.target.definition_id === definitionId);
  return <Stack gap="xs"><Text size="sm">Attached assertions stay separate from frozen construction facts.</Text>{subjects.isError && <Alert color="yellow">Fact ledgers unavailable.</Alert>}{!subjectId && <><Select label="Existing selected-state fact ledger" value={subjectId} onChange={setSubject} data={matching.map(subject => ({ value: subject.subject_id, label: subject.target.kind === 'revision' ? 'Exact revision ledger' : 'Definition ledger' }))} placeholder={subjects.isPending ? "Loading ledgers…" : "No matching ledger on this page"} /><Group gap="xs"><Button size="xs" variant="quiet" disabled={!offset} onClick={() => setOffset(value => Math.max(0, value - 50))}>Previous ledgers</Button><Button size="xs" variant="quiet" disabled={(subjects.data?.length ?? 0) < 50 || subjects.isError} onClick={() => setOffset(value => value + 50)}>More ledgers</Button></Group><Button size="xs" loading={busy} {...gate.props} onClick={async () => { setBusy(true); setError(''); try { const subject = await command<Subject>('facts.register_subject', { target: revisionId ? { kind: 'revision', revision_id: revisionId } : { kind: 'definition', definition_id: definitionId } }); setSubject(subject.subject_id); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); } finally { setBusy(false); } }}>Register or open selected-state ledger</Button></>}{error && <Alert color="red">{error}</Alert>}{subjectId && <Suspense fallback={<Text>Loading fact ledger…</Text>}><FactLedger subjectId={subjectId} /></Suspense>}</Stack>;
}

export function StockRecordDetails({ active, principalKey, workspaceId, record, revisionId, revisionNumber, projects, onOpenInProject, toolLabel = 'Wire stock' }: { toolLabel?: string; active: boolean; principalKey: string; workspaceId: string; record: LibraryRecord; revisionId: string | null; revisionNumber: number | null; projects: Project[]; onOpenInProject: (project: string, record: LibraryRecord) => void }) {
  const actions = useReferenceActions(); const gate = usePermission('project.edit');
  const reference = revisionId ? { ...record, latest_revision_id: revisionId, latest_revision: revisionNumber } : record;
  return <RecordSections sections={[
    { id: 'used', label: 'Where used', content: () => revisionId ? <RevisionWhereUsed active={active} principalKey={principalKey} revisionId={revisionId} toolLabel={toolLabel} onOpenProject={projectId => onOpenInProject(projectId, record)} /> : <Stack gap="xs"><Text size="xs">Choose a frozen revision to inspect exact engineering parents.</Text><Text fw={500}>Project references</Text><UsedInList record={record} currentProjectId={null} toolLabel={toolLabel} onOpen={onOpenInProject} /></Stack> },
    { id: 'reference', label: 'Project reference', content: () => <><Text size="sm">Exact pins use the selected frozen state; floating references follow the definition.</Text><AddButton record={reference} projects={projects} busy={actions.busy} gate={gate} label="Use in project" onAdd={choice => actions.add(reference, choice, projects.find(project => project.project_id === choice.projectId)?.name ?? 'project')} />{actions.error && <Alert color="red">{actions.error}</Alert>}{actions.notice && <Text size="sm">{actions.notice}</Text>}</> },
    { id: 'evidence', label: 'Evidence', content: () => revisionId ? <StockEvidence key={revisionId} active={active} principalKey={principalKey} workspaceId={workspaceId} revisionId={revisionId} /> : <Text>Choose a frozen revision to inspect exact applicability.</Text> },
    { id: 'facts', label: 'Attached fact ledger', content: () => <StockAttachedFacts key={revisionId ?? record.record_id} definitionId={record.record_id} revisionId={revisionId} workspaceId={workspaceId} principalKey={principalKey} active={active} /> },
    { id: 'sources', label: 'Manufacturer numbers, sources and representations', content: () => revisionId ? <Suspense fallback={<Text>Loading exact catalog…</Text>}><RevisionCatalog scopeKey={`${principalKey}:${workspaceId}`} active={active} key={revisionId} revisionId={revisionId} workspaceId={workspaceId} /></Suspense> : <Text>Freeze the construction before registering exact-revision sources and manufacturer associations.</Text> },
  ]} />;
}
