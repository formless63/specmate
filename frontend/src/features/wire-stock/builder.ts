/**
 * Construction builder: a small, typed description of common cable families that
 * generates the stored version 1 structure tree. Positions are computed (centerd
 * lay-up, ring radius from the core diameters, drains in an interstice against the
 * first screen); nothing new is stored. A saved stock reopens in the builder only
 * when regenerating its read-back description reproduces the stored tree exactly.
 *
 * Unknown stays unknown: a dimension that depends on an unknown input is null, and a
 * position that depends on one is null (unknown), never zero.
 */
import type { Fact, GroupElement, RoundElement, StockElement, StockSpecification, WebElement } from '../../../../packages/section-layout/src';

export type Known = number | null;
export type TemplateKind = 'coax' | 'round' | 'pairs' | 'ribbon' | 'figure-eight' | 'multicoax';
export type ShieldKind = 'none' | 'foil' | 'braid' | 'foil+braid';
export interface CoreLook { label: string; color: string | null }
/** Multi-coax bundle: N identical coax units (center material and color come from `conductor`), plus optional plain `cores`. */
export interface MultiCoax {
  center_mm: Known;
  dielectric_od_mm: Known;
  dielectric_material: string | null;
  /** Each coax's own screen. */
  screen: 'none' | 'foil' | 'braid';
  screen_material: string | null;
  screen_thickness_mm: Known;
  /** Optional own jacket on each coax; its outer diameter, or null when unknown. */
  jacket: boolean;
  jacket_od_mm: Known;
  jacket_material: string | null;
  /** One per coax: label and identifying color (own jacket color, else dielectric color). */
  looks: CoreLook[];
}
export interface BuilderSpec {
  template: TemplateKind;
  /** Applied to every generated element; null is an unrecorded source. */
  source: string | null;
  conductor: { diameter_mm: Known; area_mm2: Known; construction: 'solid' | 'stranded' | null; material: string | null; color: string | null };
  /** Core insulation, or the coax dielectric. */
  insulation: { od_mm: Known; material: string | null };
  /** One per core: round N, pairs 2 per pair, ribbon N, figure-eight 2, coax 1. */
  cores: CoreLook[];
  /** Used only by the multi-coax template. */
  multi: MultiCoax;
  /** Ribbon and figure-eight center spacing; null means touching cores. */
  spacing_mm: Known;
  web_thickness_mm: Known;
  filler: boolean;
  shield: ShieldKind;
  shield_material: string | null;
  foil_thickness_mm: Known;
  braid_thickness_mm: Known;
  drain: boolean;
  drain_diameter_mm: Known;
  jacket: { od_mm: Known; wall_mm: Known; material: string | null; color: string | null };
}

export const TEMPLATES: { value: TemplateKind; label: string; hint: string }[] = [
  { value: 'coax', label: 'Coax', hint: 'Center conductor, dielectric, screen, jacket' },
  { value: 'round', label: 'Multi-core round cable', hint: 'N insulated cores, optional filler, screen and drain, jacket' },
  { value: 'pairs', label: 'Twisted pair(s)', hint: 'Pairs of insulated cores, optional screen and drain, jacket' },
  { value: 'ribbon', label: 'Ribbon', hint: 'N insulated cores side by side at a pitch, joined by a web' },
  { value: 'multicoax', label: 'Multi-coax bundle', hint: 'N coax units (center, dielectric, screen, optional own jacket) with optional plain cores, optional overall screen, jacket' },
  { value: 'figure-eight', label: 'Figure-eight', hint: 'Two insulated cores joined by a web' },
];
export const hasJacket = (t: TemplateKind) => t === 'coax' || t === 'round' || t === 'pairs' || t === 'multicoax';
export const hasDrain = (t: TemplateKind) => t === 'round' || t === 'pairs';
export const hasWeb = (t: TemplateKind) => t === 'ribbon' || t === 'figure-eight';

