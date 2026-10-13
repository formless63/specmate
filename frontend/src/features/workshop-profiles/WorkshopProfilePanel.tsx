import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Group, NumberInput, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import type { GroupElement, StockElement, StockSpecification } from '../../../../packages/section-layout/src';
import {
  freezeProfile, listProfileRevisions, listProfiles, listStocks, readProfileRevision,
  readStockRevision, saveProfile,
} from './api';
import type { Basis, ElementPractice, EndPractice, LeadDisplay, ProfileRecord,
  ProfileRevision, Source, StockChoice, Suggestion, WorkshopProfile } from './api';

const unknown = <T,>(): Suggestion<T> => ({ value: null, basis: 'unknown', source: null, note: null });
const blankEnd = (): EndPractice => ({ cutback_mm: unknown(), prepend_cut_mm: unknown(), lead: null });
const blankRule = (): ElementPractice => ({ a: blankEnd(), b: blankEnd() });
const blankLead = (): LeadDisplay => ({ length_mm: unknown(), diameter_mm: unknown(), reach_mm: unknown(), angle_deg: unknown() });
const blankProfile = (revisionId: string): WorkshopProfile => ({
  schema_version: '1', stock_revision_id: revisionId, foil_visibility: unknown(),
  illustration_lay_length_mm: unknown(), omit_occluded: unknown(), element_rules: {}, hidden_element_paths: [],
});
const copy = <T,>(value: T): T => structuredClone(value);

function paths(node: StockElement, prefix = ''): string[] {
  const path = prefix ? `${prefix}.${node.id}` : node.id;
  return [path, ...(node.kind === 'group' ? node.children.flatMap(child => paths(child, path)) : [])];
}

