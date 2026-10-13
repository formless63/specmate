import { Component, lazy, Suspense, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Checkbox, Group, NumberInput, Select, Stack, Text, Title } from '@mantine/core';
import type { Section } from '../../../../packages/section-layout/src';
import { unpreparedProfile, wireModel } from '../../../../packages/wire-geometry/src/model';
import type { DisplayProfile, ElementPreparation, End, LeadDisplay } from '../../../../packages/wire-geometry/src/model';

// The Three.js dependency enters the browser only after an explicit open action.
const WireViewport = lazy(() => import('./WireViewport'));
class ViewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <Alert color="yellow">The 3D viewer could not load. Close and reopen to retry; the section remains available.</Alert> : this.props.children; }
}
export function WirePreparationPreview({ section, lengthMm }: { section: Section; lengthMm: number }) {
  const [profile, setProfile] = useState<DisplayProfile>(unpreparedProfile);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const path = section.rows.some(r => r.path === selected) ? selected! : section.rows[0]?.path;
  const row = section.rows.find(r => r.path === path);
  const cut = (path && profile.cuts[path]) || { a: 0, b: 0 };
  const model = useMemo(() => wireModel(section, lengthMm, profile), [section, lengthMm, profile]);
  const change = (patch: Partial<DisplayProfile>) => setProfile(p => ({ ...p, ...patch, id: 'local-preview', label: 'Local explicit preview profile' }));
  const editCut = (patch: Partial<ElementPreparation>) => path && change({ cuts: { ...profile.cuts, [path]: { ...cut, ...patch } } });
  const editLead = (end: End, patch: Partial<LeadDisplay>) => editCut({ leads: { ...cut.leads, [end]: { ...cut.leads?.[end]!, ...patch } } });
  const value = (v: string | number) => typeof v === 'number' ? v : null;
  return <Stack>
    <Title order={3}>Layered preparation preview</Title>
    <Text>Profile: {profile.label}. Cuts, lead dimensions and hidden elements apply only to this local illustration. They are not saved stock facts, a versioned preparation record, or electrical bonds.</Text>
    <Group><Button variant="light" onClick={() => setOpen(v => !v)}>{open ? 'Close 3D preview' : 'Open 3D preview'}</Button>
      <Button variant="subtle" onClick={() => setProfile(unpreparedProfile())}>Reset preview profile</Button>
      <Checkbox label="Omit occluded interiors" checked={profile.omitOccluded} onChange={e => change({ omitOccluded: e.currentTarget.checked })} />
    </Group>
    <Select label="Preview element" data={section.rows.map(r => ({ value: r.path, label: r.path }))} value={path ?? null} onChange={setSelected} />
    {path && <>
      <Checkbox label="Hide selected element in preview" checked={profile.hiddenPaths.includes(path)} onChange={e => change({ hiddenPaths: e.currentTarget.checked ? [...profile.hiddenPaths, path] : profile.hiddenPaths.filter(p => p !== path) })} />
      <Group>{(['a', 'b'] as const).map(end => <NumberInput key={end} label={`End ${end.toUpperCase()} cut mm`} min={0} max={lengthMm} value={cut[end] ?? ''} placeholder="Unknown" onChange={v => editCut({ [end]: value(v) })} />)}</Group>
      {(row?.kind === 'shield' || row?.kind === 'drain') && (['a', 'b'] as const).map(end => <Stack key={end} gap="xs">
        <Checkbox label={`Illustrative lead at end ${end.toUpperCase()}`} checked={!!cut.leads?.[end]} onChange={e => {
          const leads = { ...cut.leads };
          if (e.currentTarget.checked) leads[end] = { lengthMm: null, diameterMm: null, reachMm: 2, angleDeg: end === 'a' ? 0 : 180 };
          else delete leads[end];
          editCut({ leads });
        }} />
        {cut.leads?.[end] && <Group>
          <NumberInput label={`Lead ${end.toUpperCase()} axial reach mm`} min={0} value={cut.leads[end]!.lengthMm ?? ''} placeholder="Unknown" onChange={v => editLead(end, { lengthMm: value(v) })} />
          <NumberInput label={`Lead ${end.toUpperCase()} display diameter mm`} min={0} step={0.1} value={cut.leads[end]!.diameterMm ?? ''} placeholder="Unknown" onChange={v => editLead(end, { diameterMm: value(v) })} />
          <NumberInput label={`Lead ${end.toUpperCase()} radial reach mm`} min={0} value={cut.leads[end]!.reachMm} onChange={v => typeof v === 'number' && editLead(end, { reachMm: v })} />
          <NumberInput label={`Lead ${end.toUpperCase()} angle degrees`} value={cut.leads[end]!.angleDeg} onChange={v => typeof v === 'number' && editLead(end, { angleDeg: v })} />
        </Group>}
      </Stack>)}
    </>}
    {model.unknown.length > 0 && <Alert color="yellow">Preview incomplete: {model.unknown.join('; ')}</Alert>}
    <Text size="sm">{model.pieces.length} displayed pieces from {section.rows.length} material elements. Mesh counts are not stock quantities.</Text>
    {model.omitted.map(item => <Text size="xs" key={`${item.path}:${item.reason}`}>{item.path}: {item.reason}</Text>)}
    {open && <ViewBoundary><Suspense fallback={<Text>Loading 3D viewer…</Text>}><WireViewport model={model} /></Suspense></ViewBoundary>}
  </Stack>;
}
