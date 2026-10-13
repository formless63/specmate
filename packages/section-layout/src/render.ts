/** Standalone SVG drawing and axial preview consume the exact shared section. */
import type { Section, SectionFeature, StockGeometry } from './model';

const esc = (text: string): string => text.replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const n = (value: number): string => String(Math.round(value * 10000) / 10000);
/** A display choice only: no material fact is inferred from this color. */
export const displayColor = (feature: Pick<SectionFeature, 'color' | 'kind'>): string =>
  (feature.color !== null && /^#[0-9a-fA-F]{6}$/.test(feature.color) ? feature.color : null) ?? (feature.kind === 'conductor' || feature.kind === 'drain' ? '#b87333' :
    feature.kind === 'shield' ? '#87909b' : '#c8cbd0');

function shape(feature: SectionFeature): string {
  const { x, y } = feature;
  const color = displayColor(feature);
  if (feature.shape.type === 'web') return `<rect x="${n(x - feature.shape.width / 2)}" y="${n(y - feature.shape.height / 2)}" width="${n(feature.shape.width)}" height="${n(feature.shape.height)}" fill="${color}"/>`;
  const { rOuter: r, rInner: inner } = feature.shape;
  const circle = (radius: number): string => `M${n(x - radius)},${n(y)}a${n(radius)},${n(radius)} 0 1 0 ${n(2 * radius)},0a${n(radius)},${n(radius)} 0 1 0 ${n(-2 * radius)},0`;
  return `<path d="${circle(r)}${inner > 0 ? circle(inner) : ''}" fill="${color}" fill-rule="evenodd"/>`;
}

export function renderSectionSvg(section: Section, title: string): string {
  const bounds = section.bounds;
  const span = bounds === null ? 4 : Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1);
  const pad = span * 0.7;
  const minX = (bounds?.minX ?? -2) - pad;
  const minY = (bounds?.minY ?? -2) - pad;
  const width = (bounds === null ? 4 : bounds.maxX - bounds.minX) + 2 * pad;
  const height = (bounds === null ? 4 : bounds.maxY - bounds.minY) + 2 * pad;
  const sorted = [...section.features].sort((a, b) => {
    const size = (f: SectionFeature): number => f.shape.type === 'ring' ? f.shape.rOuter : 0;
    return size(b) - size(a);
  });
  const parts = sorted.map(f => `<g data-element="${esc(f.path)}" data-kind="${f.kind}">${shape(f)}</g>`);
  for (const row of section.rows) {
    const f = section.features.find(item => item.path === row.path);
    if (f === undefined) continue;
    const radius = f.shape.type === 'ring' ? f.shape.rOuter : f.shape.width / 2;
    const side = Number(row.tag) % 2 === 0 ? -1 : 1;
    const sx = f.x + side * radius;
    const ex = sx + side * pad * 0.7;
    const ey = f.y + (Number(row.tag) - section.rows.length / 2) * span * 0.09;
    parts.push(`<g data-callout="${esc(row.path)}"><path d="M${n(sx)} ${n(f.y)}L${n(ex)} ${n(ey)}" stroke="#222" stroke-width="${n(span / 180)}" fill="none"/><text x="${n(ex)}" y="${n(ey)}" font-size="${n(span / 12)}" text-anchor="${side > 0 ? 'start' : 'end'}">${row.tag}</text></g>`);
  }
  const description = section.unknown.length > 0 ? `Incomplete geometry: ${section.unknown.join('; ')}` :
    `${n(section.widthMm!)} × ${n(section.heightMm!)} mm. ${section.features.length} material elements. Viewed from ${section.viewedFrom}.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(minX)} ${n(minY)} ${n(width)} ${n(height)}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><desc>${esc(description)}</desc>${parts.join('')}</svg>`;
}

/** Axonometric cut-face preview of the exported straight extrusion pieces. */
export function renderPreviewSvg(geometry: StockGeometry, title: string): string {
  const section: Section = { schemaVersion: '1', viewedFrom: 'unknown', rows: [], features: geometry.pieces,
    unknown: geometry.unknown, bounds: null, outline: null, widthMm: geometry.widthMm,
    heightMm: geometry.heightMm, electricalBonds: [] };
  const size = Math.max(geometry.widthMm ?? 4, geometry.heightMm ?? 4, 1);
  const dx = size * 2, dy = -size;
  const pieces = [...geometry.pieces].sort((a, b) => b.y - a.y).map(f => {
    const r = f.shape.type === 'ring' ? f.shape.rOuter : f.shape.height / 2;
    const width = f.shape.type === 'ring' ? 2 * r : f.shape.width;
    const x = f.x - width / 2;
    return `<g data-preview-element="${esc(f.path)}"><path d="M${n(x)} ${n(f.y + r)}l${n(dx)} ${n(dy)}l${n(width)} 0l${n(-dx)} ${n(-dy)}Z" fill="${displayColor(f)}" stroke="#444" stroke-width="${n(size / 200)}"/></g>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(-size)} ${n(-2 * size)} ${n(5 * size)} ${n(3.5 * size)}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><desc>Axonometric stock preview. Axial length compressed for display; extrusion length ${geometry.lengthMm} mm. No stripping or bonds.</desc>${pieces.join('')}<g>${section.features.map(shape).join('')}</g></svg>`;
}