export function WorkshopProfilePanel({ projectId }: { projectId?: string }) {
  const [stocks, setStocks] = useState<StockChoice[]>([]);
  const [profiles, setProfiles] = useState<ProfileRecord[]>([]);
  const [revisions, setRevisions] = useState<ProfileRevision[]>([]);
  const [current, setCurrent] = useState<ProfileRecord | null>(null);
  const [frozen, setFrozen] = useState<ProfileRevision | null>(null);
  const [stock, setStock] = useState<StockSpecification | null>(null);
  const [profile, setProfile] = useState<WorkshopProfile | null>(null);
  const [name, setName] = useState('');
  const [basis, setBasis] = useState<Basis>('preference');
  const [note, setNote] = useState('');
  const [sourceRevision, setSourceRevision] = useState('');
  const [sourcePath, setSourcePath] = useState('');
  const [sourceSha256, setSourceSha256] = useState('');
  const [sourceRights, setSourceRights] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const shown = frozen?.content.profile ?? profile;
  const elementPaths = useMemo(() => stock ? paths(stock.structure as GroupElement).slice(1) : [], [stock]);

  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    Promise.all([listStocks(projectId), listProfiles(projectId)])
      .then(([stockRows, profileRows]) => { if (alive) { setStocks(stockRows); setProfiles(profileRows); } })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [projectId]);

  const source = (): Source | null => {
    if (basis !== 'documented') return null;
    return sourceRevision.trim() || sourcePath.trim() || sourceSha256.trim() || sourceRights.trim()
      ? { kind: 'source_file', bundle_revision_id: sourceRevision.trim(), path: sourcePath.trim(), locator: '',
          sha256: sourceSha256.trim(), rights: sourceRights.trim() }
      : note.trim() ? { kind: 'citation', citation: note.trim() } : null;
  };
  const suggestion = <T,>(value: T | null): Suggestion<T> => value === null ? unknown<T>() : {
    value, basis, source: source(), note: note.trim() || null,
  };
  const modify = (change: (next: WorkshopProfile) => void) => {
    if (!profile || frozen) return;
    const next = copy(profile); change(next); setProfile(next); setDirty(true); setMessage('');
  };
  const chooseStock = async (revisionId: string) => {
    setBusy(true); setError('');
    try {
      const exact = await readStockRevision(revisionId);
      setStock(exact); setProfile(blankProfile(revisionId));
      if (current?.content.profile) { setCurrent(null); setName(''); setRevisions([]); }
      setFrozen(null); setDirty(true); setMessage('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const chooseProfile = async (record: ProfileRecord) => {
    setBusy(true); setError('');
    try {
      const history = await listProfileRevisions(record.definition_id);
      const exact = record.content.profile
        ? await readStockRevision(record.content.profile.stock_revision_id) : null;
      setStock(exact); setProfile(record.content.profile ? copy(record.content.profile) : null);
      setCurrent(record); setFrozen(null);
      setRevisions(history); setName(record.name); setDirty(false); setMessage('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const setEnd = (path: string, end: 'a' | 'b', change: (target: EndPractice) => void) => modify(next => {
    const rule = next.element_rules[path] ?? blankRule(); change(rule[end]); next.element_rules[path] = rule;
  });
  const save = async () => {
    if (!projectId || !profile || !name.trim() || frozen) return;
    setBusy(true); setError('');
    try {
      const result = await saveProfile(projectId, name.trim(), profile, current);
      const row = { ...result, name: result.name ?? name.trim() };
      setCurrent(row); setProfiles(items => [...items.filter(item => item.draft_id !== row.draft_id), row]);
      setProfile(copy(row.content.profile ?? profile)); setDirty(false); setMessage(`Saved ${row.name} (${row.state}).`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const freeze = async () => {
    if (!current || dirty) return;
    setBusy(true); setError('');
    try {
      const result = await freezeProfile(current);
      const updated = { ...current, state: result.draft.state, base_revision_id: result.revision_id };
      setCurrent(updated); setProfiles(items => items.map(item => item.draft_id === updated.draft_id ? updated : item));
      setRevisions(await listProfileRevisions(current.definition_id));
      setMessage(`Frozen profile revision ${result.number} (${result.revision_id}).`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return <Stack>
    <Title order={2}>Workshop profiles</Title>
    <Text>Preparation and illustration suggestions are versioned separately from stock construction. A visual pigtail does not establish an electrical bond.</Text>
    {error && <Alert color="red" role="alert">{error}</Alert>}
    {message && <Alert color="green">{message}</Alert>}
    <Group align="end">
      <Select label="Start from frozen stock" placeholder="Select an exact stock revision" disabled={busy}
        data={stocks.filter(row => row.base_revision_id).map(row => ({ value: row.base_revision_id!, label: `${row.name} · ${row.base_revision_id}` }))}
        value={current?.content.profile ? null : profile?.stock_revision_id ?? null} onChange={id => { if (id) void chooseStock(id); }} />
      <Select label="Saved profile" data={profiles.map(row => ({ value: row.draft_id, label: row.name }))}
        value={current?.draft_id ?? null} onChange={id => { const row = profiles.find(item => item.draft_id === id); if (row) void chooseProfile(row); }} />
      <TextInput label="Profile name" value={name} disabled={!!current || !!frozen} onChange={event => setName(event.target.value)} />
    </Group>
    {current && <Group>
      <Select label="Frozen profile revision" placeholder="View an exact revision" clearable
        data={revisions.map(row => ({ value: row.revision_id, label: `Revision ${row.number} · ${row.revision_id}` }))}
        value={frozen?.revision_id ?? null} onChange={async id => {
          if (!id) {
            setFrozen(null);
            if (profile) {
              try { setStock(await readStockRevision(profile.stock_revision_id)); }
              catch (e) { setError(e instanceof Error ? e.message : String(e)); }
            }
            return;
          }
          setBusy(true); setError('');
          try {
            const selected = await readProfileRevision(id);
            setStock(await readStockRevision(selected.content.profile.stock_revision_id));
            setFrozen(selected);
          }
          catch (e) { setError(e instanceof Error ? e.message : String(e)); }
          finally { setBusy(false); }
        }} />
      {frozen && <Text>Viewing immutable revision {frozen.number}. Select the draft to edit current suggestions.</Text>}
    </Group>}
    {shown && <>
      <Text size="sm">Stock revision: {shown.stock_revision_id}. Unknown values remain unknown; shown lengths are illustration suggestions, not measured dimensions.</Text>
      <Group align="end">
        <Select label="Basis for new edits" value={basis} data={[
          { value: 'preference', label: 'Workshop preference' }, { value: 'documented', label: 'Documented' },
          { value: 'inferred', label: 'Inferred' },
        ]} onChange={value => { if (value) setBasis(value as Basis); }} />
        <TextInput label="Basis note or citation" value={note} onChange={event => setNote(event.target.value)}
          placeholder="Describe where this suggestion comes from" />
        {basis === 'documented' && <>
          <TextInput label="Source bundle revision ID (optional)" value={sourceRevision} onChange={event => setSourceRevision(event.target.value)} />
          <TextInput label="Source file path" value={sourcePath} onChange={event => setSourcePath(event.target.value)} />
          <TextInput label="Registered source SHA-256" value={sourceSha256} onChange={event => setSourceSha256(event.target.value)} />
          <TextInput label="Registered source rights" value={sourceRights} onChange={event => setSourceRights(event.target.value)} />
        </>}
      </Group>
      <Group>
        <Select label="Foil visibility" value={shown.foil_visibility.value ?? 'unknown'} disabled={!!frozen}
          data={['unknown', 'show', 'hide']} onChange={value => modify(next => {
            next.foil_visibility = suggestion(value === 'unknown' ? null : value as 'show' | 'hide');
          })} />
        <NumberInput label="Illustration lay length mm" value={shown.illustration_lay_length_mm.value ?? ''}
          disabled={!!frozen} min={0} onChange={value => modify(next => {
            next.illustration_lay_length_mm = suggestion(typeof value === 'number' ? value : null);
          })} />
        <Select label="Omit occluded material" value={shown.omit_occluded.value === null ? 'unknown' : String(shown.omit_occluded.value)}
          disabled={!!frozen} data={['unknown', 'true', 'false']} onChange={value => modify(next => {
            next.omit_occluded = suggestion(value === 'unknown' ? null : value === 'true');
          })} />
      </Group>
      <Title order={3}>Element preparation</Title>
      <Text size="sm">Cuts and lead dimensions are per stock element and per end. A blank field means unknown.</Text>
      {elementPaths.map(path => {
        const rule = shown.element_rules[path] ?? blankRule();
        return <Stack key={path} gap="xs" style={{ borderLeft: '2px solid #aaa', paddingLeft: 12 }}>
          <Group><Text fw={600}>{path}</Text><Checkbox label={`Hide ${path} in illustration`}
            checked={shown.hidden_element_paths.includes(path)} disabled={!!frozen}
            onChange={event => modify(next => {
              next.hidden_element_paths = event.currentTarget.checked
                ? [...next.hidden_element_paths, path] : next.hidden_element_paths.filter(item => item !== path);
            })} /></Group>
          {(['a', 'b'] as const).map(end => <Group key={end} align="end">
            <Text fw={500}>End {end.toUpperCase()}</Text>
            <NumberInput label={`${path} end ${end} cutback mm`} value={rule[end].cutback_mm.value ?? ''} min={0}
              disabled={!!frozen} onChange={value => setEnd(path, end, target => {
                target.cutback_mm = suggestion(typeof value === 'number' ? value : null);
              })} />
            <NumberInput label={`${path} end ${end} prepend cut mm`} value={rule[end].prepend_cut_mm.value ?? ''} min={0}
              disabled={!!frozen} onChange={value => setEnd(path, end, target => {
                target.prepend_cut_mm = suggestion(typeof value === 'number' ? value : null);
              })} />
            <Checkbox label={`${path} end ${end} illustrated lead`} checked={rule[end].lead !== null} disabled={!!frozen}
              onChange={event => setEnd(path, end, target => { target.lead = event.currentTarget.checked ? blankLead() : null; })} />
            {rule[end].lead && <>
              <NumberInput label={`${path} end ${end} lead extent mm`} value={rule[end].lead.length_mm.value ?? ''} min={0} disabled={!!frozen}
                onChange={value => setEnd(path, end, target => { target.lead!.length_mm = suggestion(typeof value === 'number' ? value : null); })} />
              <NumberInput label={`${path} end ${end} lead diameter mm`} value={rule[end].lead.diameter_mm.value ?? ''} min={0} disabled={!!frozen}
                onChange={value => setEnd(path, end, target => { target.lead!.diameter_mm = suggestion(typeof value === 'number' ? value : null); })} />
              <NumberInput label={`${path} end ${end} lead reach mm`} value={rule[end].lead.reach_mm.value ?? ''} min={0} disabled={!!frozen}
                onChange={value => setEnd(path, end, target => { target.lead!.reach_mm = suggestion(typeof value === 'number' ? value : null); })} />
              <NumberInput label={`${path} end ${end} lead angle deg`} value={rule[end].lead.angle_deg.value ?? ''} min={-360} max={360} disabled={!!frozen}
                onChange={value => setEnd(path, end, target => { target.lead!.angle_deg = suggestion(typeof value === 'number' ? value : null); })} />
            </>}
          </Group>)}
        </Stack>;
      })}
      <Group><Button onClick={() => void save()} loading={busy} disabled={!!frozen || !projectId || !profile || !name.trim() || !dirty}>Save profile</Button>
        <Button variant="light" onClick={() => void freeze()} disabled={!current || dirty || !!frozen || busy}>Freeze profile</Button></Group>
      {dirty && <Text size="sm">Unsaved profile suggestions. Save before freezing.</Text>}
    </>}
    {!shown && <Text>Select a frozen stock revision to prepare a profile.</Text>}
  </Stack>;
}