/** Conventional insulation color sequence (a quick choice only; every color is editable and none is applied unless chosen). */
const CORE_COLORS = ['#d62728', '#1f1f1f', '#f2d21b', '#1f5fbf', '#2e8b3a', '#8b5a2b', '#7f7f7f', '#f2f2f2', '#ff7f0e', '#8e44ad'];
const PAIR_COLORS: [string, string][] = [['#1f5fbf', '#f2f2f2'], ['#ff7f0e', '#f2f2f2'], ['#2e8b3a', '#f2f2f2'], ['#8b5a2b', '#f2f2f2']];
export type ColorCode = 'unknown' | 'sequence';
const COLOR_NAMES: Record<string, string> = { '#d62728': 'red', '#1f1f1f': 'black', '#f2d21b': 'yellow', '#1f5fbf': 'blue', '#2e8b3a': 'green', '#8b5a2b': 'brown',
  '#7f7f7f': 'gray', '#f2f2f2': 'white', '#ff7f0e': 'orange', '#8e44ad': 'violet', '#303030': 'black' };
/** A plain color name for the quick-choice colors, otherwise the recorded value itself. */
export const colorName = (hex: string): string => COLOR_NAMES[hex.toLowerCase()] ?? hex;
/** Core labels, with colors unknown unless a color code is chosen. */
export function coreLooks(template: TemplateKind, count: number, code: ColorCode = 'unknown'): CoreLook[] {
  const on = code === 'sequence';
  if (template === 'coax') return [{ label: 'Center', color: null }];
  if (template === 'pairs') return Array.from({ length: count * 2 }, (_, i) => {
    const pair = Math.floor(i / 2) + 1;
    return { label: `Pair ${pair} ${i % 2 ? 'B' : 'A'}`, color: on ? PAIR_COLORS[(pair - 1) % PAIR_COLORS.length]![i % 2]! : null };
  });
  return Array.from({ length: count }, (_, i) => ({ label: `Core ${i + 1}`, color: on ? CORE_COLORS[i % CORE_COLORS.length]! : null }));
}

export function coaxLooks(count: number, code: ColorCode = 'unknown'): CoreLook[] {
  return Array.from({ length: count }, (_, i) => ({ label: `Coax ${i + 1}`, color: code === 'sequence' ? CORE_COLORS[i % CORE_COLORS.length]! : null }));
}
const blankMulti = (n = 2): MultiCoax => ({ center_mm: null, dielectric_od_mm: null, dielectric_material: null, screen: 'braid', screen_material: null,
  screen_thickness_mm: null, jacket: false, jacket_od_mm: null, jacket_material: null, looks: coaxLooks(n) });
/** The name shown for a coax unit: its label and, when recorded, its color. */
export const coaxName = (look: CoreLook): string => look.color ? `${look.label} (${colorName(look.color)})` : look.label;
/** Outer diameter of one coax unit as built: own jacket, else screened dielectric, else dielectric. */
export function coaxOd(m: MultiCoax): Known {
  if (m.jacket) return m.jacket_od_mm;
  return m.screen === 'none' ? m.dielectric_od_mm : add(m.dielectric_od_mm, mul(m.screen_thickness_mm, 2));
}
/** Lay-up unit: the largest unit, so the ring is conservative when coax and plain cores differ in size. Unknown if any needed size is. */
export function multiUnit(spec: BuilderSpec): Known {
  const sizes = [coaxOd(spec.multi), ...(spec.cores.length ? [spec.insulation.od_mm] : [])];
  return sizes.some(v => v === null) ? null : Math.max(...(sizes as number[]));
}

export function blankSpec(template: TemplateKind, count?: number): BuilderSpec {
  const n = count ?? (template === 'multicoax' ? 0 : template === 'round' ? 2 : template === 'pairs' ? 1 : template === 'ribbon' ? 4 : template === 'figure-eight' ? 2 : 1);
  return {
    template, source: null,
    conductor: { diameter_mm: null, area_mm2: null, construction: null, material: null, color: null },
    insulation: { od_mm: null, material: null }, cores: coreLooks(template, n), multi: blankMulti(2), spacing_mm: null, web_thickness_mm: null,
    filler: false, shield: template === 'coax' ? 'braid' : 'none', shield_material: null, foil_thickness_mm: null, braid_thickness_mm: null,
    drain: false, drain_diameter_mm: null,
    jacket: { od_mm: null, wall_mm: null, material: null, color: hasJacket(template) ? '#303030' : null },
  };
}

