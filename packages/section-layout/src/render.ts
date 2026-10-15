/** Standalone SVG drawing and axial preview consume the exact shared section. */
import { appearanceOf, edgeColor, mixHex } from './appearance';
import type { Appearance } from './appearance';
import { layoutCallouts } from './callouts';
import type { CalloutItem, CalloutOptions } from './callouts';
import { placeOnFace } from './end-face';
import type { Section, SectionFeature, StockGeometry } from './model';

const esc = (text: string): string => text.replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const n = (value: number): string => String(Math.round(value * 10000) / 10000);
/** Base fill of a feature: recorded color, a labeled typical metal color, or an explicit unknown. */
export const displayColor = (feature: Pick<SectionFeature, 'color' | 'kind' | 'material' | 'construction'>): string => appearanceOf(feature).base;

export interface SectionSvgOptions {
  /** Element path drawn with a reticle (selection never changes the engineering fill). */
  selected?: string | null;
  /** Unique id prefix for gradients/patterns when several drawings share a page. */
  idPrefix?: string;
  callouts?: boolean;
  /** End-face view: mirror about the vertical axis, then turn counter-clockwise on screen. */
  view?: { mirrored: boolean; rotationDeg: number };
  /** Terminal markers in screen coordinates (after the view transform). */
  markers?: { x: number; y: number; tag: string; role: 'conductor' | 'shield' | 'drain' }[];
}
const hash = (text: string): string => {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};
const circle = (x: number, y: number, radius: number): string =>
  `M${n(x - radius)},${n(y)}a${n(radius)},${n(radius)} 0 1 0 ${n(2 * radius)},0a${n(radius)},${n(radius)} 0 1 0 ${n(-2 * radius)},0`;
function shapePath(feature: SectionFeature): string {
  const { x, y } = feature;
  if (feature.shape.type === 'web') {
    const w = feature.shape.width, h = feature.shape.height;
    return `M${n(x - w / 2)},${n(y - h / 2)}h${n(w)}v${n(h)}h${n(-w)}Z`;
  }
  const { rOuter, rInner } = feature.shape;
  return circle(x, y, rOuter) + (rInner > 0 ? circle(x, y, rInner) : '');
}

/** Finish gradients shared by every element of a drawing (objectBoundingBox units). */
function finishDefs(prefix: string): string {
  const stops = (list: [number, string, number][]): string => list.map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${a}"/>`).join('');
  return `<linearGradient id="${prefix}-f-metal" x1="0" y1="0" x2="1" y2="1">${stops([[0, '#ffffff', 0.5], [0.3, '#ffffff', 0], [0.55, '#000000', 0.28], [0.8, '#ffffff', 0.18], [1, '#000000', 0.35]])}</linearGradient>`
    + `<linearGradient id="${prefix}-f-foil" x1="0" y1="0" x2="1" y2="0.4">${stops([[0, '#ffffff', 0.6], [0.25, '#000000', 0.12], [0.45, '#ffffff', 0.5], [0.7, '#000000', 0.2], [1, '#ffffff', 0.35]])}</linearGradient>`
    + `<radialGradient id="${prefix}-f-gloss" cx="0.33" cy="0.28" r="0.8">${stops([[0, '#ffffff', 0.5], [0.3, '#ffffff', 0.12], [0.75, '#000000', 0.08], [1, '#000000', 0.32]])}</radialGradient>`
    + `<radialGradient id="${prefix}-f-satin" cx="0.35" cy="0.3" r="0.85">${stops([[0, '#ffffff', 0.28], [0.5, '#ffffff', 0], [1, '#000000', 0.26]])}</radialGradient>`
    + `<radialGradient id="${prefix}-f-matt" cx="0.4" cy="0.35" r="0.9">${stops([[0, '#ffffff', 0.1], [1, '#000000', 0.2]])}</radialGradient>`;
}
const FINISH_FILL: Record<Appearance['finish'], string> = { metal: 'metal', foil: 'foil', gloss: 'gloss', satin: 'satin', matt: 'matt', foam: 'matt', fiber: 'matt', unknown: 'matt' };

