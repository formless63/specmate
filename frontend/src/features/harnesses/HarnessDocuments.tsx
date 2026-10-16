import { useMemo } from 'react';
import { Stack, Text } from '@mantine/core';
import { formboardLayout, renderFormboardSvg, planFormboardPrint, renderPrintHtml, DEFAULT_PRINT_SETTINGS, type StockMap } from '../../../../packages/harness-views/src';
import { sectionLayout } from '../../../../packages/section-layout/src';
import { sheetHtml, type Sheet } from '../../../../packages/docs/src/model';
import { RootDocuments } from '../../components/editor/Documents';
import { RecordSections } from '../../components/record';
import { PrintOutput } from '../harness-views/PrintOutput';
import type { HarnessCanvasData } from './canvas-model';
import type { Harness } from './api';
export function HarnessDocuments({ value, data, name, definitionId, draftId, revisionId, active, principalKey, workspaceId, authorize }: { value: Harness; data: HarnessCanvasData; name: string; definitionId: string | null; draftId: string | null; revisionId: string | null; active: boolean; principalKey: string; workspaceId: string; authorize: () => Promise<void> }) {
  const product = value.schema_version === '0.3' ? 'cable' : 'harness';
  const stocks = useMemo<StockMap>(() => Object.fromEntries(Object.entries(data.stocks).map(([id, stock]) => [id, { name: 'Exact stock', section: sectionLayout(stock) }])), [data.stocks]);
  const board = useMemo(() => formboardLayout(value, stocks), [value, stocks]);
  const draft: Sheet = { name, state: `Working ${product}`, unreleased: true, identity: draftId ?? `Unsaved ${product}`, tables: [{ name: 'Cuts', headers: ['Physical section', 'Exact stock revision', 'Planned cut (mm)', 'Basis'], rows: value.sections.map(section => [section.local_id, section.stock_revision_id || null, section.planned_cut_length_mm, section.cut_basis]) }, { name: 'Landings', headers: ['Joint', 'Kind', 'Members', 'Basis'], rows: value.joints.map(joint => [joint.local_id, joint.kind, joint.members.map(member => member.kind === 'segment' ? `${member.segment_id}/${member.end}/${member.element_path}` : `${member.endpoint_id}/${member.layer_id}/${member.terminal_id}`).join(' ↔ '), joint.basis]) }], labels: [], notices: ['UNRELEASED working declaration; continuity, fit and physical qualification are not evaluated.'] };
  return <Stack gap="xs"><RootDocuments active={active} name={name} snapshot={{ definitionId: definitionId ?? 'new-harness', revisionId, draftId }} principalKey={principalKey} workspaceId={workspaceId} authorizeWorking={authorize} draftSheet={draft} formboard={sheet => sheet.unreleased ? sheetHtml(sheet, [], renderFormboardSvg(board, `${name} formboard`)) : renderPrintHtml(planFormboardPrint(board, name, { ...DEFAULT_PRINT_SETTINGS, mode: 'fit' }))} />
    {revisionId ? <RecordSections sections={[{ id: 'scale', label: 'Full-scale formboard and labels · print settings', content: () => <PrintOutput revisionId={revisionId} harness={value} stocks={stocks} name={name} /> }]} /> : <Text size="xs">Working Formboard prints as UNRELEASED. Full-scale print and labels require an exact frozen revision with known dimensions.</Text>}
  </Stack>;
}
