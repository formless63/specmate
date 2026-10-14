import { Alert, Badge, Button, Card, Checkbox, Group, NativeSelect, Stack, Table, Text, Textarea, Title } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { randomUUID } from '../../lib/random-id';
import { InspectionScope, ReadOnlyNote, usePermission } from '../../lib/permissions';
import { read, type Identity } from '../identity/api';
import { operation, type AdoptionAction, type AdoptionChange, type AdoptionLevel, type AdoptionResult, type AdoptionReview, type AdoptionRow, type AdoptionValue, type Pin } from './api';

const NEW = '__new__';
const ACTION: Record<AdoptionAction, { label: string; color?: string }> = {
  replace_revision: { label: 'Replace pin', color: 'yellow' },
  propagate_revision: { label: 'Propagate pin', color: 'yellow' },
  assign_population_option: { label: 'Set population option', color: 'yellow' },
  assign_firmware: { label: 'Set firmware', color: 'yellow' },
  unchanged: { label: 'Unchanged', color: 'green' },
  not_applicable: { label: 'Not an assembly field', color: 'blue' },
  blocked: { label: 'Blocked', color: 'red' },
};
const CHANGES = new Set<AdoptionAction>(['replace_revision', 'propagate_revision', 'assign_population_option', 'assign_firmware']);
const FIELD: Record<AdoptionChange['field'], string> = { revision_id: 'Occurrence revision', population_option_id: 'Population option', firmware: 'Contextual firmware' };

type Submission = { payload: Record<string, unknown>; state: string | null; key: string };

function pinText(pin: Pin | null | undefined, empty = 'Unassigned') {
  return pin ? `${pin.name} · rev ${pin.number}` : empty;
}

/** A diff value: an exact pin, a revision frozen by this adoption, or a population option. */
function valueText(value: AdoptionValue, field: AdoptionChange['field']) {
  if (value === null) return field === 'population_option_id' ? 'Not recorded' : 'Unassigned';
  if (typeof value === 'string') return `Option ${value}`;
  if ('proposed' in value) return `New revision of ${value.name}`;
  return pinText(value);
}

function currentText(row: AdoptionRow) {
  if (!CHANGES.has(row.action)) return '-';
  if (row.action === 'assign_population_option') return valueText(row.population_option_before, 'population_option_id');
  return pinText(row.before);
}

function choiceText(row: AdoptionRow) {
  if (!row.choice) return null;
  if (!row.choice.revision) return row.choice.value;
  return pinText(row.choice.revision) + (row.choice.population_option_id ? ` · option ${row.choice.population_option_id}` : '');
}

function LevelDiff({ level }: { level: AdoptionLevel }) {
  const where = level.path.join('/');
  return <Stack gap={4}>
    <Text size="sm"><Badge variant="occurrence">{level.display_ref ? `${level.display_ref} · ` : ''}{where}</Badge> New draft of <Badge variant="frozen">{pinText(level.pinned)}</Badge>, frozen as a new revision and re-pinned by its parent.</Text>
    <Table aria-label={`Sub-assembly diff ${where}`}>
      <Table.Thead><Table.Tr><Table.Th>Occurrence</Table.Th><Table.Th>Before</Table.Th><Table.Th>After</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{level.changes.map((item) => <Table.Tr key={item.local_id}>
        <Table.Td><Badge variant="occurrence">{item.display_ref ? `${item.display_ref} · ` : ''}{item.local_id}</Badge></Table.Td>
        <Table.Td style={{ fontFamily: 'var(--sb-font-data)' }}><del>{pinText(item.before)}</del></Table.Td>
        <Table.Td style={{ fontFamily: 'var(--sb-font-data)' }}><ins>{valueText(item.after, 'revision_id')}</ins></Table.Td>
      </Table.Tr>)}</Table.Tbody>
    </Table>
  </Stack>;
}

/**
 * Reviewed adoption of a captured resolution into an owning assembly draft. The diff is
 * reviewed first; applying requires explicit confirmation and the exact review hash, with
 * compare-and-set on a selected draft. Frozen revisions are never changed.
 */
