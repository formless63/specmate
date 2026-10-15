/**
 * The one placement rule for stock sections, mirrored by the backend
 * (`specmate/wire_stock/geometry.py`) and cross-checked against
 * `tests/fixtures/wire-stock-placement.json`.
 *
 * A node sits at its parent's position plus its own `x_mm`/`y_mm` offset. Members
 * (conductors and nested groups) of a ring, linear or figure-eight group also take
 * the arrangement displacement from the group's pitch: rings start at 12 o'clock and
 * step in the stated screen direction (y grows downward); linear rows are centerd.
 * A member of an arranged group with an unknown pitch, or any node with a null
 * (unknown) offset, has an unknown position.
 */
import type { GroupElement, StockElement } from './model';

export type LeafElement = Exclude<StockElement, GroupElement>;
export type PlacedNode =
  | { type: 'group'; path: string; node: GroupElement; x: number | null; y: number | null; members: string[] }
  | { type: 'leaf'; path: string; node: LeafElement; parent: string; x: number | null; y: number | null };
export interface Placement {
  /** Pre-order: each group precedes its descendants, children in declared order. */
  nodes: PlacedNode[];
  /** Arranged members that also carry a manual offset: [member path, group path]. */
  offsetMembers: [string, string][];
}

export const isMember = (node: StockElement): boolean => node.kind === 'group' || node.kind === 'conductor';

/** Arrangement displacement of member `index` of `count` in an arranged group with a known pitch. */
export function arrangedOffset(group: GroupElement, count: number, index: number): [number, number] {
  const pitch = group.pitch_mm ?? 0;
  if (group.arrangement === 'ring') {
    const step = (group.direction === 'ccw' ? -1 : 1) * 2 * Math.PI / count;
    const angle = -Math.PI / 2 + step * index;
    return [pitch / 2 * Math.cos(angle), pitch / 2 * Math.sin(angle)];
  }
  return [(index - (count - 1) / 2) * pitch, 0];
}

export function placeStock(structure: GroupElement): Placement {
  const nodes: PlacedNode[] = [];
  const offsetMembers: [string, string][] = [];
  const visit = (node: StockElement, path: string, parent: string, x: number | null, y: number | null): void => {
    const px = x === null || node.x_mm === null ? null : x + node.x_mm;
    const py = y === null || node.y_mm === null ? null : y + node.y_mm;
    if (node.kind !== 'group') {
      nodes.push({ type: 'leaf', path, node, parent, x: px, y: py });
      return;
    }
    const members = node.children.filter(isMember);
    const arranged = node.arrangement !== 'concentric';
    nodes.push({ type: 'group', path, node, x: px, y: py, members: members.map(m => `${path}.${m.id}`) });
    for (const child of node.children) {
      const childPath = `${path}.${child.id}`;
      const index = members.indexOf(child);
      const placed = arranged && index >= 0;
      if (placed && (child.x_mm !== 0 || child.y_mm !== 0)) offsetMembers.push([childPath, path]);
      if (placed && node.pitch_mm === null) { visit(child, childPath, path, null, null); continue; }
      const [dx, dy] = placed ? arrangedOffset(node, members.length, index) : [0, 0];
      visit(child, childPath, path, px === null ? null : px + dx, py === null ? null : py + dy);
    }
  };
  visit(structure, structure.id, '', 0, 0);
  return { nodes, offsetMembers };
}
