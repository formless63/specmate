import { expect, test } from 'vitest';
import { cable } from '../cable-workbench/fixtures';
import type { Proposal } from '../intent-propose/ProposeWiring';
import { applyRecipeProposal, initialAcceptance } from './proposal';
const current = cable();
const old = { endpoint_id: 'a', element_path: 'stock.core', layer_id: 'connector', terminal_id: '1', basis: 'Reviewed hand routing reason' };
const proposed = (terminal = '2'): Proposal => ({ cable: { ...current, stock_revision_id: 'new-stock', assignments: [] }, rows: [{ row_id: 'signal1', requirement: 'required', status: 'proposed', conductor: 'stock.core', reason: 'Exact intent row', questions: [], assignments: [{ ...old, terminal_id: terminal, basis: 'Proposer reason', terminal_label: 'Contact '+terminal }] }], intent_revision_id: 'intent', questions: [], existing_needs: [], check: { rows: [] }, diff: null, status: 'proposed', review: 'required' } as unknown as Proposal);
test('changing stock re-proposes without discarding hand landings or their original reasons', () => {
  const local = { ...current, assignments: [old] }, candidate = proposed();
  const accepted = initialAcceptance(local, candidate); expect(accepted.size).toBe(0);
  const next = applyRecipeProposal(local, candidate, accepted); expect(next.stock_revision_id).toBe('new-stock'); expect(next.assignments).toEqual([old]); expect(local.assignments).toEqual([old]);
});
test('replacing a hand landing requires explicit row acceptance and a recorded reason', () => {
  const local = { ...current, assignments: [old] }, candidate = proposed();
  expect(() => applyRecipeProposal(local, candidate, new Set(['signal1']))).toThrow(/reason/);
  const next = applyRecipeProposal(local, candidate, new Set(['signal1']), { signal1: 'Reviewed corrected terminal' }); expect(next.assignments).toEqual([{ ...old, terminal_id: '2', basis: 'Reviewed corrected terminal' }]);
});
test('unchanged proposed landings preserve richer existing hand reasons, and unknown questions are not auto-accepted', () => {
  const local = { ...current, assignments: [old] }, candidate = proposed('1');
  expect(applyRecipeProposal(local, candidate, initialAcceptance(local, candidate)).assignments).toEqual([old]);
  candidate.rows[0]!.status = 'question'; expect(initialAcceptance(null, candidate).size).toBe(0);
});

test('stock-only re-proposal preserves authored endpoint identity, labels, stock ends and non-recipe length fields', () => {
  const local = structuredClone(current); local.endpoints[0]!.local_id = 'prepared-end'; local.endpoints[0]!.label = 'Prepared end label'; local.endpoints[0]!.stock_end = 'b';
  local.lengths = { route: { amount_mm: '125', basis: 'human_declaration', explanation: 'Prepared route' }, finished: { declaration: {amount_mm: '130', basis: 'human_declaration', explanation:'Prepared finish'}, model: null }, stock_cut: { declaration: {amount_mm:'150',basis:'human_declaration',explanation:'Prepared cut'}, model:null }, conductor_cuts: [{element_path:'stock.core',declaration:{amount_mm:'155',basis:'human_declaration',explanation:'Hand cut'},model:null}] };
  local.assignments = [{...old,endpoint_id:'prepared-end'}]; const candidate = proposed('1'); candidate.cable.lengths = structuredClone(local.lengths); candidate.cable.lengths.finished.declaration.amount_mm = '140';
  const next = applyRecipeProposal(local,candidate,initialAcceptance(local,candidate)); expect(next.stock_revision_id).toBe('new-stock'); expect(next.endpoints[0]).toEqual(local.endpoints[0]); expect(next.assignments).toEqual(local.assignments); expect(next.lengths!.route).toEqual(local.lengths.route); expect(next.lengths!.stock_cut).toEqual(local.lengths.stock_cut); expect(next.lengths!.conductor_cuts).toEqual(local.lengths.conductor_cuts); expect(next.lengths!.finished.declaration.amount_mm).toBe('140');
});
