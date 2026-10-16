import type { Assignment, Cable } from '../cables/api';
import type { Proposal } from '../intent-propose/ProposeWiring';

const key = (value: Assignment) => `${value.endpoint_id}\u0000${value.element_path}`;
const endpointMap = (current: Cable | null, proposal: Proposal) => new Map(proposal.cable.endpoints.map((end, index) => [end.local_id, current?.endpoints[index]?.local_id ?? end.local_id]));
const same = (a: Assignment, b: Assignment) => a.endpoint_id === b.endpoint_id && a.element_path === b.element_path && a.layer_id === b.layer_id && a.terminal_id === b.terminal_id;
export function conflictingRows(current: Cable | null, proposal: Proposal): Set<string> {
  const existing = new Map(current?.assignments.map(value => [key(value), value]) ?? []), endpoints = endpointMap(current, proposal);
  return new Set(proposal.rows.filter(row => row.assignments.some(value => { const old = existing.get(key({ ...value, endpoint_id: endpoints.get(value.endpoint_id) ?? value.endpoint_id })); return old && !same(old, { ...value, endpoint_id: endpoints.get(value.endpoint_id) ?? value.endpoint_id }); })).map(row => row.row_id));
}
export function initialAcceptance(current: Cable | null, proposal: Proposal): Set<string> {
  const conflicts = conflictingRows(current, proposal);
  return new Set(proposal.rows.filter(row => row.status === 'proposed' && row.assignments.length && !conflicts.has(row.row_id)).map(row => row.row_id));
}
/** Existing landings and their reasons survive re-proposal unless explicitly replaced. */
export function applyRecipeProposal(current: Cable | null, proposal: Proposal, accepted: Set<string>, replacementReasons: Record<string, string> = {}): Cable {
  const conflicts = conflictingRows(current, proposal);
  const selected = proposal.rows.filter(row => accepted.has(row.row_id));
  if (selected.some(row => conflicts.has(row.row_id) && !replacementReasons[row.row_id]?.trim())) throw new Error('Record a reason before replacing an existing landing.');
  const existing = new Map(current?.assignments.map(value => [key(value), value]) ?? []);
  const endpoints = endpointMap(current, proposal);
  const proposed = selected.flatMap(row => row.assignments.map(({ terminal_label: _label, ...source }) => { const assignment = { ...source, endpoint_id: endpoints.get(source.endpoint_id) ?? source.endpoint_id }; const old = existing.get(key(assignment)); return old && same(old, assignment) ? old : { ...assignment, basis: conflicts.has(row.row_id) ? replacementReasons[row.row_id]!.trim() : assignment.basis }; }));
  const replaced = new Set(proposed.map(key));
  const value: Cable = current ? {
    ...current,
    stock_revision_id: proposal.cable.stock_revision_id,
    intent_revision_id: proposal.cable.intent_revision_id,
    endpoints: proposal.cable.endpoints.map((end, index) => ({ ...end, ...current.endpoints[index], end_assembly_revision_id: end.end_assembly_revision_id, stack: end.end_assembly_revision_id === current.endpoints[index]?.end_assembly_revision_id ? current.endpoints[index]!.stack : end.stack })),
    lengths: current.lengths && proposal.cable.lengths ? { ...current.lengths, finished: { ...current.lengths.finished, declaration: proposal.cable.lengths.finished.declaration } } : proposal.cable.lengths ?? current.lengths,
    review: 'unreviewed', review_basis: null,
  } : proposal.cable;
  return { ...value, assignments: [...(current?.assignments ?? []).filter(value => !replaced.has(key(value))), ...proposed] };
}