/** Explicit-geometry texture tile for one element; no external resources. */
function textureDef(id: string, texture: Appearance['texture'], base: string, t: number): string {
  const dark = mixHex(base, '#000000', 0.5), light = mixHex(base, '#ffffff', 0.45);
  const sw = n(t * 0.1);
  const tile = (body: string): string => `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${n(t)}" height="${n(t)}">${body}</pattern>`;
  switch (texture) {
    case 'strands':
      return tile(`<circle cx="${n(t / 2)}" cy="${n(t / 2)}" r="${n(t * 0.44)}" fill="${light}" fill-opacity="0.35" stroke="${dark}" stroke-width="${sw}"/><circle cx="${n(t * 0.4)}" cy="${n(t * 0.38)}" r="${n(t * 0.12)}" fill="#ffffff" fill-opacity="0.55"/>`);
    case 'braid':
      return tile(`<path d="M0 ${n(t)}L${n(t)} 0M0 0L${n(t)} ${n(t)}" stroke="${dark}" stroke-width="${sw}" fill="none"/><path d="M${n(-t / 2)} ${n(t / 2)}L${n(t / 2)} ${n(-t / 2)}M${n(t / 2)} ${n(t * 1.5)}L${n(t * 1.5)} ${n(t / 2)}" stroke="${light}" stroke-width="${sw}" fill="none"/>`);
    case 'spiral':
      return tile(`<path d="M0 ${n(t)}L${n(t)} 0" stroke="${dark}" stroke-width="${sw}" fill="none"/><path d="M${n(-t / 2)} ${n(t / 2)}L${n(t / 2)} ${n(-t / 2)}M${n(t / 2)} ${n(t * 1.5)}L${n(t * 1.5)} ${n(t / 2)}" stroke="${light}" stroke-width="${sw}" fill="none"/>`);
    case 'tape':
      return tile(`<path d="M0 ${n(t / 2)}H${n(t)}" stroke="${dark}" stroke-width="${sw}"/><path d="M${n(t / 2)} 0V${n(t / 2)}M0 ${n(t)}V${n(t / 2)}" stroke="${dark}" stroke-width="${sw}" stroke-opacity="0.6"/>`);
    case 'foam':
      return tile(`<circle cx="${n(t * 0.3)}" cy="${n(t * 0.3)}" r="${n(t * 0.16)}" fill="${dark}" fill-opacity="0.28"/><circle cx="${n(t * 0.72)}" cy="${n(t * 0.68)}" r="${n(t * 0.12)}" fill="${light}" fill-opacity="0.5"/>`);
    case 'fiber':
      return tile(`<path d="M0 ${n(t * 0.3)}H${n(t)}M0 ${n(t * 0.8)}H${n(t)}M${n(t * 0.5)} 0V${n(t)}" stroke="${dark}" stroke-width="${n(t * 0.05)}" stroke-opacity="0.45"/>`);
    case 'unknown':
      return tile(`<path d="M0 ${n(t)}L${n(t)} 0M${n(-t / 2)} ${n(t / 2)}L${n(t / 2)} ${n(-t / 2)}M${n(t / 2)} ${n(t * 1.5)}L${n(t * 1.5)} ${n(t / 2)}" stroke="#5f6870" stroke-width="${sw}" fill="none"/>`);
    default:
      return '';
  }
}