/** Builder counterpart of the original synthetic coax fixture (3 mm overall, four layers). */
export function exampleCoax(): BuilderSpec {
  return { ...blankSpec('coax'), source: 'Original synthetic arithmetic fixture',
    conductor: { diameter_mm: 1, area_mm2: null, construction: null, material: null, color: null },
    insulation: { od_mm: 2, material: null }, braid_thickness_mm: 0.2,
    jacket: { od_mm: 3, wall_mm: null, material: null, color: '#222222' } };
}

// --- conductor sizing -------------------------------------------------------------

/** Solid-equivalent diameter of an AWG size: 0.127 mm x 92^((36 - n) / 39). */
export const awgDiameterMm = (awg: number): number => 0.127 * Math.pow(92, (36 - awg) / 39);
export const awgAreaMm2 = (awg: number): number => Math.PI / 4 * awgDiameterMm(awg) ** 2;
export const areaDiameterMm = (area: number): number => Math.sqrt(4 * area / Math.PI);
/** The whole AWG size whose nominal area matches within 0.5 %, if any (display only). */
export function awgForArea(area: number | null): number | null {
  if (area === null) return null;
  for (let n = 0; n <= 40; n++) if (Math.abs(awgAreaMm2(n) - area) / area < 0.005) return n;
  return null;
}
const round4 = (v: number): number => Number(v.toFixed(4));

// --- lay-up geometry --------------------------------------------------------------

const add = (a: Known, b: Known): Known => a === null || b === null ? null : a + b;
const mul = (a: Known, k: number): Known => a === null ? null : a * k;
const rounded = (v: Known): Known => v === null ? null : round4(v);

export interface Layup {
  /** Diameter of each laid unit (core, or pair envelope). */
  unit: Known;
  count: number;
  arrangement: GroupElement['arrangement'];
  /** Group pitch as stored: ring diameter (ring) or center spacing (linear). */
  pitch: Known;
  /** Radius from the cable axis to unit centers. */
  ringRadius: Known;
  /** Radius of the circle enclosing the lay-up. */
  outerRadius: Known;
}
export function layup(unit: Known, count: number): Layup {
  if (count <= 1) return { unit, count, arrangement: 'concentric', pitch: null, ringRadius: 0, outerRadius: mul(unit, 0.5) };
  const ringRadius = unit === null ? null : unit / (2 * Math.sin(Math.PI / count));
  const linear = count === 2;
  return { unit, count, arrangement: linear ? 'linear' : 'ring', pitch: linear ? unit : mul(ringRadius, 2), ringRadius,
    outerRadius: add(ringRadius, mul(unit, 0.5)) };
}

/** Drain center in the interstice after the first unit, touching the first screen where it can. */
export function drainPlacement(l: Layup, drainDiameter: Known): { x: Known; y: Known; boreRadius: Known } {
  if (l.unit === null || l.ringRadius === null || l.outerRadius === null || drainDiameter === null) return { x: null, y: null, boreRadius: null };
  const rd = drainDiameter / 2, ru = l.unit / 2, R = l.ringRadius;
  let rho: number, angle: number;
  if (l.count <= 1) { rho = ru + rd; angle = -Math.PI / 2; } else {
    const half = Math.PI / l.count;
    // Tangent to both neighboring units, then outward along the bisector to the lay-up circle.
    const tangent = R * Math.cos(half) + Math.sqrt((ru + rd) ** 2 - (R * Math.sin(half)) ** 2);
    rho = Math.max(tangent, l.outerRadius - rd);
    // Linear pairs lie along x, so their interstice is at 12 o'clock; rings place unit 0 at 12 o'clock.
    angle = l.count === 2 ? -Math.PI / 2 : -Math.PI / 2 - half;
  }
  return { x: round4(rho * Math.cos(angle)), y: round4(rho * Math.sin(angle)), boreRadius: Math.max(l.outerRadius, rho + rd) };
}

