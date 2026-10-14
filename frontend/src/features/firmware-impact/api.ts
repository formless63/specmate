import type { Assertion, Subject } from '../facts/api';
import type { Evaluation, Firmware } from '../firmware/api';
import { operation } from '../firmware-occurrences/api';

export type FirmwareReference = { firmware_revision_id: string; assembly_snapshot_id?: string; path?: string[] };
export type ImpactRequest = { workspace_id: string; baseline: FirmwareReference; candidate: FirmwareReference; assertion_ids?: string[]; observation_offset?: number };
export type ImpactInputs = Firmware & { firmware_revision_id: string; firmware_snapshot_sha256: string;
  occurrence: { assembly_snapshot_id: string; assembly_snapshot_sha256: string; path: string[]; population_revision_id: string } | null };
export type ImpactResult = {
  comparison_sha256: string; review_required: boolean;
  baseline: { reference: FirmwareReference; inputs: ImpactInputs; evaluation: Evaluation };
  candidate: { reference: FirmwareReference; inputs: ImpactInputs; evaluation: Evaluation };
  findings: { key: string; status: 'changed' | 'unchanged' | 'unknown'; baseline: unknown; candidate: unknown; reason: string }[];
  observations: { assertion: Assertion; subject: Subject; applicability: string; reason: string; review_keys: string[];
    historical_result_preserved: boolean; candidate_result: null }[];
  observations_total: number; observations_truncated: boolean; observation_offset: number; observations_has_more: boolean;
};

export function compareImpact(payload: ImpactRequest): Promise<ImpactResult> {
  return operation<ImpactResult>('firmware_impact.compare', payload);
}
