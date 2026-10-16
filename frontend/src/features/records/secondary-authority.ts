import { authorizeWorkingPins, uniquePins, type WorkingPins } from '../boards/working-authority';
import { ApiError, requestJson } from '../workspace/api';
import { canonical, type Content, type PartRecord } from '../parts/api';
import type { Profile as Preparation } from '../preparation/api';
import type { Profile as EndPreparation } from '../end-preparation/api';
import type { Assertion, Comparison } from '../pcb-disagreement/api';
import type { Model } from '../passive-passages/api';
import type { Source } from '../workshop-profiles/api';

/** Only authored reference identities participate; incomplete semantic fields stay editable. */
export function secondaryPins(content: Content): WorkingPins {
  const pins: WorkingPins = { revisions: [], sources: [] };
  const source = (value: Source | null) => { if (value?.kind === 'source_file' && value.bundle_revision_id) pins.sources.push(value.bundle_revision_id); };
  const prep = content.preparation_profile as Preparation | undefined;
  if (prep) { if (prep.stock_revision_id) pins.revisions.push(prep.stock_revision_id); prep.formulas.forEach(formula => formula.allowances.forEach(row => source(row.source))); }
  const end = content.end_preparation_profile as EndPreparation | undefined;
  if (end) { if (end.stock_revision_id) pins.revisions.push(end.stock_revision_id); [end.a, end.b].forEach(side => side.instructions.forEach(row => { source(row.source); if (row.kind === 'bond_expectation' && row.target?.kind === 'endpoint_contact' && row.target.body_revision_id) pins.revisions.push(row.target.body_revision_id); })); }
  const assertion = content.pcb_assertion as Assertion | undefined;
  if (assertion?.source.source_revision_id) pins.sources.push(assertion.source.source_revision_id);
  const comparison = content.pcb_comparison as Comparison | undefined;
  if (comparison) [comparison.left, comparison.right].forEach(input => { if (input.kind === 'assertion_revision') { if (input.revision_id) pins.revisions.push(input.revision_id); } else if (input.source.source_revision_id) pins.sources.push(input.source.source_revision_id); });
  const model = content.passages as Model | undefined;
  if (model) { if (model.root_revision_id) pins.revisions.push(model.root_revision_id); model.passages.forEach(row => { if (row.evidence.status === 'registered_file' && row.evidence.source_bundle_revision_id) pins.sources.push(row.evidence.source_bundle_revision_id); }); }
  return uniquePins(pins);
}
export async function authorizeSecondaryContent(content: Content, workspaceId: string, selectedRecord?: PartRecord) {
  // The selected-state server read has already authorized its complete saved closure.
  // Passive review history is additive state beyond the frozen model content.
  if (selectedRecord) {
    if (selectedRecord.kind === 'passage_model' && selectedRecord.selected.kind === 'revision') await requestJson(`/api/v0/passive-passages/revisions/${encodeURIComponent(selectedRecord.selected.revision_id)}`, { cache: 'no-store' });
    return;
  }
  await authorizeWorkingPins(secondaryPins(content), workspaceId);
  const comparison = content.pcb_comparison as Comparison | undefined;
  for (const input of comparison ? [comparison.left, comparison.right] : []) {
    if (input.kind === 'pcb_interpretation' && input.interpretation_id) {
      if (!input.source.source_revision_id) throw new ApiError(403, 'The exact native source is unavailable.');
      const source = await requestJson<{ workspace_id: string }>(`/api/v0/sources/revisions/${encodeURIComponent(input.source.source_revision_id)}`, { cache: 'no-store' });
      const intakes = await requestJson<{ intake_id: string; source_revision_id: string }[]>(`/api/v0/pcb/workspaces/${encodeURIComponent(source.workspace_id)}/intakes`, { cache: 'no-store' });
      let found = false;
      for (const candidate of intakes.filter(row => row.source_revision_id === input.source.source_revision_id).slice(0, 50)) {
        const intake = await requestJson<{ interpretations: { interpretation_id: string }[] }>(`/api/v0/pcb/intakes/${encodeURIComponent(candidate.intake_id)}`, { cache: 'no-store' });
        if (intake.interpretations.some(row => row.interpretation_id === input.interpretation_id)) { found = true; break; }
      }
      if (!found) throw new ApiError(403, 'The exact accepted native interpretation is unavailable.');
    }
    if (input.kind === 'source_net_interpretation' && input.interpretation_id) await requestJson(`/api/v0/pcb-disagreement/native/${encodeURIComponent(input.interpretation_id)}`, { cache: 'no-store' });
  }
  const model = content.passages as Model | undefined;
  if (model?.root_revision_id) await requestJson(`/api/v0/copper/revisions/${encodeURIComponent(model.root_revision_id)}`, { cache: 'no-store' });
}

export function secondaryContentSignature(content: Content) {
  const comparison = content.pcb_comparison as Comparison | undefined;
  return canonical([secondaryPins(content), comparison ? [comparison.left, comparison.right].map(input => input.kind === 'assertion_revision' ? null : [input.kind, input.interpretation_id]) : null]);
}
