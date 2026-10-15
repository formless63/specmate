/**
 * Fit findings for a stock section, mirroring `specmate/wire_stock/geometry.py`
 * (the server's report is authoritative; this copy gives the editor live feedback).
 * Both are tested against `tests/fixtures/wire-stock-placement.json`.
 *
 * Placed outer circles are compared with enclosing bores and with sibling elements
 * within a stated tolerance. A check with an unknown dimension or position is "not
 * evaluated" and never passes. Findings describe declared geometry only; they are
 * not clearance, manufacturing or physical qualification.
 */
import type { StockSpecification } from './model';
import { placeStock } from './placement';
import type { LeafElement } from './placement';

export const FIT_TOLERANCE_MM = 0.001;
const TUBE_KINDS = new Set(['dielectric', 'insulation', 'shield', 'jacket']);

export type FitCode = 'containment' | 'wall_overlap' | 'outside' | 'overlap' | 'offset_on_arranged';
export interface FitFinding {
  code: FitCode;
  status: 'fail' | 'not_evaluated' | 'note';
  /** [element or core, enclosing layer] or [first, second] sibling. */
  paths: [string, string];
  group: string;
  excess_mm: number | null;
  message: string;
}
export interface FitReport {
  status: 'problems' | 'incomplete' | 'ok' | 'nothing_to_check';
  tolerance_mm: number;
  checks: number;
  failed: number;
  not_evaluated: number;
  findings: FitFinding[];
}

interface Leaf { path: string; kind: LeafElement['kind']; parent: string; x: number | null; y: number | null; rOut: number | null; rIn: number | null; tube: boolean }

function leafOf(node: LeafElement, path: string, parent: string, x: number | null, y: number | null): Leaf {
  if (node.kind === 'web') {
    const rOut = node.width_mm === null || node.height_mm === null ? null : Math.hypot(node.width_mm, node.height_mm) / 2;
    return { path, kind: 'web', parent, x, y, rOut, rIn: null, tube: false };
  }
  const outer = node.outer_diameter_mm, inner = node.inner_diameter_mm;
  const tube = (inner !== null && inner > 0) || (inner === null && TUBE_KINDS.has(node.kind));
  return { path, kind: node.kind, parent, x, y, rOut: outer === null ? null : outer / 2, rIn: inner === null ? null : inner / 2, tube };
}

/** Half-up millimetre text, identical to the backend. */
export const fitMm = (value: number): string => (Math.floor(value * 1000 + 0.5) / 1000).toFixed(3);
const unitOf = (leaf: Leaf, group: string): string => leaf.parent === group ? leaf.path : leaf.parent;
const known = (...leaves: Leaf[]): boolean => leaves.every(l => l.x !== null && l.y !== null && l.rOut !== null);
type Outcome = null | ['pass' | 'fail', FitCode, number];

function tubeOutcome(leaf: Leaf, tube: Leaf, outermost: boolean): Outcome {
  if (!known(leaf, tube) || tube.rIn === null) return null;
  const d = Math.hypot(leaf.x! - tube.x!, leaf.y! - tube.y!);
  const rOut = leaf.rOut!, tOut = tube.rOut!, tIn = tube.rIn;
  if (leaf.tube) {
    if (leaf.rIn === null) {
      if (d + tOut <= rOut + FIT_TOLERANCE_MM) return null;
    } else if (leaf.rIn + FIT_TOLERANCE_MM >= d + tOut) return ['pass', 'containment', 0];
  }
  if (d + rOut <= tIn + FIT_TOLERANCE_MM) return ['pass', 'containment', 0];
  if (d - rOut >= tOut - FIT_TOLERANCE_MM) return outermost ? ['fail', 'outside', d + rOut - tIn] : ['pass', 'containment', 0];
  if (d - rOut < tIn) return ['fail', 'containment', d + rOut - tIn];
  return ['fail', 'wall_overlap', tOut - (d - rOut)];
}

interface Check { code: FitCode; status: 'pass' | 'fail' | 'not_evaluated'; paths: [string, string]; group: string; excess_mm: number | null }

