import { useMemo, useState } from 'react';
import { Alert, Group, SegmentedControl, Stack, Table, Text } from '@mantine/core';
import { formatExtent, renderSideViewSvg, sideViewLayout } from '../../../../packages/section-layout/src';
import type { Extent, PrepProfile, Section, SideMode } from '../../../../packages/section-layout/src';
import { SbUnknown } from '../../components/sb';
import { Swatch } from './Swatch';

/** `stockRevisionId`, when given, is the exact stock the profile is pinned to. */
export interface SidePreparation { profile: PrepProfile; label: string; stockRevisionId?: string }

const ExtentCell = ({ extent }: { extent: Extent }) => extent.status === 'unknown'
  ? <><SbUnknown /> <Text span size="xs">{extent.reason}</Text></>
  : <Text span size="sm">{formatExtent(extent)}</Text>;

/**
 * The stock lying along the page: every element at its real diameter and section height, each end
 * either as an illustrative cutaway or as prepared by an end preparation profile. Unknown extents are
 * hatched across the whole end; unknown diameters are listed, never drawn.
 */
export function SideView({ section, title, preparation, selected, onSelect }: {
  section: Section; title: string; preparation?: SidePreparation | null; selected?: string | null; onSelect?: (path: string | null) => void;
}) {
  const [chosen, setMode] = useState<SideMode | null>(null);
  const mode: SideMode = preparation ? chosen ?? 'prepared' : 'cutaway';
  const view = useMemo(() => sideViewLayout(section, mode === 'prepared' && preparation ? { mode, preparation: preparation.profile } : { mode: 'cutaway' }), [section, mode, preparation]);
  const svg = useMemo(() => renderSideViewSvg(view, `${title} side view`, { selected }), [view, title, selected]);
  const unknownEnds = view.bands.filter(b => b.a.status === 'unknown' || b.b.status === 'unknown');
  return <Stack gap="xs">
    <Group align="center" gap="sm">
      <SegmentedControl size="xs" value={mode} onChange={value => setMode(value as SideMode)} aria-label="Side view mode"
        data={[{ value: 'cutaway', label: 'Construction cutaway' }, { value: 'prepared', label: 'Prepared ends', disabled: !preparation }]} />
      <Text size="sm">{mode === 'cutaway'
        ? 'Diameters and heights are recorded geometry; the axial steps only separate the layers and are not preparation lengths.'
        : `Ends as prepared by ${preparation!.label}. Lengths are measured from each stock cut end; the length between the ends is omitted.`}</Text>
    </Group>
    {!preparation && <Text size="xs">No end preparation profile for this exact stock is selected, so prepared ends are not drawn.</Text>}
    <div aria-label="Cable side drawing" className="sb-viewer" style={{ color: 'var(--sb-text-primary)' }}
      onClick={event => { const hit = (event.target as Element).closest('[data-element]'); if (hit) onSelect?.(hit.getAttribute('data-element')); }}
      dangerouslySetInnerHTML={{ __html: svg }} />
    {view.notDrawn.length > 0 && <Alert color="yellow" title="Not drawn: section geometry unknown">{view.notDrawn.map(r => `${r.tag} ${r.path} (${r.reason})`).join('; ')}</Alert>}
    {mode === 'prepared' && unknownEnds.length > 0 && <Alert color="yellow" title="Preparation extent unknown">Hatched elements have no instruction that places their end on the cable axis. They are drawn across the whole end, not at a guessed length.</Alert>}
    <Table.ScrollContainer minWidth={560}><Table aria-label="Side view layers">
      <Table.Thead><Table.Tr><Table.Th>Tag</Table.Th><Table.Th>Element</Table.Th><Table.Th>End A</Table.Th><Table.Th>End B</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{view.bands.map(band => <Table.Tr key={band.path} aria-selected={selected === band.path}>
        <Table.Td>{band.tag}</Table.Td>
        <Table.Td><Swatch look={band.look} />{band.label} <Text span size="xs">({band.kind})</Text>{band.notes.map(note => <Text key={note} size="xs">{note}</Text>)}</Table.Td>
        <Table.Td><ExtentCell extent={band.a} /></Table.Td>
        <Table.Td><ExtentCell extent={band.b} /></Table.Td>
      </Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer>
    <Text size="xs">A side view is a display of the stock and its preparation. It does not establish fit, continuity, bonding or qualification.</Text>
  </Stack>;
}