// --- generation ---------------------------------------------------------------------

const DEFAULT_FACTS: Record<string, Fact> = {
  voltage_rating: { value: null, unit: 'V', source: null, status: 'unknown' },
  impedance: { value: null, unit: 'ohm', source: null, status: 'unknown' },
};

function base(spec: BuilderSpec, id: string, label: string) {
  return { id, label, material: null as string | null, color: null as string | null, source: spec.source, x_mm: 0 as number | null, y_mm: 0 as number | null };
}
function round(spec: BuilderSpec, id: string, label: string, kind: RoundElement['kind'], od: Known, inner: Known,
  extra: Partial<RoundElement> = {}): RoundElement {
  return { ...base(spec, id, label), kind, outer_diameter_mm: rounded(od), inner_diameter_mm: rounded(inner), construction: null, area_mm2: null, ...extra };
}
function group(spec: BuilderSpec, id: string, label: string, role: GroupElement['role'], arrangement: GroupElement['arrangement'],
  pitch: Known, children: StockElement[]): GroupElement {
  return { ...base(spec, id, label), kind: 'group', role, arrangement, pitch_mm: arrangement === 'concentric' ? null : rounded(pitch), direction: 'ccw', children };
}
function core(spec: BuilderSpec, id: string, look: CoreLook): GroupElement {
  const c = spec.conductor;
  return group(spec, id, look.label, 'bundle', 'concentric', null, [
    round(spec, 'conductor', look.label, 'conductor', c.diameter_mm, 0, { material: c.material, color: c.color, construction: c.construction, area_mm2: c.area_mm2 }),
    round(spec, 'insulation', `${look.label} insulation`, 'insulation', spec.insulation.od_mm, c.diameter_mm, { material: spec.insulation.material, color: look.color }),
  ]);
}
/** Screen layers from `bore` outward; returns the layers and the resulting outer diameter. */
function screens(spec: BuilderSpec, bore: Known): { layers: RoundElement[]; outer: Known } {
  const layers: RoundElement[] = [];
  let current = bore;
  if (spec.shield === 'foil' || spec.shield === 'foil+braid') {
    const od = add(current, mul(spec.foil_thickness_mm, 2));
    layers.push(round(spec, 'foil', spec.shield === 'foil' ? 'Screen' : 'Foil screen', 'shield', od, current, { construction: 'foil', material: spec.shield === 'foil' ? spec.shield_material : null }));
    current = od;
  }
  if (spec.shield === 'braid' || spec.shield === 'foil+braid') {
    const od = add(current, mul(spec.braid_thickness_mm, 2));
    layers.push(round(spec, 'braid', spec.shield === 'braid' ? 'Screen' : 'Braid screen', 'shield', od, current, { construction: 'braid', material: spec.shield_material }));
    current = od;
  }
  return { layers, outer: current };
}
function jacket(spec: BuilderSpec, content: Known): RoundElement {
  const { od_mm: od, wall_mm: wall, material, color } = spec.jacket;
  // Entered outer diameter and wall define the bore; otherwise the jacket fits the content.
  // A bore at or beyond the entered outer diameter cannot be real: it stays unknown.
  const fitted = od === null || (content !== null && content < od) ? content : null;
  const inner = od !== null && wall !== null ? od - 2 * wall : fitted;
  const outer = od !== null ? od : add(content, mul(wall, 2));
  return round(spec, 'jacket', 'Jacket', 'jacket', outer, inner, { material, color });
}