function message(item: Check): string {
  const [a, b] = item.paths;
  if (item.status === 'not_evaluated') return item.code === 'overlap'
    ? `${a} and ${b}: overlap not evaluated; a dimension or position is unknown.`
    : `${a} within ${b}: not evaluated; a dimension or position is unknown.`;
  const excess = fitMm(item.excess_mm!);
  switch (item.code) {
    case 'containment': return `${a} extends ${excess} mm beyond the bore of ${b}.`;
    case 'wall_overlap': return `${a} overlaps the wall of ${b} by ${excess} mm.`;
    case 'outside': return `${a} lies outside ${b}, the outer layer of ${item.group}.`;
    default: return `${a} and ${b} overlap by ${excess} mm.`;
  }
}

export function evaluateFit(stock: StockSpecification): FitReport {
  const placement = placeStock(stock.structure);
  const leaves: Leaf[] = [];
  for (const n of placement.nodes) if (n.type === 'leaf') leaves.push(leafOf(n.node, n.path, n.parent, n.x, n.y));
  const checks = new Map<string, Check>();
  const record = (key: string, base: Omit<Check, 'status' | 'excess_mm'>, outcome: Outcome) => {
    let current = checks.get(key);
    if (!current) { current = { ...base, status: 'pass', excess_mm: null }; checks.set(key, current); }
    if (outcome === null) { if (current.status === 'pass') current.status = 'not_evaluated'; return; }
    const [status, code, excess] = outcome;
    if (status === 'fail' && (current.status !== 'fail' || excess > current.excess_mm!)) Object.assign(current, { status: 'fail', code, excess_mm: excess });
  };
  for (const g of placement.nodes) {
    if (g.type !== 'group') continue;
    const prefix = `${g.path}.`;
    const subtree = leaves.filter(l => l.path.startsWith(prefix));
    const tubes = subtree.filter(l => l.parent === g.path && l.tube);
    const outer = tubes.length && tubes.every(t => t.rOut !== null) ? Math.max(...tubes.map(t => t.rOut!)) : null;
    for (const tube of tubes) for (const leaf of subtree) {
      if (leaf === tube) continue;
      const unit = unitOf(leaf, g.path);
      record(`tube\u0000${unit}\u0000${tube.path}`, { code: 'containment', paths: [unit, tube.path], group: g.path }, tubeOutcome(leaf, tube, tube.rOut === outer));
    }
    const children = g.node.children.filter(c => c.kind !== 'web' && !tubes.some(t => t.path === `${prefix}${c.id}`));
    const within = (path: string) => subtree.filter(l => l.kind !== 'web' && (l.path === path || l.path.startsWith(`${path}.`)));
    children.forEach((first, i) => {
      const firstLeaves = within(`${prefix}${first.id}`);
      for (const second of children.slice(i + 1)) {
        const secondLeaves = within(`${prefix}${second.id}`);
        for (const a of firstLeaves) for (const b of secondLeaves) {
          const ua = unitOf(a, g.path), ub = unitOf(b, g.path);
          let outcome: Outcome = null;
          if (known(a, b)) {
            const depth = a.rOut! + b.rOut! - Math.hypot(a.x! - b.x!, a.y! - b.y!);
            outcome = depth > FIT_TOLERANCE_MM ? ['fail', 'overlap', depth] : ['pass', 'overlap', 0];
          }
          record(`pair\u0000${ua}\u0000${ub}`, { code: 'overlap', paths: [ua, ub], group: g.path }, outcome);
        }
      }
    });
  }
  const findings: FitFinding[] = [];
  for (const item of checks.values()) {
    if (item.status === 'pass') continue;
    const excess = item.status === 'fail' ? Number(item.excess_mm!.toFixed(6)) : null;
    findings.push({ code: item.code, status: item.status, paths: item.paths, group: item.group, excess_mm: excess, message: message(item) });
  }
  const notes: FitFinding[] = placement.offsetMembers.map(([member, group]) => ({
    code: 'offset_on_arranged', status: 'note', paths: [member, group], group, excess_mm: null,
    message: `${member} has a manual offset added to its arranged position in ${group}; arranged members are placed by pitch, so offsets move them twice.`,
  }));
  const failed = findings.filter(f => f.status === 'fail').length;
  const unknown = findings.filter(f => f.status === 'not_evaluated').length;
  const status = failed ? 'problems' : unknown ? 'incomplete' : checks.size ? 'ok' : 'nothing_to_check';
  return { status, tolerance_mm: FIT_TOLERANCE_MM, checks: checks.size, failed, not_evaluated: unknown, findings: [...findings, ...notes] };
}