/** Extent of the section after mirroring and turning (outline of each feature, not its center). */
export function viewBounds(section: Section, mirrored: boolean, rotationDeg: number): Section['bounds'] {
  const pts: { x: number; y: number }[] = [];
  const c = Math.cos(rotationDeg * Math.PI / 180), s = Math.sin(rotationDeg * Math.PI / 180);
  const put = (x: number, y: number, rx: number, ry: number): void => {
    const mx = mirrored ? -x : x;
    const px = mx * c + y * s, py = -mx * s + y * c;
    // Conservative: a rotated rectangle's extent is the sum of its projected half sides.
    const hx = Math.abs(rx * c) + Math.abs(ry * s), hy = Math.abs(rx * s) + Math.abs(ry * c);
    pts.push({ x: px - hx, y: py - hy }, { x: px + hx, y: py + hy });
  };
  for (const f of section.features) {
    if (f.shape.type === 'ring') {
      const mx = mirrored ? -f.x : f.x;
      const px = mx * c + f.y * s, py = -mx * s + f.y * c;
      pts.push({ x: px - f.shape.rOuter, y: py - f.shape.rOuter }, { x: px + f.shape.rOuter, y: py + f.shape.rOuter });
    } else put(f.x, f.y, f.shape.width / 2, f.shape.height / 2);
  }
  if (pts.length === 0) return null;
  return { minX: Math.min(...pts.map(p => p.x)), maxX: Math.max(...pts.map(p => p.x)), minY: Math.min(...pts.map(p => p.y)), maxY: Math.max(...pts.map(p => p.y)) };
}

/** Circle (in screen coordinates) around every element: callout labels sit just outside it. */
function calloutRing(section: Section, mirrored: boolean, rotationDeg: number, span: number): CalloutOptions {
  const fontSize = span / 12;
  const bounds = viewBounds(section, mirrored, rotationDeg);
  if (bounds === null) return { cx: 0, cy: 0, radius: span / 2, fontSize };
  const cx = (bounds.minX + bounds.maxX) / 2, cy = (bounds.minY + bounds.maxY) / 2;
  let radius = 0;
  for (const f of section.features) {
    const p = placeOnFace(f.x, f.y, mirrored, rotationDeg);
    const reach = f.shape.type === 'ring' ? f.shape.rOuter : Math.hypot(f.shape.width, f.shape.height) / 2;
    radius = Math.max(radius, Math.hypot(p.x - cx, p.y - cy) + reach);
  }
  return { cx, cy, radius, fontSize };
}

/** Least spacing between end-face terminal labels, in font sizes: two labels never read as one stack. */
export const END_FACE_LABEL_GAP = 2.2;

/** Leader start: mid-wall of the element, on the side facing its label. */
function featureAnchor(f: SectionFeature, angle: number): { x: number; y: number } {
  if (f.shape.type === 'web') return { x: f.x, y: f.y };
  const mid = (f.shape.rOuter + f.shape.rInner) / 2;
  return { x: f.x + mid * Math.cos(angle), y: f.y + mid * Math.sin(angle) };
}

function reticle(f: SectionFeature, span: number): string {
  const r = (f.shape.type === 'ring' ? f.shape.rOuter : Math.max(f.shape.width, f.shape.height) / 2) + span * 0.02;
  const tick = span * 0.025;
  const ticks = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) =>
    `M${n(f.x + dx! * r)} ${n(f.y + dy! * r)}L${n(f.x + dx! * (r + tick))} ${n(f.y + dy! * (r + tick))}`).join('');
  const d = `${circle(f.x, f.y, r)}${ticks}`;
  return `<g data-selected="true" fill="none"><path d="${d}" stroke="#ffffff" stroke-width="${n(span / 90)}"/><path d="${d}" stroke="#2f7df6" stroke-width="${n(span / 220)}" stroke-dasharray="${n(span / 60)} ${n(span / 120)}"/></g>`;
}

