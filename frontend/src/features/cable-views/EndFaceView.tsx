import { useMemo, useState } from 'react';
import { Alert, Group, NumberInput, Stack, Table, Text } from '@mantine/core';
import { endFaceLayout, renderEndFaceSvg } from '../../../../packages/section-layout/src';
import type { Section, StockEnd } from '../../../../packages/section-layout/src';

const reading = (r: 'cw' | 'ccw') => r === 'cw' ? 'clockwise' : 'counter-clockwise';

/** One end of the stock, looking into the cut. `labels` may name what each element terminates on. */
export function EndFaceView({ section, end, labels = {}, selected }: { section: Section; end: StockEnd; labels?: Record<string, string>; selected?: string | null }) {
  const [rotation, setRotation] = useState(0);
  const result = useMemo(() => endFaceLayout(section, end, { rotationDeg: rotation }), [section, end, rotation]);
  if (result.status === 'unavailable') return <Alert color="yellow" title={`End ${end.toUpperCase()} face unavailable`}>{result.reason}</Alert>;
  const { face } = result;
  const svg = renderEndFaceSvg(face, `End ${end.toUpperCase()} face`, { selected });
  return <Stack gap="xs">
    <div aria-label={`End ${end.toUpperCase()} face drawing`} style={{ maxWidth: 360, color: 'var(--mantine-color-text)' }} dangerouslySetInnerHTML={{ __html: svg }} />
    <Group align="flex-end">
      <NumberInput label={`End ${end.toUpperCase()} rotation, degrees counter-clockwise`} value={rotation} min={-360} max={360} step={15} w={260}
        onChange={v => typeof v === 'number' && setRotation(v)} />
      <Text size="sm">{face.mirrored ? `Mirrored from the drawing, which is viewed from end ${face.viewedFrom.toUpperCase()}.` : 'As drawn: this is the end the construction was viewed from.'} Rotation is a viewing choice, not a stock fact.</Text>
    </Group>
    {face.ringReadings.map(r => <Text size="sm" key={r.path}>{r.path} reads {reading(r.atThisEnd)} at end {end.toUpperCase()}.</Text>)}
    {face.unplaced.length > 0 && <Alert color="yellow">Not placed (geometry incomplete): {face.unplaced.join(', ')}</Alert>}
    <Table aria-label={`End ${end.toUpperCase()} terminals`}><Table.Thead><Table.Tr><Table.Th>Tag</Table.Th><Table.Th>Element</Table.Th><Table.Th>Role</Table.Th><Table.Th>Terminates on</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{face.terminals.map(t => <Table.Tr key={t.path}><Table.Td>{t.tag}</Table.Td><Table.Td>{t.path}</Table.Td><Table.Td>{t.role}</Table.Td><Table.Td>{labels[t.path] ?? 'Not recorded'}</Table.Td></Table.Tr>)}</Table.Tbody></Table>
    <Text size="xs">An end face is a display of the cut section. It does not establish continuity, shield bonding or termination.</Text>
  </Stack>;
}