export function generate(spec: BuilderSpec, keep?: Pick<StockSpecification, 'viewed_from' | 'facts'>): StockSpecification {
  const children: StockElement[] = [];
  const t = spec.template;
  let construction: StockSpecification['construction'] = 'bundle';
  let rootArrangement: GroupElement['arrangement'] = 'concentric';
  let rootPitch: Known = null;
  if (t === 'coax') {
    construction = 'coax';
    const c = spec.conductor;
    children.push(round(spec, 'center', 'Center conductor', 'conductor', c.diameter_mm, 0, { material: c.material, color: c.color, construction: c.construction, area_mm2: c.area_mm2 }));
    children.push(round(spec, 'dielectric', 'Dielectric', 'dielectric', spec.insulation.od_mm, c.diameter_mm, { material: spec.insulation.material, color: spec.cores[0]?.color ?? null }));
    const s = screens(spec, spec.insulation.od_mm);
    children.push(...s.layers, jacket(spec, s.outer));
  } else if (t === 'multicoax') {
    const m = spec.multi;
    const coaxes = m.looks.map((look, i) => {
      const name = coaxName(look);
      const parts: RoundElement[] = [
        round(spec, 'center', `${name} center`, 'conductor', m.center_mm, 0, { material: spec.conductor.material, color: spec.conductor.color, construction: spec.conductor.construction, area_mm2: spec.conductor.area_mm2 }),
        round(spec, 'dielectric', `${name} dielectric`, 'dielectric', m.dielectric_od_mm, m.center_mm, { material: m.dielectric_material, color: m.jacket ? null : look.color }),
      ];
      let outer = m.dielectric_od_mm;
      if (m.screen !== 'none') {
        outer = add(outer, mul(m.screen_thickness_mm, 2));
        parts.push(round(spec, 'screen', `${name} screen`, 'shield', outer, m.dielectric_od_mm, { construction: m.screen, material: m.screen_material }));
      }
      if (m.jacket) parts.push(round(spec, 'jacket', `${name} jacket`, 'jacket', m.jacket_od_mm, outer, { material: m.jacket_material, color: look.color }));
      return group(spec, `coax-${i + 1}`, look.label, 'bundle', 'concentric', null, parts);
    });
    const plain = spec.cores.map((look, i) => core(spec, `core-${i + 1}`, look));
    const units = [...coaxes, ...plain];
    const lay = layup(multiUnit(spec), units.length);
    children.push(group(spec, 'units', 'Units', 'bundle', lay.arrangement, lay.pitch, units));
    const s = screens(spec, mul(lay.outerRadius, 2));
    children.push(...s.layers, jacket(spec, s.outer));
  } else if (t === 'round' || t === 'pairs') {
    const pairs = t === 'pairs';
    const units: GroupElement[] = pairs
      ? Array.from({ length: spec.cores.length / 2 }, (_, p) => group(spec, `pair-${p + 1}`, `Pair ${p + 1}`, 'pair', 'linear', spec.insulation.od_mm,
        [core(spec, 'core-a', spec.cores[2 * p]!), core(spec, 'core-b', spec.cores[2 * p + 1]!)]))
      : spec.cores.map((look, i) => core(spec, `core-${i + 1}`, look));
    construction = pairs && units.length === 1 ? 'pair' : 'bundle';
    // A single pair lays out as its two cores; several pairs lay out by their envelopes.
    const lay = pairs && units.length === 1 ? layup(spec.insulation.od_mm, 2) : layup(pairs ? mul(spec.insulation.od_mm, 2) : spec.insulation.od_mm, units.length);
    const laid = pairs && units.length === 1 ? units : [group(spec, pairs ? 'pairs' : 'cores', pairs ? 'Pairs' : 'Cores', 'bundle', lay.arrangement, lay.pitch, units)];
    children.push(...laid);
    if (!pairs && spec.filler && units.length >= 3) {
      const od = lay.ringRadius === null || lay.unit === null ? null : 2 * lay.ringRadius - lay.unit;
      if (od === null || od > 0) children.push(round(spec, 'filler', 'Center filler', 'filler', od, 0));
    }
    let bore = mul(lay.outerRadius, 2);
    if (spec.drain) {
      const d = drainPlacement(lay, spec.drain_diameter_mm);
      // An unknown lay-up leaves the drain's position unknown (null offsets), never centerd.
      children.push({ ...round(spec, 'drain', 'Drain', 'drain', spec.drain_diameter_mm, 0, { material: spec.shield_material, construction: null }), x_mm: d.x, y_mm: d.y });
      bore = d.boreRadius === null ? null : 2 * d.boreRadius;
    }
    const s = screens(spec, bore);
    children.push(...s.layers, jacket(spec, s.outer));
  } else {
    construction = t;
    const touching = spec.insulation.od_mm;
    rootPitch = spec.spacing_mm ?? touching;
    rootArrangement = t === 'ribbon' ? 'linear' : 'figure-eight';
    const ids = t === 'ribbon' ? spec.cores.map((_, i) => `core-${i + 1}`) : ['leg-a', 'leg-b'];
    spec.cores.forEach((look, i) => children.push(core(spec, ids[i]!, look)));
    const web: WebElement = { ...base(spec, 'web', 'Web'), kind: 'web', material: spec.insulation.material,
      width_mm: rounded(mul(rootPitch, t === 'ribbon' ? spec.cores.length - 1 : 1)), height_mm: spec.web_thickness_mm };
    children.push(web);
  }
  const structure: GroupElement = { ...group(spec, 'stock', 'Stock', 'stock', rootArrangement, rootPitch, children) };
  return { schema_version: '1', construction, viewed_from: keep?.viewed_from ?? 'unknown', structure, facts: keep?.facts ?? structuredClone(DEFAULT_FACTS) };
}

