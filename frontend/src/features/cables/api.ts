import type { Body, Pinout } from '../interfaces/api';
export { command, read, type Definition, type Identity } from '../identity/api';
export type Endpoint = { local_id: string; label: string | null; body_revision_id: string; pinout_revision_id: string };
export type Assignment = { endpoint_id: string; element_path: string; contact_id: string; basis: string };
export type Cable = { schema_version?: '0.1'; stock_revision_id: string; endpoints: Endpoint[]; assignments: Assignment[]; review: 'unreviewed' | 'reviewed'; review_basis: string | null };
export type Draft = { definition_id: string; draft_id: string; state: string; content: { cable?: Cable } };
export type Inspection = { revision_id: string; snapshot_id: string; cable: Cable; conductors: { element_path: string; stock_revision_id: string; kind: string; label: string; ends: { endpoint_id: string; assignment: Assignment | null }[] }[]; endpoints: (Endpoint & { body: Body; pinout: Pinout })[]; continuity: string; compatibility: string; physical_qualification: string };
export function initialCable(): Cable {
  return { stock_revision_id: '', endpoints: ['a', 'b'].map(local_id => ({ local_id, label: null, body_revision_id: '', pinout_revision_id: '' })), assignments: [], review: 'unreviewed', review_basis: null };
}