function stripeArc(f: SectionFeature, color: string): string {
  if (f.shape.type !== 'ring') return '';
  const mid = (f.shape.rOuter + f.shape.rInner) / 2, wall = f.shape.rOuter - f.shape.rInner;
  const a0 = -Math.PI / 2 - 0.45, a1 = -Math.PI / 2 + 0.45;
  const p = (a: number): string => `${n(f.x + mid * Math.cos(a))} ${n(f.y + mid * Math.sin(a))}`;
  return `<path data-stripe="true" d="M${p(a0)}A${n(mid)} ${n(mid)} 0 0 1 ${p(a1)}" fill="none" stroke="${color}" stroke-width="${n(wall * 0.55)}" stroke-linecap="butt"/>`;
}

export function renderSectionSvg(section: Section, title: string, options: SectionSvgOptions = {}): string {
  const bounds = options.view ? viewBounds(section, options.view.mirrored, options.view.rotationDeg) : section.bounds;
  const span = bounds === null ? 4 : Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1);
  const pad = span * 0.7;
  const minX = (bounds?.minX ?? -2) - pad;
  const minY = (bounds?.minY ?? -2) - pad;
  const width = (bounds === null ? 4 : bounds.maxX - bounds.minX) + 2 * pad;
  const height = (bounds === null ? 4 : bounds.maxY - bounds.minY) + 2 * pad;
  const prefix = options.idPrefix ?? `sx${hash(`${title}|${section.features.map(f => `${f.path}${f.x}${f.y}${f.color}${f.material}`).join(',')}`)}`;
  const sorted = [...section.features].sort((a, b) => {
    const size = (f: SectionFeature): number => f.shape.type === 'ring' ? f.shape.rOuter : 0;
    return size(b) - size(a);
  });
  const defs: string[] = [finishDefs(prefix)];
  const parts = sorted.map((f, index) => {
    const look = appearanceOf(f);
    const d = shapePath(f);
    const radius = f.shape.type === 'ring' ? f.shape.rOuter : Math.min(f.shape.width, f.shape.height) / 2;
    const t = Math.min(Math.max(radius / 2.5, span / 300), span / 25);
    let texture = '';
    if (look.texture !== 'none' && look.texture !== 'solid-metal' && look.texture !== 'foil') {
      const id = `${prefix}-t${index}`;
      defs.push(textureDef(id, look.texture, look.base, t));
      texture = `<path d="${d}" fill="url(#${id})" fill-rule="evenodd"/>`;
    }
    const sheen = `<path d="${d}" fill="url(#${prefix}-f-${FINISH_FILL[look.finish]})" fill-rule="evenodd"/>`;
    const edge = `<path d="${d}" fill="none" stroke="${edgeColor(look.base)}" stroke-width="${n(span / 400)}" fill-rule="evenodd"/>`;
    const stripe = look.stripe ? stripeArc(f, look.stripe) : '';
    return `<g data-element="${esc(f.path)}" data-kind="${f.kind}" data-fill-source="${look.fillSource}" data-material-family="${look.family}" data-texture="${look.texture}" data-finish="${look.finish}"><path d="${d}" fill="${look.base}" fill-rule="evenodd"/>${texture}${sheen}${stripe}${edge}</g>`;
  });
  const selected = options.selected ? section.features.find(f => f.path === options.selected) : undefined;
  if (selected) parts.push(reticle(selected, span));
  const frame = options.view ?? { mirrored: false, rotationDeg: 0 };
  const ring = calloutRing(section, frame.mirrored, frame.rotationDeg, span);
  const calloutStroke = n(span / 180);
  if (options.callouts !== false && !options.view) {
    const items: CalloutItem[] = [];
    for (const row of section.rows) {
      const f = section.features.find(item => item.path === row.path);
      if (f === undefined) continue;
      items.push({ key: row.path, x: f.x, y: f.y, chars: row.tag.length, anchor: angle => featureAnchor(f, angle) });
    }
    const tags = new Map(section.rows.map(r => [r.path, r.tag]));
    for (const c of layoutCallouts(items, ring)) {
      parts.push(`<g data-callout="${esc(c.key)}" color="currentColor"><path d="M${n(c.anchor.x)} ${n(c.anchor.y)}L${n(c.end.x)} ${n(c.end.y)}" stroke="currentColor" stroke-width="${calloutStroke}" fill="none"/><circle cx="${n(c.anchor.x)}" cy="${n(c.anchor.y)}" r="${n(span / 140)}" fill="currentColor"/><text x="${n(c.text.x)}" y="${n(c.text.y)}" font-size="${n(ring.fontSize)}" fill="currentColor" text-anchor="${c.text.anchor}">${esc(tags.get(c.key) ?? '')}</text></g>`);
    }
  }
  const unknownFills = section.features.filter(f => appearanceOf(f).fillSource === 'unknown').length;
  const body = options.view
    ? `<g data-view="end-face" transform="rotate(${n(-options.view.rotationDeg)}) scale(${options.view.mirrored ? -1 : 1} 1)">${parts.join('')}</g>`
    : parts.join('');
  const markerR = span * 0.014;
  const placed = layoutCallouts((options.markers ?? []).map(m => ({ key: m.tag, x: m.x, y: m.y, chars: m.tag.length })), { ...ring, minLabelGap: ring.fontSize * END_FACE_LABEL_GAP });
  const markers = (options.markers ?? []).map(m => {
    const fill = m.role === 'conductor' ? '#ffffff' : m.role === 'shield' ? '#cfd6dd' : '#e9d3b0';
    const c = placed.find(p => p.key === m.tag)!;
    return `<g data-terminal="${esc(m.tag)}" data-role="${m.role}" color="currentColor"><path d="M${n(m.x)} ${n(m.y)}L${n(c.end.x)} ${n(c.end.y)}" stroke="currentColor" stroke-width="${calloutStroke}" fill="none"/><circle cx="${n(m.x)}" cy="${n(m.y)}" r="${n(markerR)}" fill="${fill}" stroke="#14181d" stroke-width="${n(span / 300)}"/><text x="${n(c.text.x)}" y="${n(c.text.y)}" font-size="${n(ring.fontSize)}" text-anchor="${c.text.anchor}" fill="currentColor" font-weight="600">${esc(m.tag)}</text></g>`;
  }).join('');
  const description = (section.unknown.length > 0 ? `Incomplete geometry: ${section.unknown.join('; ')}` :
    `${n(section.widthMm!)} × ${n(section.heightMm!)} mm. ${section.features.length} material elements. Viewed from ${section.viewedFrom}.`)
    + (unknownFills > 0 ? ` ${unknownFills} element${unknownFills === 1 ? '' : 's'} drawn hatched because color or material is not recorded.` : '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(minX)} ${n(minY)} ${n(width)} ${n(height)}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><desc>${esc(description)}</desc><defs>${defs.join('')}</defs>${body}${markers}</svg>`;
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
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(-size)} ${n(-2 * size)} ${n(5 * size)} ${n(3.5 * size)}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><desc>Axonometric stock preview. Axial length compressed for display; extrusion length ${geometry.lengthMm} mm. No stripping or bonds.</desc>${pieces.join('')}<g>${section.features.map(f => { const look = appearanceOf(f); return `<path d="${shapePath(f)}" fill="${look.base}" fill-rule="evenodd" stroke="${edgeColor(look.base)}" stroke-width="${n(size / 400)}"/>`; }).join('')}</g></svg>`;
}

/** Convenience wrapper: draw an end face with terminal markers. */
export function renderEndFaceSvg(face: import('./end-face').EndFace, title: string, options: Pick<SectionSvgOptions, 'selected' | 'idPrefix'> = {}): string {
  return renderSectionSvg(face.section, title, { ...options, callouts: false,
    view: { mirrored: face.mirrored, rotationDeg: face.rotationDeg },
    markers: face.terminals.map(t => ({ x: t.x, y: t.y, tag: t.tag, role: t.role })) });
}
