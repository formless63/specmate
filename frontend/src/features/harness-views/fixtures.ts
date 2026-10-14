// Synthetic harness for formboard and build-sheet checks: one trunk, two legs and a shared-section leg.
import { sectionLayout } from '../../../../packages/section-layout/src';
import type { HarnessView, StockMap } from '../../../../packages/harness-views/src';
import { braidedCoax, shieldedPair } from '../cable-views/fixtures';

export const stocks = (): StockMap => ({
  'rev-pair': { name: 'Synthetic pair', section: sectionLayout(shieldedPair()) },
  'rev-coax': { name: 'Synthetic coax', section: sectionLayout(braidedCoax()) },
});
export const harness = (): HarnessView => ({
  review: 'reviewed', review_basis: 'synthetic check',
  sections: [
    { local_id: 'S1', stock_revision_id: 'rev-pair', planned_cut_length_mm: '500', cut_basis: 'declared', physical_ends: [{ local_id: 'PE1', label: 'Left', segment_ends: [{ segment_id: 'trunk', end: 'a' }], endpoint_id: 'EP1', basis: 'declared', review: 'reviewed' }] },
    { local_id: 'S2', stock_revision_id: 'rev-coax', planned_cut_length_mm: '250.5', cut_basis: 'declared', physical_ends: [{ local_id: 'PE2', label: 'Right', segment_ends: [{ segment_id: 'legA', end: 'b' }], endpoint_id: 'EP2', basis: 'declared', review: 'unreviewed' }] },
    { local_id: 'S3', stock_revision_id: 'rev-coax', planned_cut_length_mm: null, cut_basis: null },
  ],
  segments: [
    { local_id: 'trunk', section_id: 'S1', label: 'Trunk', element_paths: null },
    { local_id: 'legA', section_id: 'S2', label: 'Leg A', element_paths: null },
    { local_id: 'legB', section_id: 'S3', label: 'Leg B', element_paths: null },
    { local_id: 'tap', section_id: 'S1', label: 'Tap <b>', element_paths: ['stock.drain'] },
  ],
  endpoints: [
    { local_id: 'EP1', label: 'Header', body_revision_id: 'body-1', pinout_revision_id: 'pin-1' },
    { local_id: 'EP2', label: null, body_revision_id: 'body-2', pinout_revision_id: 'pin-2' },
  ],
  joints: [
    { local_id: 'J1', kind: 'termination', basis: 'declared', members: [{ kind: 'segment', segment_id: 'trunk', end: 'a', element_path: 'stock.pair.core-a.wire' }, { kind: 'endpoint', endpoint_id: 'EP1', contact_id: '10' }] },
    { local_id: 'J2', kind: 'termination', basis: 'declared', members: [{ kind: 'segment', segment_id: 'trunk', end: 'a', element_path: 'stock.pair.core-b.wire' }, { kind: 'endpoint', endpoint_id: 'EP1', contact_id: '2' }] },
    { local_id: 'J3', kind: 'shield_bond', basis: 'declared', members: [{ kind: 'segment', segment_id: 'trunk', end: 'a', element_path: 'stock.screen' }, { kind: 'segment', segment_id: 'legA', end: 'a', element_path: 'stock.braid' }] },
  ],
  breakouts: [
    { local_id: 'B1', trunk: { segment_id: 'trunk', end: 'b' }, legs: [{ segment_id: 'legA', end: 'a' }, { segment_id: 'legB', end: 'a' }], fates: [{ local_id: 'F1', kind: 'through' }] },
    { local_id: 'B2', trunk: { segment_id: 'trunk', end: 'b' }, legs: [{ segment_id: 'tap', end: 'a' }], fates: [] },
  ],
});
