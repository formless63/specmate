import { useCan } from "../../lib/permissions";
import { Alert, Badge, Button, Card, Checkbox, Group, Select, Stack, Table, Text, Textarea, TextInput, Title } from '@mantine/core';
import { useState } from 'react';
import { command, preserve, registerBlob, SourceError, type EditReview, type RevisionDetail } from './api';
import { randomUUID } from '../../lib/random-id';
import { ExactPins, RevisionLabel } from "../../lib/IdentityLabel";

const MAX_FILES = 1000;
const MAX_FILE = 16 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;
type Prepared = { files: { path: string; sha256: string }[] } | { archive: { revision_id: string; path: string } };
type Target = 'new_derivative' | 'next_revision';
const changeLabel: Record<string, string> = { added: 'Added', modified: 'Modified', rights_changed: 'Rights changed', unchanged: 'Unchanged' };

/** Strip the selected folder name from browser-relative paths. */
export function folderPaths(files: File[]) {
  return files.map(file => {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    return { file, path: relative.includes('/') ? relative.slice(relative.indexOf('/') + 1) : relative };
  });
}

export function EditHandoff({ workspaceId, detail, busy, setBusy, onAuthorityFailure, onSubmitted }: {
  workspaceId: string; detail: RevisionDetail; busy: boolean; setBusy: (value: boolean) => void;
  onAuthorityFailure: (reason: unknown) => void; onSubmitted: (revisionId: string) => Promise<void>;
}) {
  const canWrite = useCan('source.register');
  const [mode, setMode] = useState<'zip' | 'folder'>('zip');
  const [archive, setArchive] = useState<File | null>(null);
  const [archiveRights, setArchiveRights] = useState('unknown');
  const [folder, setFolder] = useState<File[]>([]);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [review, setReview] = useState<EditReview | null>(null);
  const [rights, setRights] = useState<Record<string, string>>({});
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [reviewedWith, setReviewedWith] = useState('');
  const [target, setTarget] = useState<Target | null>('new_derivative');
  // Set when a submission conflicted: everything is kept, but a fresh review is required.
  const [stale, setStale] = useState('');
  // One key per reviewed submission, so retrying a lost response replays instead of duplicating.
  const [submitKey, setSubmitKey] = useState('');
  const [name, setName] = useState(`${detail.name} edited`);
  const [summary, setSummary] = useState('');
  const [error, setError] = useState('');
  const folderTotal = folder.reduce((sum, file) => sum + file.size, 0);
  const folderTooLarge = folder.length > MAX_FILES || folderTotal > MAX_TOTAL || folder.some(file => file.size > MAX_FILE);
  const decisions = JSON.stringify({ rights, excluded: [...excluded].sort() });
  const dirty = review !== null && decisions !== reviewedWith;

  function failed(reason: unknown) {
    if (reason instanceof SourceError && [401, 403, 404].includes(reason.status)) { onAuthorityFailure(reason); return; }
    // A conflict means the baseline or reviewed change set moved. Keep the prepared files and
    // every decision, but require a fresh review; never retry or merge blindly.
    if (reason instanceof SourceError && reason.status === 409) { setStale(reason.message); return; }
    setError(reason instanceof Error ? reason.message : 'Editing handoff request failed.');
  }
  function resetInput() { setPrepared(null); setReview(null); setRights({}); setExcluded(new Set()); setError(''); setStale(''); }
  function declarations(current: EditReview | null, values: Record<string, string>) {
    const baseline = new Map(current?.files.map(row => [row.path, row.rights_source === 'baseline' ? row.rights : null]) ?? []);
    return Object.entries(values).filter(([path, value]) => value.trim() && value.trim() !== baseline.get(path) && !excluded.has(path))
      .map(([path, value]) => ({ path, rights: value.trim() }));
  }
  async function prepare(): Promise<Prepared> {
    if (prepared) return prepared;
    let next: Prepared;
    if (mode === 'zip') {
      if (!archive) throw new Error('Choose an edited ZIP.');
      // The uploaded archive is itself preserved as an original before any review.
      const upload = await preserve(workspaceId, archive, `${detail.name} edited upload`, archiveRights.trim());
      next = { archive: { revision_id: upload.revision_id, path: archive.name } };
    } else {
      const files = [];
      for (const { file, path } of folderPaths(folder)) files.push({ path, sha256: await registerBlob(workspaceId, file) });
      next = { files };
    }
    setPrepared(next);
    return next;
  }
  async function runReview(firstPass: boolean) {
    setBusy(true); setError('');
    try {
      const input = await prepare();
      const values = firstPass ? {} : rights;
      const exclusions = firstPass ? new Set<string>() : excluded;
      const result = await command<EditReview>('source.preview_edit', {
        baseline_revision_id: detail.revision_id, ...input,
        rights: declarations(review, values), exclude_paths: [...exclusions].sort(),
      }, { idempotent: false });
      const nextRights = Object.fromEntries(result.files.map(row => [row.path, values[row.path] ?? row.rights ?? '']));
      for (const row of result.excluded) nextRights[row.path] = values[row.path] ?? '';
      setReview(result); setRights(nextRights); setStale(''); setSubmitKey(randomUUID());
      const nextExcluded = firstPass ? new Set(result.files.filter(row => row.suggested_exclusion).map(row => row.path)) : exclusions;
      setExcluded(nextExcluded);
      setReviewedWith(firstPass && nextExcluded.size ? '' : JSON.stringify({ rights: nextRights, excluded: [...nextExcluded].sort() }));
      // Never silently switch a stale next-revision submission into another target.
      if (!result.next_revision_allowed && target === 'next_revision') setTarget(firstPass ? 'new_derivative' : null);
    } catch (reason) { failed(reason); } finally { setBusy(false); }
  }
  async function submit() {
    if (!review || !prepared || !target || stale) return;
    setBusy(true); setError('');
    try {
      const result = await command<{ revision_id: string }>('source.submit_edit', {
        baseline_revision_id: detail.revision_id, ...prepared,
        rights: declarations(review, rights), exclude_paths: [...excluded].sort(),
        target, summary: summary.trim(), reviewed_sha256: review.review_sha256,
        ...(target === 'new_derivative' ? { name: name.trim() } : {}),
      }, { expectedState: review.state, idempotencyKey: submitKey });
      await onSubmitted(result.revision_id);
    } catch (reason) { failed(reason); } finally { setBusy(false); }
  }
  const allRows = review ? [...review.files, ...review.excluded.map(row => ({ ...row, change: 'excluded', baseline_sha256: null, rights: null, rights_source: 'missing' as const }))] : [];
  const missing = review ? review.files.filter(row => !excluded.has(row.path) && !rights[row.path]?.trim()).length + review.excluded.filter(row => !excluded.has(row.path) && !rights[row.path]?.trim()).length : 0;

  return <Card withBorder><Stack>
    <Title order={4}>Edit outside Specmate</Title>
    <Text size="sm">Download this exact revision, edit it with its native tool, then submit the edited files for review. Git is not required. Specmate keeps this revision unchanged and never merges edits. Files stay inert: re-entry does not run, validate or qualify them.</Text>
    <a href={`/api/v0/sources/revisions/${detail.revision_id}/handoff`}>Download editing handoff ZIP</a>
    <Text size="xs">The ZIP contains the exact files and SPECMATE-HANDOFF.json identifying this baseline (<RevisionLabel id={detail.revision_id} known={{ name: detail.name, kind: detail.role, number: detail.number }} />). Keep the marker so a different baseline is detected; it grants no authority.</Text>
    {canWrite && <Stack>
      <Title order={5}>Submit edited files</Title>
      {error && <Alert color="red">{error}</Alert>}
      <Select label="Edited files as" data={[{ value: 'zip', label: 'ZIP archive' }, { value: 'folder', label: 'Folder' }]} value={mode} disabled={busy}
        onChange={value => { if (value) { setMode(value as 'zip' | 'folder'); resetInput(); } }} allowDeselect={false} />
      {mode === 'zip' ? <>
        <label>Edited ZIP<input aria-label="Edited ZIP" type="file" accept=".zip,application/zip" disabled={busy} onChange={event => { setArchive(event.currentTarget.files?.[0] ?? null); resetInput(); }} /></label>
        <Text size="xs">Classic stored or deflated ZIP within the Sources expansion limits. Archives with streamed data descriptors (for example from some desktop compressors) are rejected; submit the folder instead.</Text>
        <TextInput label="Declared rights for the uploaded archive" description="The uploaded archive is preserved as its own original. File rights come from the baseline or your declarations below." value={archiveRights} disabled={busy} onChange={event => setArchiveRights(event.currentTarget.value)} />
      </> : <>
        <label>Edited folder<input aria-label="Edited folder" type="file" multiple disabled={busy} {...{ webkitdirectory: '', directory: '' }} onChange={event => { setFolder(Array.from(event.currentTarget.files ?? [])); resetInput(); }} /></label>
        <Text size="xs">{folder.length} files, {folderTotal} bytes. Up to {MAX_FILES} files, 16 MiB each and 64 MiB total.</Text>
        {folderTooLarge && <Text c="red">This folder exceeds the editing handoff limits.</Text>}
      </>}
      {!review && <Button disabled={busy || (mode === 'zip' ? !archive || !archiveRights.trim() : !folder.length || folderTooLarge)} onClick={() => void runReview(true)}>Review changes</Button>}
      {review && <Stack>
        <Text fw={600}>Review against revision {review.baseline.number} ({review.baseline.revision_id})</Text>
        <Text size="sm">Baseline manifest SHA-256: {review.baseline.manifest_sha256}</Text>
        <Text size="sm">{review.marker === 'matched' ? `Handoff marker matches this baseline${review.root_prefix ? `; folder ${review.root_prefix}/ is the bundle root` : ''}.` : 'No handoff marker: the selected revision is the declared baseline.'}</Text>
        {review.source.kind === 'zip' && <Text size="sm">Edited archive {review.source.path} · SHA-256 {review.source.sha256} · parser {review.source.parser}</Text>}
        {!review.baseline_is_head && <Alert color="yellow">This bundle now has revision {review.head_number}. Submitting creates a separate derivative from revision {review.baseline.number}; later revisions are not merged or replaced.</Alert>}
        <Group gap="xs">{Object.entries(review.counts).map(([kind, count]) => <Badge key={kind} variant="light">{kind.replace('_', ' ')}: {count}</Badge>)}</Group>
        <Table.ScrollContainer minWidth={800}><Table><Table.Thead><Table.Tr><Table.Th>Exclude</Table.Th><Table.Th>Path</Table.Th><Table.Th>Change</Table.Th><Table.Th>SHA-256</Table.Th><Table.Th>Declared rights</Table.Th></Table.Tr></Table.Thead><Table.Tbody>
          {allRows.map(row => <Table.Tr key={row.path}>
            <Table.Td><Checkbox aria-label={`Exclude ${row.path}`} checked={excluded.has(row.path)} disabled={busy} onChange={event => { const next = new Set(excluded); if (event.currentTarget.checked) next.add(row.path); else next.delete(row.path); setExcluded(next); }} /></Table.Td>
            <Table.Td>{row.path}{row.suggested_exclusion && <Text size="xs">Looks like an editor or operating-system by-product.</Text>}</Table.Td>
            <Table.Td>{changeLabel[row.change] ?? 'Excluded'}</Table.Td>
            <Table.Td style={{ overflowWrap: 'anywhere' }}><Text size="xs">{row.sha256}</Text>{row.baseline_sha256 && row.baseline_sha256 !== row.sha256 && <Text size="xs">was {row.baseline_sha256}</Text>}</Table.Td>
            <Table.Td><TextInput aria-label={`Rights for ${row.path}`} size="xs" value={rights[row.path] ?? ''} placeholder="unknown" disabled={busy || excluded.has(row.path)} onChange={event => { const value = event.currentTarget.value; setRights(previous => ({ ...previous, [row.path]: value })); }} /></Table.Td>
          </Table.Tr>)}
          {review.removed.map(row => <Table.Tr key={`removed-${row.path}`}><Table.Td /><Table.Td>{row.path}</Table.Td><Table.Td>Removed</Table.Td><Table.Td style={{ overflowWrap: 'anywhere' }}><Text size="xs">was {row.baseline_sha256}</Text></Table.Td><Table.Td>{row.rights}</Table.Td></Table.Tr>)}
        </Table.Tbody></Table></Table.ScrollContainer>
        {missing > 0 && <Text c="red" size="sm">Declare rights for every added file; use unknown when they have not been established.</Text>}
        {review.reasons.filter(reason => !reason.startsWith('Declare rights')).map(reason => <Text key={reason} c="red" size="sm">{reason}</Text>)}
        {stale && <Alert color="yellow">Not submitted: {stale} Your prepared files, rights, exclusions, name and summary are kept. Review again against the current state before submitting.</Alert>}
        {(dirty || stale) && <Button variant="light" disabled={busy || missing > 0} onClick={() => void runReview(false)}>Review again with these decisions</Button>}
        <Text size="xs">Review SHA-256: {review.review_sha256} · state {review.state}</Text>
        {!target && <Text c="red" size="sm">The next revision is no longer available. Choose how to submit.</Text>}
        <Select label="Submit as" allowDeselect={false} value={target} disabled={busy} onChange={value => value && setTarget(value as Target)} data={[
          { value: 'new_derivative', label: 'Separate derivative bundle' },
          { value: 'next_revision', label: 'Next revision of this derivative', disabled: !review.next_revision_allowed },
        ]} />
        {!review.next_revision_allowed && <Text size="xs">{review.baseline.role === 'original' ? 'Originals are never revised by edits.' : 'Only the current head of a derivative can receive the next revision.'}</Text>}
        {target === 'new_derivative' && <TextInput label="Derivative bundle name" value={name} disabled={busy} onChange={event => setName(event.currentTarget.value)} />}
        <Textarea label="Change summary" description="Recorded with the reviewed change set." value={summary} maxLength={2000} disabled={busy} onChange={event => setSummary(event.currentTarget.value)} />
        <Button disabled={busy || dirty || !!stale || !target || !review.ready || !summary.trim() || (target === 'new_derivative' && !name.trim())} onClick={() => void submit()}>Submit reviewed derivative</Button>
      </Stack>}
    </Stack>}
  </Stack></Card>;
}