// --- read back --------------------------------------------------------------------------

type Node = StockElement;
const child = (g: GroupElement | undefined, id: string): Node | undefined => g?.children.find(c => c.id === id);
const centerOf = (g: GroupElement | undefined): Node | undefined => child(g, 'center');
const asRound = (n: Node | undefined): RoundElement | undefined => n && n.kind !== 'group' && n.kind !== 'web' ? n : undefined;
const asGroup = (n: Node | undefined): GroupElement | undefined => n?.kind === 'group' ? n : undefined;
const half = (od: Known, inner: Known): Known => od === null || inner === null ? null : Number(((od - inner) / 2).toFixed(9));

function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-9;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).filter(k => (a as Record<string, unknown>)[k] !== undefined);
    const kb = Object.keys(b).filter(k => (b as Record<string, unknown>)[k] !== undefined);
    return ka.length === kb.length && ka.every(k => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
}

/** The builder description that regenerates `stock` exactly, or null when it was edited element by element. */
/** Stocks saved before the American spelling pass use the element id 'centre'; read them as 'center'. */
function currentIds(node: StockElement): StockElement {
  const renamed = node.id === 'centre' ? { ...node, id: 'center' } : node;
  return renamed.kind === 'group' ? { ...renamed, children: renamed.children.map(currentIds) } : renamed;
}

