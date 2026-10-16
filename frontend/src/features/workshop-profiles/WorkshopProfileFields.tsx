import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Checkbox, Group, NumberInput, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import type { GroupElement, StockElement, StockSpecification } from '../../../../packages/section-layout/src';
import type { Basis, ElementPractice, EndPractice, LeadDisplay, Source, Suggestion, WorkshopProfile } from './api';
import { requestJson } from '../workspace/api';
import { RevisionPicker } from '../cables/RevisionPicker';
import { WorkshopProfileProvenance } from './PracticeProvenance';
import { RevisionLabel } from '../../lib/IdentityLabel';
const unknown = <T,>(): Suggestion<T> => ({ value: null, basis: 'unknown', source: null, note: null });
const blankEnd = (): EndPractice => ({ cutback_mm: unknown(), prepend_cut_mm: unknown(), lead: null });
const blankRule = (): ElementPractice => ({ a: blankEnd(), b: blankEnd() });
const blankLead = (): LeadDisplay => ({ length_mm: unknown(), diameter_mm: unknown(), reach_mm: unknown(), angle_deg: unknown() });
export const blankProfile = (revisionId: string): WorkshopProfile => ({
  schema_version: '1', stock_revision_id: revisionId, foil_visibility: unknown(),
  illustration_lay_length_mm: unknown(), illustration_lay_direction: unknown(), omit_occluded: unknown(), element_rules: {}, hidden_element_paths: [],
});
const copy = <T,>(value: T): T => structuredClone(value);

function paths(node: StockElement, prefix = ''): string[] {
  const path = prefix ? `${prefix}.${node.id}` : node.id;
  return [path, ...(node.kind === 'group' ? node.children.flatMap(child => paths(child, path)) : [])];
}

