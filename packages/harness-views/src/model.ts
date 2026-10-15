// SPDX-License-Identifier: AGPL-3.0-only
/** Structural projection of a frozen harness (content 0.2: end-stack endpoints). Display only; the backend owns validation. */
import type { Section } from '../../section-layout/src';

export type End = 'a' | 'b';
export interface SegmentEnd { segment_id: string; end: End }
export type HarnessTerminal =
  | { kind: 'segment'; segment_id: string; end: End; element_path: string }
  | { kind: 'endpoint'; endpoint_id: string; layer_id: string; terminal_id: string };
export interface HarnessSection {
  local_id: string; stock_revision_id: string; planned_cut_length_mm: string | null; cut_basis: string | null;
  physical_ends?: { local_id: string; label: string | null; segment_ends: SegmentEnd[]; endpoint_id: string | null; basis: string; review: string }[];
}
export interface HarnessSegment { local_id: string; section_id: string; label: string | null; element_paths: string[] | null }
export interface StackLayerPin { kind: 'board' | 'inline' | 'connector' | 'shell'; layer_id: string; body_revision_id?: string; pinout_revision_id?: string; board_revision_id?: string; part_revision_id?: string | null }
/** One endpoint: a pinned end assembly or an ad-hoc stack ordered from the wire outward. */
export interface HarnessEndpoint { local_id: string; label: string | null; end_assembly_revision_id: string | null; stack: { layers: StackLayerPin[] } | null }
/** Exact revision IDs an endpoint pins: its end assembly, or its stack's layer pins. */
export function endpointPins(ep: HarnessEndpoint): string[] {
  if (ep.end_assembly_revision_id) return [ep.end_assembly_revision_id];
  return (ep.stack?.layers ?? []).flatMap(l => [l.board_revision_id, l.body_revision_id, l.pinout_revision_id, l.part_revision_id]).filter((id): id is string => !!id);
}
/** What a resolved end stack says about one terminal; supplied by the caller from the server's resolution. */
export interface EndTerminalInfo { label: string; layerKind: string; signals: { label: string; name: string | null; type: string | null; status: string }[]; parts: string[] }
/** Per endpoint: a display name for its stack and its terminals keyed `${layer_id}/${terminal_id}`. */
export type EndInfoMap = Readonly<Record<string, { name: string | null; terminals: Readonly<Record<string, EndTerminalInfo>> } | undefined>>;
export interface HarnessJoint { local_id: string; kind: 'termination' | 'splice' | 'shield_bond'; members: HarnessTerminal[]; basis: string }
export interface HarnessBreakout { local_id: string; trunk: SegmentEnd; legs: SegmentEnd[]; fates: { local_id: string; kind: string }[] }
export interface HarnessView {
  sections: HarnessSection[]; segments: HarnessSegment[]; endpoints: HarnessEndpoint[]; joints: HarnessJoint[]; breakouts: HarnessBreakout[];
  review?: string; review_basis?: string | null;
}
/** Resolved stock for one exact stock revision. `section` is its laid-out cut face. */
export interface StockInfoInput { name: string; section: Section }
export type StockMap = Readonly<Record<string, StockInfoInput | undefined>>;

/** Exact decimal helpers for planned cut text; never floating-point sums. */
export function parseDecimal(text: string | null): { units: bigint; scale: number } | null {
  if (text === null) return null;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m || (m[2]?.length ?? 0) > 9) return null;
  return { units: BigInt(m[1]! + (m[2] ?? '')), scale: m[2]?.length ?? 0 };
}
export function sumDecimals(values: (string | null)[], multiplier = 1): string | null {
  const parsed = values.map(parseDecimal);
  if (parsed.length === 0 || parsed.some(p => p === null)) return parsed.length === 0 ? '0' : null;
  const scale = Math.max(...parsed.map(p => p!.scale));
  const total = parsed.reduce((sum, p) => sum + p!.units * 10n ** BigInt(scale - p!.scale), 0n) * BigInt(multiplier);
  const digits = total.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale), frac = digits.slice(digits.length - scale).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}