export function readBuilder(saved: StockSpecification): BuilderSpec | null {
  const stock = { ...saved, structure: currentIds(saved.structure) as StockSpecification['structure'] };
  const root = stock.structure;
  const ids = root.children.map(c => c.id);
  let template: TemplateKind;
  let cores: GroupElement[];
  if (ids.includes('center') && ids.includes('dielectric')) { template = 'coax'; cores = []; }
  else if (ids.includes('units')) { template = 'multicoax'; cores = ((asGroup(child(root, 'units'))?.children ?? []) as GroupElement[]).filter(c => c.id.startsWith('core-')); }
  else if (ids.includes('leg-a')) { template = 'figure-eight'; cores = [asGroup(child(root, 'leg-a')), asGroup(child(root, 'leg-b'))].filter(Boolean) as GroupElement[]; }
  else if (stock.construction === 'ribbon') { template = 'ribbon'; cores = root.children.filter(c => c.kind === 'group') as GroupElement[]; }
  else if (ids.includes('cores')) { template = 'round'; cores = (asGroup(child(root, 'cores'))?.children ?? []) as GroupElement[]; }
  else if (ids.includes('pairs') || ids.includes('pair-1')) {
    template = 'pairs';
    const pairs = (ids.includes('pairs') ? asGroup(child(root, 'pairs'))?.children ?? [] : [child(root, 'pair-1')]) as GroupElement[];
    cores = pairs.flatMap(p => [asGroup(child(p, 'core-a')), asGroup(child(p, 'core-b'))]).filter(Boolean) as GroupElement[];
  } else return null;
  const coaxGroups = template === 'multicoax' ? ((asGroup(child(root, 'units'))?.children ?? []) as GroupElement[]).filter(c => c.id.startsWith('coax-')) : [];
  const c1 = coaxGroups[0];
  const conductor = template === 'multicoax' ? (cores.length ? asRound(child(cores[0], 'conductor')) : asRound(centerOf(c1))) : template === 'coax' ? asRound(child(root, 'center')) : asRound(child(cores[0], 'conductor'));
  const insulation = template === 'multicoax' ? (cores.length ? asRound(child(cores[0], 'insulation')) : asRound(child(c1, 'dielectric')))
    : template === 'coax' ? asRound(child(root, 'dielectric')) : asRound(child(cores[0], 'insulation'));
  if (!conductor || !insulation || (template !== 'coax' && template !== 'multicoax' && cores.length === 0) || (template === 'multicoax' && coaxGroups.length === 0)) return null;
  const cScreen = asRound(child(c1, 'screen')), cJacket = asRound(child(c1, 'jacket'));
  const multi: MultiCoax = template === 'multicoax' ? {
    center_mm: asRound(centerOf(c1))?.outer_diameter_mm ?? null,
    dielectric_od_mm: asRound(child(c1, 'dielectric'))?.outer_diameter_mm ?? null,
    dielectric_material: asRound(child(c1, 'dielectric'))?.material ?? null,
    screen: cScreen?.construction === 'foil' ? 'foil' : cScreen ? 'braid' : 'none',
    screen_material: cScreen?.material ?? null,
    screen_thickness_mm: cScreen ? half(cScreen.outer_diameter_mm, cScreen.inner_diameter_mm) : null,
    jacket: !!cJacket, jacket_od_mm: cJacket?.outer_diameter_mm ?? null, jacket_material: cJacket?.material ?? null,
    looks: coaxGroups.map(g => ({ label: g.label, color: asRound(child(g, 'jacket'))?.color ?? asRound(child(g, 'dielectric'))?.color ?? null })),
  } : blankMulti();
  const foil = asRound(child(root, 'foil')), braid = asRound(child(root, 'braid'));
  const drain = asRound(child(root, 'drain')), jacketNode = asRound(child(root, 'jacket'));
  const web = child(root, 'web');
  const spec: BuilderSpec = {
    template, source: root.source,
    conductor: { diameter_mm: conductor.outer_diameter_mm, area_mm2: conductor.area_mm2,
      construction: conductor.construction === 'solid' || conductor.construction === 'stranded' ? conductor.construction : null,
      material: conductor.material, color: conductor.color },
    insulation: { od_mm: insulation.outer_diameter_mm, material: insulation.material }, multi,
    cores: template === 'coax' ? [{ label: 'Center', color: insulation.color }]
      : cores.map(c => ({ label: c.label, color: asRound(child(c, 'insulation'))?.color ?? null })),
    spacing_mm: hasWeb(template) && root.pitch_mm !== insulation.outer_diameter_mm ? root.pitch_mm : null,
    web_thickness_mm: web?.kind === 'web' ? web.height_mm : null,
    filler: ids.includes('filler'),
    shield: foil && braid ? 'foil+braid' : foil ? 'foil' : braid ? 'braid' : 'none',
    shield_material: braid?.material ?? foil?.material ?? (drain?.material ?? null),
    foil_thickness_mm: foil ? half(foil.outer_diameter_mm, foil.inner_diameter_mm) : null,
    braid_thickness_mm: braid ? half(braid.outer_diameter_mm, braid.inner_diameter_mm) : null,
    drain: !!drain, drain_diameter_mm: drain?.outer_diameter_mm ?? null,
    jacket: { od_mm: jacketNode?.outer_diameter_mm ?? null,
      wall_mm: jacketNode && jacketNode.outer_diameter_mm !== null ? half(jacketNode.outer_diameter_mm, jacketNode.inner_diameter_mm) : null,
      material: jacketNode?.material ?? null, color: jacketNode?.color ?? null },
  };
  const again = generate(spec, stock);
  return same(again.structure, root) && again.construction === stock.construction ? spec : null;
}

