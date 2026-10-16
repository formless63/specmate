import { SourceError } from '../sources/api';
import { ApiError, requestJson } from '../workspace/api';
import type { PartRecord } from '../parts/api';
import { readDraft, readRetained, type Draft, type Retained } from './api';

export type ProposalTarget = { kind: 'draft'; draft: Draft } | { kind: 'retained'; retained: Retained; adoption?: PartRecord };
const missing = (reason: unknown) => (reason instanceof SourceError || reason instanceof ApiError) && reason.status === 404;
function unavailable(): never { throw new SourceError(404, 'The requested exact proposal record is unavailable.'); }
function retainedRecord(record: Retained, workspaceId: string, id: string, number: number | null) {
  if (record.revision_id !== id || record.workspace_id !== workspaceId || number !== null && record.number !== number || !record.document) unavailable();
  return record;
}
/** Resolve only the named namespaces. A retained record never substitutes its draft or head. */
export async function resolveProposalTarget(id: string, number: number | null, workspaceId: string, working = false): Promise<ProposalTarget> {
  let retained: Retained | undefined;
  try { retained = await readRetained(id, workspaceId); } catch (reason) { if (!missing(reason)) throw reason; }
  if (retained) return { kind: 'retained', retained: retainedRecord(retained, workspaceId, id, number) };
  let draft: Draft | undefined;
  try { draft = await readDraft(id); } catch (reason) { if (!missing(reason)) throw reason; }
  if (draft) {
    if (draft.draft_id !== id || draft.workspace_id !== workspaceId) unavailable();
    if (number === null) return { kind: 'draft', draft };
    const revision = draft.revisions.find(row => row.number === number);
    if (!revision) unavailable();
    retained = retainedRecord(await readRetained(revision.revision_id, workspaceId), workspaceId, revision.revision_id, number);
    if (retained.draft_id !== id) unavailable();
    return { kind: 'retained', retained };
  }
  const query = new URLSearchParams({ include_content: 'true' });
  if (number !== null) query.set('revision_number', String(number)); else if (working) query.set('working', 'true');
  const adoption = await requestJson<PartRecord>(`/api/v0/catalog/definitions/${encodeURIComponent(id)}/record?${query}`, { cache: 'no-store' });
  if (adoption.definition_id !== id || adoption.workspace_id !== workspaceId || adoption.kind !== 'enclosure_proposal' || number !== null && (adoption.selected.kind !== 'revision' || adoption.selected.number !== number)) unavailable();
  const pin = adoption.selected.content.proposal_adoption as { retained_proposal_id?: string; retained_sha256?: string; proposal_draft_id?: string; interpretation_id?: string; interpretation_sha256?: string } | undefined;
  if (!pin?.retained_proposal_id) unavailable();
  retained = retainedRecord(await readRetained(pin.retained_proposal_id, workspaceId), workspaceId, pin.retained_proposal_id, null);
  if (retained.sha256 !== pin.retained_sha256 || retained.draft_id !== pin.proposal_draft_id || retained.interpretation_id !== pin.interpretation_id || retained.interpretation_sha256 !== pin.interpretation_sha256) unavailable();
  return { kind: 'retained', retained, adoption };
}