export function AdoptionReviewPanel({ resolvedId }: { resolvedId: string }) {
  const editGate = usePermission('design.edit');
  const freeze = usePermission('design.freeze');
  const generation = useRef(0);
  const [owner, setOwner] = useState(NEW);
  const [drafts, setDrafts] = useState<Identity['drafts']>([]);
  const [keys, setKeys] = useState<string[] | null>(null);
  const [review, setReview] = useState<AdoptionReview | null>(null);
  const [basis, setBasis] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [result, setResult] = useState<AdoptionResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function refresh(nextOwner = owner, nextKeys = keys) {
    const token = ++generation.current;
    setBusy(true); setError(''); setConfirming(false); setSubmission(null);
    try {
      const reviewed = await operation<AdoptionReview>('configuration.review_adoption', {
        resolved_configuration_id: resolvedId, ...(nextOwner === NEW ? {} : { draft_id: nextOwner }), ...(nextKeys ? { option_keys: nextKeys } : {}) });
      if (token !== generation.current) return;
      setReview(reviewed); setKeys(reviewed.option_keys.length ? reviewed.option_keys : nextKeys);
    } catch (failure) { if (token === generation.current) { setReview(null); setError((failure as Error).message); } }
    finally { if (token === generation.current) setBusy(false); }
  }
  useEffect(() => { void refresh(); return () => { generation.current++; }; }, []); // A new resolved snapshot remounts this panel.
  const definitionId = review?.owner.definition_id;
  useEffect(() => {
    let active = true;
    if (definitionId) read<Identity>(`catalog/definitions/${definitionId}`).then((data) => { if (active) setDrafts(data.drafts); }).catch(() => { if (active) setDrafts([]); });
    return () => { active = false; };
  }, [definitionId, result]);
  function toggle(key: string, on: boolean) {
    const current = new Set(keys ?? review?.option_keys ?? []);
    if (on) current.add(key); else current.delete(key);
    const next = [...current].sort();
    setKeys(next); setResult(null);
    if (next.length) void refresh(owner, next); else { generation.current++; setReview((value) => value && { ...value, eligible: false, changes: [], message: 'Select at least one choice to adopt.', rows: value.rows.map((row) => ({ ...row, selected: false })) }); setConfirming(false); }
  }
  async function adopt(retry = false) {
    if (!review) return;
    const request: Submission = retry && submission ? submission : {
      payload: { resolved_configuration_id: resolvedId, option_keys: review.option_keys, review_sha256: review.review_sha256, basis: basis.trim(), ...(review.owner.draft_id ? { draft_id: review.owner.draft_id } : {}) },
      state: review.owner.state, key: randomUUID(),
    };
    const token = ++generation.current;
    setSubmission(request); setBusy(true); setError('');
    try {
      const done = await operation<AdoptionResult>('configuration.adopt', request.payload, request);
      if (token !== generation.current) return;
      setSubmission(null); setConfirming(false); setBasis(''); setResult(done);
      const nextOwner = done.draft_id; setOwner(nextOwner);
      await refresh(nextOwner, null);
      setResult(done);
    } catch (failure) {
      // The retained submission keeps its idempotency key so a retry cannot apply twice.
      if (token === generation.current) { setError(`${(failure as Error).message} Review the diff again if the draft or selection changed.`); setBusy(false); }
    }
  }
  const selected = new Set(review?.option_keys ?? []);
  const propagating = (review?.propagation.length ?? 0) > 0;
  // Freezing each containing sub-assembly needs its own authority.
  const edit = propagating && !freeze.allowed ? freeze : editGate;
  const total = review ? review.changes.length + review.propagation.reduce((sum, level) => sum + level.changes.length, 0) : 0;
  return <Card withBorder><Stack gap="sm">
    <Title order={4}>Adopt into an assembly draft</Title>
    <Text size="sm">Review exactly how the resolved choices would change an owning assembly draft. Frozen revisions and this resolved snapshot stay unchanged; compatibility between adopted pins is not evaluated.</Text>
    {error && <Alert color="red">{error}</Alert>}
    {review && <>
      <Group align="end">
        <NativeSelect label="Adopt into" disabled={busy} value={owner}
          data={[{ value: NEW, label: `New draft of ${pinText(review.target)}` }, ...drafts.map((item) => ({ value: item.draft_id, label: `Draft ${item.draft_id.slice(0, 8)} · ${item.state}` }))]}
          onChange={(event) => { const value = event.currentTarget.value; setOwner(value); setResult(null); void refresh(value, keys); }} />
        <Button variant="quiet" disabled={busy} onClick={() => { void refresh(); }}>Refresh review</Button>
      </Group>
      <dl className="sb-meter" style={{ display: 'flex', gap: 24, margin: 0, flexWrap: 'wrap' }}>
        <div><dt className="sb-silk">Resolution</dt><dd style={{ margin: 0, fontFamily: 'var(--sb-font-data)' }}>{review.resolution_sha256.slice(0, 12)}</dd></div>
        <div><dt className="sb-silk">Status</dt><dd style={{ margin: 0 }}><Badge variant="outline" color={review.resolution_status === 'complete' ? 'green' : 'yellow'}>{review.resolution_status}</Badge></dd></div>
        <div><dt className="sb-silk">Target</dt><dd style={{ margin: 0 }}><Badge variant="frozen">{pinText(review.target)}</Badge></dd></div>
        <div><dt className="sb-silk">Owner</dt><dd style={{ margin: 0 }}><Badge variant="draft">{review.owner.mode === 'new_draft' ? 'New draft' : review.owner.state}</Badge></dd></div>
        <div><dt className="sb-silk">Changes</dt><dd style={{ margin: 0, fontFamily: 'var(--sb-font-data)' }}>{total}</dd></div>
        <div><dt className="sb-silk">New sub-assembly revisions</dt><dd style={{ margin: 0, fontFamily: 'var(--sb-font-data)' }}>{review.propagation.length}</dd></div>
      </dl>
      <InspectionScope permission="design.edit"><Table>
        <Table.Thead><Table.Tr><Table.Th>Adopt</Table.Th><Table.Th>Option</Table.Th><Table.Th>Occurrence</Table.Th><Table.Th>Action</Table.Th><Table.Th>Current</Table.Th><Table.Th>Resolved choice</Table.Th><Table.Th>Reason</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{review.rows.map((row) => <Table.Tr key={row.option_key}>
          <Table.Td><Checkbox aria-label={`Adopt ${row.label}`} disabled={busy || !(CHANGES.has(row.action) || selected.has(row.option_key))} checked={selected.has(row.option_key)} onChange={(event) => toggle(row.option_key, event.currentTarget.checked)} /></Table.Td>
          <Table.Td><Text size="sm">{row.label}</Text><Text className="sb-silk">{row.domain}</Text></Table.Td>
          <Table.Td>{row.path ? <Badge variant="occurrence">{row.path.join('/')}</Badge> : <Text size="sm">Whole configuration</Text>}</Table.Td>
          <Table.Td><Badge variant="outline" color={ACTION[row.action].color}>{ACTION[row.action].label}</Badge></Table.Td>
          <Table.Td style={{ fontFamily: 'var(--sb-font-data)' }}>{currentText(row)}</Table.Td>
          <Table.Td style={{ fontFamily: 'var(--sb-font-data)' }}>{row.choice ? choiceText(row) : <Text size="sm">No resolved choice ({row.decision_status})</Text>}</Table.Td>
          <Table.Td><Text size="sm">{row.reason}</Text></Table.Td>
        </Table.Tr>)}</Table.Tbody>
      </Table></InspectionScope>
      <Title order={5}>Draft diff</Title>
      {review.changes.length === 0 ? <Text size="sm">No change to the owning draft is selected.</Text> : <Table aria-label="Draft diff">
        <Table.Thead><Table.Tr><Table.Th>Occurrence</Table.Th><Table.Th>Field</Table.Th><Table.Th>Before</Table.Th><Table.Th>After</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>{review.changes.map((item) => <Table.Tr key={`${item.field}:${item.path.join('/')}`}>
          <Table.Td><Badge variant="occurrence">{item.display_ref ? `${item.display_ref} · ` : ''}{item.path.join('/')}</Badge></Table.Td>
          <Table.Td><Text size="sm">{FIELD[item.field]}</Text></Table.Td>
          <Table.Td style={{ fontFamily: 'var(--sb-font-data)' }}><del>{valueText(item.before, item.field)}</del></Table.Td>
          <Table.Td style={{ fontFamily: 'var(--sb-font-data)' }}><ins>{valueText(item.after, item.field)}</ins></Table.Td>
        </Table.Tr>)}</Table.Tbody>
      </Table>}
      {propagating && <>
        <Title order={5}>Containing sub-assemblies</Title>
        <Text size="sm">A nested choice changes the pin inside its containing sub-assembly. Each one below gets a new draft of its exact pinned revision, frozen as a new revision; other uses of the old revision keep it.</Text>
        {review.propagation.map((level) => <LevelDiff key={level.path.join('/')} level={level} />)}
        <ReadOnlyNote permission="design.freeze" />
      </>}
      {review.warnings.map((item) => <Alert key={item.path.join('/')} color="yellow">{item.path.join('/')}: {item.message}</Alert>)}
      <Text size="sm" role="status">{review.message}</Text>
      <ReadOnlyNote permission="design.edit" />
      <InspectionScope permission="design.edit"><Textarea label="Adoption basis" disabled={busy} value={basis} onChange={(event) => { setBasis(event.currentTarget.value); setSubmission(null); }} /></InspectionScope>
      {!confirming ? <Group>
        <Button {...edit.props} disabled={!edit.allowed || busy || !review.eligible || !basis.trim()} onClick={() => setConfirming(true)}>Adopt {total} change{total === 1 ? '' : 's'}…</Button>
      </Group> : <Alert color="yellow" title="Confirm adoption">
        <Stack gap="xs">
          <Text size="sm">{review.owner.mode === 'new_draft' ? `A new draft of ${pinText(review.target)} will be created with these ${total} change(s).` : `Draft ${review.owner.draft_id?.slice(0, 8)} at ${review.owner.state} will change only if it has not moved since this review.`}</Text>
          {propagating && <Text size="sm">{review.propagation.length} containing sub-assembly revision(s) will be frozen in the same step; nothing is written if any part fails.</Text>}
          <Group>
            <Button variant="commit" {...edit.props} disabled={!edit.allowed || busy} onClick={() => { void adopt(); }}>Confirm adoption</Button>
            <Button variant="quiet" disabled={busy} onClick={() => { setConfirming(false); setSubmission(null); }}>Cancel</Button>
            {submission && error && <Button variant="quiet" {...edit.props} disabled={!edit.allowed || busy} onClick={() => { void adopt(true); }}>Retry same request</Button>}
          </Group>
        </Stack>
      </Alert>}
      {result && <Alert color="green">Adopted {result.changes.length} change(s) into draft {result.draft_id.slice(0, 8)} · {result.state}{result.created_draft ? ' (new draft)' : ''}{result.propagated?.length ? `, freezing ${result.propagated.map((item) => `${item.path.join('/')} rev ${item.number}`).join(', ')}` : ''}. Evidence {result.adoption_id.slice(0, 8)} links it to this resolved snapshot.</Alert>}
      <Title order={5}>Adoption history</Title>
      {review.adoptions.length === 0 ? <Text size="sm">Not adopted into any draft yet.</Text> : review.adoptions.map((item) => <Group key={item.adoption_id} gap="xs">
        <Badge variant="frozen">{item.adoption_id.slice(0, 8)}</Badge><Text size="sm">Draft {item.draft_id.slice(0, 8)} v{item.draft_version}{item.created_draft ? ' (new)' : ''} · {item.option_keys.join(', ')}{item.propagated?.length ? ` · ${item.propagated.length} sub-assembly revision(s)` : ''} · {item.basis}</Text>
      </Group>)}
      {review.history_truncated && <Text size="sm">Only the latest 100 adoptions are listed.</Text>}
    </>}
    {!review && busy && <Text size="sm" role="status">Reviewing adoption…</Text>}
  </Stack></Card>;
}