export function EditProvenanceCard({ detail }: { detail: RevisionDetail }) {
  const edit = detail.edit_submission;
  if (!edit) return null;
  return <Card withBorder><Text fw={600}>Edit re-entry provenance</Text>
    <Text>Baseline <span className="sb-mono">r{edit.baseline_number}</span> <ExactPins pins={[{ label: 'Baseline revision ID', value: edit.baseline_revision_id }]} /></Text>
    <Text size="sm">Baseline manifest SHA-256: {edit.baseline_manifest_sha256}</Text>
    <Text>Submitted as: {edit.target === 'next_revision' ? 'next revision of the derivative' : 'separate derivative'}</Text>
    {edit.source.kind === 'zip' ? <Text size="sm">Edited archive: {edit.source.path} · <ExactPins pins={[{ label: 'Edited archive revision ID', value: edit.source.revision_id }]} /> · SHA-256 {edit.source.sha256} · parser {edit.source.parser}</Text> : <Text size="sm">Edited files registered individually</Text>}
    <Text size="sm">Handoff marker: {edit.marker}{edit.root_prefix ? ` · root folder ${edit.root_prefix}/` : ''}</Text>
    <Text size="sm">Review SHA-256: {edit.review_sha256}</Text>
    <Text>Summary: {edit.summary}</Text>
    <Text size="sm">Execution: none · Native validation: not performed</Text>
  </Card>;
}
