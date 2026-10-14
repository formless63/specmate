/**
 * Adapted from WireHub packages/layout/src/cross-section.ts at
 * cbf919edf30a9d906a791971d3a40e22cb78b67e, AGPL-3.0-only.
 * Retains deterministic ring placement and figure-eight projection. Explicit
 * dimensions replace implicit jacket bores; no preparation defaults or catalog.
 */
import { figure8Path } from './figure8';
import type { Section, SectionFeature, SectionGroup, StockElement, StockGeometry, StockSpecification } from './model';

export function sectionLayout(stock: StockSpecification): Section {
  const rows: Section['rows'] = [];
  const features: SectionFeature[] = [];
  const groups: SectionGroup[] = [];
  const unknown: string[] = [];
  let outline: string | null = null;
  const visit = (node: StockElement, path: string, x: number | null, y: number | null): void => {
    const px = x === null ? null : x + node.x_mm;
    const py = y === null ? null : y + node.y_mm;
    if (node.kind === 'group') {
      const members = node.children.filter(c => c.kind === 'group' || c.kind === 'conductor');
      const arranged = node.arrangement !== 'concentric';
      if (arranged) groups.push({ path, arrangement: node.arrangement, direction: node.direction, members: members.map(m => `${path}.${m.id}`) });
      if (arranged && node.pitch_mm === null) unknown.push(`${path}: arrangement pitch unknown`);
      for (const child of node.children) {
        const index = members.indexOf(child);
        let dx = 0, dy = 0;
        const placed = arranged && index >= 0;
        const located = !(placed && node.pitch_mm === null);
        if (placed && node.pitch_mm !== null) {
          if (node.arrangement === 'ring') {
            const step = (node.direction === 'ccw' ? -1 : 1) * 2 * Math.PI / members.length;
            const angle = -Math.PI / 2 + step * index;
            dx = node.pitch_mm / 2 * Math.cos(angle);
            dy = node.pitch_mm / 2 * Math.sin(angle);
          } else dx = (index - (members.length - 1) / 2) * node.pitch_mm;
        }
        visit(child, `${path}.${child.id}`, located && px !== null ? px + dx : null,
          located && py !== null ? py + dy : null);
      }
      if (node.arrangement === 'figure-eight' && node.pitch_mm !== null && px !== null && py !== null) {
        const legs = members.filter(c => c.kind === 'group');
        const radii = legs.map(leg => leg.kind === 'group' ? Math.max(0, ...leg.children.map(c =>
          c.kind !== 'group' && c.kind !== 'web' && c.outer_diameter_mm !== null ? c.outer_diameter_mm / 2 : 0)) : 0);
        const web = node.children.find(c => c.kind === 'web');
        if (radii[0] !== undefined && radii[0] > 0 && radii[0] === radii[1] && web?.kind === 'web' && web.height_mm !== null) {
          outline = figure8Path({ x: px - node.pitch_mm / 2, y: py },
            { x: px + node.pitch_mm / 2, y: py }, radii[0], web.height_mm / 2);
        }
      }
      return;
    }
    const round = node.kind !== 'web';
    rows.push({ path, kind: node.kind, label: node.label, material: node.material, color: node.color,
      source: node.source, tag: String(rows.length + 1),
      widthMm: round ? node.outer_diameter_mm : node.width_mm,
      heightMm: round ? node.outer_diameter_mm : node.height_mm,
      outerDiameterMm: round ? node.outer_diameter_mm : null,
      innerDiameterMm: round ? node.inner_diameter_mm : null,
      construction: round ? node.construction : null });
    if (px === null || py === null) {
      unknown.push(`${path}: position unknown`);
      return;
    }
    if (node.kind === 'web') {
      if (node.width_mm === null || node.height_mm === null) unknown.push(`${path}: web dimensions unknown`);
      else features.push({ path, kind: node.kind, x: px, y: py, color: node.color, material: node.material, construction: null,
        shape: { type: 'web', width: node.width_mm, height: node.height_mm } });
    } else if (node.outer_diameter_mm === null || node.inner_diameter_mm === null) {
      unknown.push(`${path}: layer dimensions unknown`);
    } else if (!Number.isFinite(node.outer_diameter_mm) || !Number.isFinite(node.inner_diameter_mm) || node.outer_diameter_mm <= 0 || node.inner_diameter_mm < 0 || node.inner_diameter_mm >= node.outer_diameter_mm) {
      unknown.push(`${path}: invalid layer boundaries`);
    } else features.push({ path, kind: node.kind, x: px, y: py, color: node.color, material: node.material, construction: node.construction,
      shape: { type: 'ring', rOuter: node.outer_diameter_mm / 2, rInner: node.inner_diameter_mm / 2 } });
  };
  visit(stock.structure, stock.structure.id, 0, 0);
  const extent = features.map(f => {
    const rx = f.shape.type === 'ring' ? f.shape.rOuter : f.shape.width / 2;
    const ry = f.shape.type === 'ring' ? f.shape.rOuter : f.shape.height / 2;
    return { minX: f.x - rx, maxX: f.x + rx, minY: f.y - ry, maxY: f.y + ry };
  });
  const bounds = extent.length === 0 ? null : {
    minX: Math.min(...extent.map(b => b.minX)), maxX: Math.max(...extent.map(b => b.maxX)),
    minY: Math.min(...extent.map(b => b.minY)), maxY: Math.max(...extent.map(b => b.maxY)) };
  const complete = unknown.length === 0 && bounds !== null;
  return { schemaVersion: '1', viewedFrom: stock.viewed_from, rows, features, groups, unknown, bounds, outline,
    widthMm: complete ? bounds.maxX - bounds.minX : null,
    heightMm: complete ? bounds.maxY - bounds.minY : null, electricalBonds: [] };
}

/** Straight stock extrusion, with no electrical or preparation meaning. */
export function stockGeometry(section: Section, lengthMm: number): StockGeometry {
  if (!Number.isFinite(lengthMm) || lengthMm <= 0) throw new Error('Preview length must be positive.');
  return { lengthMm, widthMm: section.widthMm, heightMm: section.heightMm, unknown: [...section.unknown],
    pieces: section.features.map(f => ({ ...f, startMm: 0, endMm: lengthMm })) };
}