/** The record owns identity, saving and exact revisions; these are local suggestion fields. */
export function WorkshopProfileFields({ profile, onChange, editable, active, stateLabel }: { profile: WorkshopProfile; onChange: (value: WorkshopProfile) => void; editable: boolean; active: boolean; stateLabel: string }) {
  const [basis, setBasis] = useState<Basis>('preference');
  const [note, setNote] = useState('');
  const [sourceRevision, setSourceRevision] = useState('');
  const [sourcePath, setSourcePath] = useState('');
  const [sourceSha256, setSourceSha256] = useState('');
  const [sourceRights, setSourceRights] = useState('');
  const stock = useQuery({ queryKey: ['profile-field-stock', profile.stock_revision_id], enabled: active && !!profile.stock_revision_id, retry: false,
    queryFn: () => requestJson<{content: {stock: StockSpecification}}>(`/api/v0/revisions/${encodeURIComponent(profile.stock_revision_id)}/snapshot`, { cache: 'no-store' }) });
  const shown = profile;
  const elementPaths = useMemo(() => stock.data && !stock.isError && !stock.isFetching ? paths(stock.data.content.stock.structure as GroupElement).slice(1) : [], [stock.data, stock.isError, stock.isFetching]);
  const source = (): Source | null => {
    if (basis !== 'documented') return null;
    return sourceRevision || sourcePath || sourceSha256 || sourceRights
      ? { kind: 'source_file', bundle_revision_id: sourceRevision.trim(), path: sourcePath, locator: '',
          sha256: sourceSha256, rights: sourceRights }
      : note.trim() ? { kind: 'citation', citation: note.trim() } : null;
  };
  const suggestion = <T,>(value: T | null): Suggestion<T> => value === null ? unknown<T>() : {
    value, basis, source: source(), note: note.trim() || null,
  };
  const modify = (change: (next: WorkshopProfile) => void) => {
    if (!editable) return;
    const next = copy(profile); change(next); onChange(next);
  };
  const setEnd = (path: string, end: 'a' | 'b', change: (target: EndPractice) => void) => modify(next => {
    const rule = next.element_rules[path] ?? blankRule(); change(rule[end]); next.element_rules[path] = rule;
  });
  return <Stack>
    <Text>Preparation and illustration suggestions are versioned separately from stock construction. A visual pigtail does not establish an electrical bond.</Text>
    {editable && <RevisionPicker label="Stock" kind="wire_stock" value={profile.stock_revision_id} onChange={id => {
      if (id === profile.stock_revision_id) return;
      if (profile.stock_revision_id && (Object.keys(profile.element_rules).length || profile.hidden_element_paths.length) && !window.confirm('Changing stock clears the element-specific suggestions. Continue?')) return;
      onChange({ ...profile, stock_revision_id: id, element_rules: {}, hidden_element_paths: [] });
    }} />}
    {stock.isError && <Alert color="red">{stock.error.message}</Alert>}
      <Text size="sm"><RevisionLabel id={shown.stock_revision_id} role="Stock" />. Unknown values remain unknown; shown lengths are illustration suggestions, not measured dimensions.</Text>
      <WorkshopProfileProvenance profile={shown} stateLabel={stateLabel} />
      {editable && <>
      <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}>
      <Title order={3}>Author new suggestions</Title>
      <Text size="sm">The basis fields below apply only when you change a value. Recorded practice details above show what is already stored.</Text>
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
      </fieldset>
      </>}
      <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}>
      <Group>
        <Select label="Foil visibility" value={shown.foil_visibility.value ?? 'unknown'} disabled={!editable}
          data={['unknown', 'show', 'hide']} onChange={value => modify(next => {
            next.foil_visibility = suggestion(value === 'unknown' ? null : value as 'show' | 'hide');
          })} />
        <NumberInput label="Illustration lay length mm" value={shown.illustration_lay_length_mm.value ?? ''}
          disabled={!editable} min={0} onChange={value => modify(next => {
            next.illustration_lay_length_mm = suggestion(typeof value === 'number' ? value : null);
          })} />
        <Select label="Illustration lay direction" value={shown.illustration_lay_direction?.value ?? 'unknown'} disabled={!editable}
          data={['unknown', 'positive', 'negative']} onChange={value => modify(next => {
            next.illustration_lay_direction = suggestion(value === 'unknown' ? null : value as 'positive' | 'negative');
          })} />
        <Select label="Omit occluded material" value={shown.omit_occluded.value === null ? 'unknown' : String(shown.omit_occluded.value)}
          disabled={!editable} data={['unknown', 'true', 'false']} onChange={value => modify(next => {
            next.omit_occluded = suggestion(value === 'unknown' ? null : value === 'true');
          })} />
      </Group>
      <Text size="sm">Illustration direction is rotation about +x as x increases, with zero phase at end A. Positive follows the right-hand rule; negative reverses it. This preference does not state engineering twist handedness.</Text>
      <Title order={3}>Element preparation</Title>
      <Text size="sm">Cuts and lead dimensions are per stock element and per end. A blank field means unknown.</Text>
      {elementPaths.map(path => {
        const rule = shown.element_rules[path] ?? blankRule();
        return <Stack key={path} gap="xs" style={{ borderLeft: '2px solid #aaa', paddingLeft: 12 }}>
          <Group><Text fw={600}>{path}</Text><Checkbox label={`Hide ${path} in illustration`}
            checked={shown.hidden_element_paths.includes(path)} disabled={!editable}
            onChange={event => modify(next => {
              next.hidden_element_paths = event.currentTarget.checked
                ? [...next.hidden_element_paths, path] : next.hidden_element_paths.filter(item => item !== path);
            })} /></Group>
          {(['a', 'b'] as const).map(end => <Group key={end} align="end">
            <Text fw={500}>End {end.toUpperCase()}</Text>
            <NumberInput label={`${path} end ${end} cutback mm`} value={rule[end].cutback_mm.value ?? ''} min={0}
              disabled={!editable} onChange={value => setEnd(path, end, target => {
                target.cutback_mm = suggestion(typeof value === 'number' ? value : null);
              })} />
            <NumberInput label={`${path} end ${end} prepend cut mm`} value={rule[end].prepend_cut_mm.value ?? ''} min={0}
              disabled={!editable} onChange={value => setEnd(path, end, target => {
                target.prepend_cut_mm = suggestion(typeof value === 'number' ? value : null);
              })} />
            <Checkbox label={`${path} end ${end} illustrated lead`} checked={rule[end].lead !== null} disabled={!editable}
              onChange={event => setEnd(path, end, target => { target.lead = event.currentTarget.checked ? blankLead() : null; })} />
            {rule[end].lead && <>
              <NumberInput label={`${path} end ${end} lead extent mm`} value={rule[end].lead.length_mm.value ?? ''} min={0} disabled={!editable}
                onChange={value => setEnd(path, end, target => { target.lead!.length_mm = suggestion(typeof value === 'number' ? value : null); })} />
              <NumberInput label={`${path} end ${end} lead diameter mm`} value={rule[end].lead.diameter_mm.value ?? ''} min={0} disabled={!editable}
                onChange={value => setEnd(path, end, target => { target.lead!.diameter_mm = suggestion(typeof value === 'number' ? value : null); })} />
              <NumberInput label={`${path} end ${end} lead reach mm`} value={rule[end].lead.reach_mm.value ?? ''} min={0} disabled={!editable}
                onChange={value => setEnd(path, end, target => { target.lead!.reach_mm = suggestion(typeof value === 'number' ? value : null); })} />
              <NumberInput label={`${path} end ${end} lead angle deg`} value={rule[end].lead.angle_deg.value ?? ''} min={-360} max={360} disabled={!editable}
                onChange={value => setEnd(path, end, target => { target.lead!.angle_deg = suggestion(typeof value === 'number' ? value : null); })} />
            </>}
          </Group>)}
        </Stack>;
      })}
      </fieldset>
  </Stack>;
}
