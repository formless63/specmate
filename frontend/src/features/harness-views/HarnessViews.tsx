import { useMemo, useState } from 'react';
import { Alert, Button, Group, Stack, Table, Tabs, Text } from '@mantine/core';
import { useQueries } from '@tanstack/react-query';
import { buildSheetModel, formboardLayout, renderBuildSheetHtml, renderFormboardSvg } from '../../../../packages/harness-views/src';
import type { HarnessView, StockMap } from '../../../../packages/harness-views/src';
import { sectionLayout } from '../../../../packages/section-layout/src';
import { loadFrozenStock } from '../wire-stock/viewer-api';

function download(name: string, body: string, type: string): void {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  URL.revokeObjectURL(url);
}

/** Formboard drawing and bench build sheet of one frozen harness revision. Read only. */
export function HarnessViews({ revisionId, harness, quantity = 1, title }: { revisionId: string; harness: HarnessView; quantity?: number; title?: string }) {
  const stockIds = useMemo(() => [...new Set(harness.sections.map(s => s.stock_revision_id))].sort(), [harness]);
  const reads = useQueries({ queries: stockIds.map(id => ({ queryKey: ['cable-stock', id], queryFn: () => loadFrozenStock(id) })) });
  const failed = reads.find(r => r.isError);
  const loading = reads.some(r => r.isPending);
  const stocks: StockMap = useMemo(() => Object.fromEntries(stockIds.flatMap((id, i) => {
    const spec = reads[i]?.data;
    return spec ? [[id, { name: `Stock ${id}`, section: sectionLayout(spec) }]] : [];
  })), [stockIds, reads]);
  const [selected, setSelected] = useState<string | null>(null);
  const name = title ?? `Harness ${revisionId}`;
  const board = useMemo(() => formboardLayout(harness, stocks), [harness, stocks]);
  const svg = useMemo(() => renderFormboardSvg(board, `${name} formboard`, { selected }), [board, name, selected]);
  const model = useMemo(() => buildSheetModel({ title: name, revisionId, harness, stocks, quantity }), [name, revisionId, harness, stocks, quantity]);
  const html = useMemo(() => renderBuildSheetHtml(model, { formboardSvg: renderFormboardSvg(board, `${name} formboard`, { idPrefix: 'sheet' }) }), [model, board, name]);
  const bar = board.bars.find(b => b.sectionId === selected);
  if (harness.sections.length === 0) return <Text>No physical sections are declared, so there is nothing to draw.</Text>;
  return <Stack gap="xs" aria-label="Harness views">
    {failed && <Alert color="red">{failed.error instanceof Error ? failed.error.message : 'A stock could not be read.'} Colours and names for that stock are unknown.</Alert>}
    {loading && <Text role="status" size="sm">Reading exact stock revisions…</Text>}
    <Tabs defaultValue="formboard" keepMounted={false}>
      <Tabs.List><Tabs.Tab value="formboard">Formboard</Tabs.Tab><Tabs.Tab value="sheet">Build sheet</Tabs.Tab></Tabs.List>
      <Tabs.Panel value="formboard" pt="sm"><Stack gap="xs">
        <div aria-label="Formboard drawing" style={{ background: '#eef1f4', color: '#14181d', borderRadius: 6, padding: 8, overflowX: 'auto' }}
          onClick={event => { const hit = (event.target as Element).closest('[data-section]'); setSelected(hit ? hit.getAttribute('data-section') : null); }}
          dangerouslySetInnerHTML={{ __html: svg }} />
        {board.notes.map(n => <Alert key={n} color="yellow">{n}</Alert>)}
        {bar ? <Table aria-label="Selected section"><Table.Tbody>
          <Table.Tr><Table.Th>Section</Table.Th><Table.Td>{bar.sectionId}</Table.Td></Table.Tr>
          <Table.Tr><Table.Th>Stock</Table.Th><Table.Td>{bar.stockName}</Table.Td></Table.Tr>
          <Table.Tr><Table.Th>Planned cut</Table.Th><Table.Td>{bar.lengthKnown ? bar.lengthText : 'Unknown'}</Table.Td></Table.Tr>
          <Table.Tr><Table.Th>Spans</Table.Th><Table.Td>{bar.segments.join(', ') || 'None'}</Table.Td></Table.Tr>
        </Table.Tbody></Table> : <Text size="sm">Select a bar to see its section details.</Text>}
        <Text size="xs">Bars are at one length scale; thickness is exaggerated and proportional to outer diameter. Placement on the board is a drawing aid, not routing, bonding or fit.</Text>
      </Stack></Tabs.Panel>
      <Tabs.Panel value="sheet" pt="sm"><Stack gap="xs">
        <Group><Button variant="light" onClick={() => download(`build-sheet-${revisionId}.html`, html, 'text/html')}>Download build sheet (HTML)</Button></Group>
        <iframe title="Build sheet" sandbox="" srcDoc={html} style={{ width: '100%', height: 620, border: '1px solid var(--mantine-color-default-border)', background: '#fff' }} />
        <Text size="xs">The sheet is self-contained and prints one stage per page. Stages with no recorded data say so.</Text>
      </Stack></Tabs.Panel>
    </Tabs>
  </Stack>;
}