// --- illustration ---------------------------------------------------------------------

/**
 * A drawable copy of an incomplete builder description: unknown dimensions take
 * placeholder proportions so the arrangement can be seen. Never saved; the caller
 * labels the drawing illustrative and lists what was substituted.
 */
export function illustrate(spec: BuilderSpec): { spec: BuilderSpec; substituted: string[] } {
  const s = structuredClone(spec);
  const substituted: string[] = [];
  const fill = (value: Known, placeholder: number, what: string): number => {
    if (value !== null) return value;
    substituted.push(what);
    return round4(placeholder);
  };
  if (s.template === 'multicoax') {
    const m = s.multi;
    m.dielectric_od_mm = fill(m.dielectric_od_mm, 1.2, 'coax dielectric diameter');
    m.center_mm = fill(m.center_mm, m.dielectric_od_mm * 0.4, 'coax center diameter');
    if (m.screen !== 'none') m.screen_thickness_mm = fill(m.screen_thickness_mm, m.dielectric_od_mm * 0.08, 'coax screen thickness');
    if (m.jacket) m.jacket_od_mm = fill(m.jacket_od_mm, (add(m.dielectric_od_mm, mul(m.screen === 'none' ? 0 : m.screen_thickness_mm, 2)) ?? 1.4) * 1.2, 'coax jacket diameter');
    if (s.cores.length) {
      s.insulation.od_mm = fill(s.insulation.od_mm, 1, 'core insulation diameter');
      s.conductor.diameter_mm = fill(s.conductor.diameter_mm, s.insulation.od_mm * 0.5, 'core conductor diameter');
    }
    if (s.shield === 'foil' || s.shield === 'foil+braid') s.foil_thickness_mm = fill(s.foil_thickness_mm, 0.05, 'foil thickness');
    if (s.shield === 'braid' || s.shield === 'foil+braid') s.braid_thickness_mm = fill(s.braid_thickness_mm, 0.15, 'braid thickness');
    if (s.jacket.od_mm === null && s.jacket.wall_mm === null) { s.jacket.wall_mm = 0.4; substituted.push('jacket wall'); }
    return { spec: s, substituted };
  }
  const d0 = s.conductor.diameter_mm, i0 = s.insulation.od_mm;
  const insulation = fill(i0, d0 !== null ? d0 * 1.8 : 1.2, s.template === 'coax' ? 'dielectric diameter' : 'insulation diameter');
  s.insulation.od_mm = insulation;
  s.conductor.diameter_mm = fill(d0, insulation * 0.5, 'conductor diameter');
  if (s.shield === 'foil' || s.shield === 'foil+braid') s.foil_thickness_mm = fill(s.foil_thickness_mm, insulation * 0.03, 'foil thickness');
  if (s.shield === 'braid' || s.shield === 'foil+braid') s.braid_thickness_mm = fill(s.braid_thickness_mm, insulation * 0.08, 'braid thickness');
  if (s.drain && hasDrain(s.template)) s.drain_diameter_mm = fill(s.drain_diameter_mm, insulation * 0.3, 'drain diameter');
  if (hasWeb(s.template)) s.web_thickness_mm = fill(s.web_thickness_mm, insulation * 0.3, 'web thickness');
  if (hasJacket(s.template) && s.jacket.od_mm === null && s.jacket.wall_mm === null) {
    s.jacket.wall_mm = insulation * 0.25; substituted.push('jacket wall');
  }
  return { spec: s, substituted };
}
