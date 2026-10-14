// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Colour and material appearance of stock elements.
 *
 * The shield-construction vocabulary (braid, spiral, tape, foil drawn as distinct
 * textures) follows cab-stu packages/render-svg/src/cross-section.ts at commit
 * 6bbf79655deb572df9f11490ca38e4f739ce71fb (MIT, formless63); see NOTICE.
 *
 * Appearance is display only. A recorded colour is drawn as recorded. A metal's
 * typical colour may stand in for an unrecorded colour of that metal, and is
 * labelled as such. An unrecorded polymer colour or unrecorded material is never
 * guessed: it is drawn as an explicit "unknown" hatch.
 */
import type { SectionFeature } from './model';

export type MaterialFamily =
  | 'copper' | 'tinned-copper' | 'silver-plated-copper' | 'nickel-plated-copper' | 'copper-clad-aluminium'
  | 'aluminium' | 'steel' | 'aluminium-foil'
  | 'pvc' | 'polyethylene' | 'foam-polyethylene' | 'fluoropolymer' | 'silicone' | 'polyurethane'
  | 'elastomer' | 'polypropylene' | 'nylon' | 'polyester-film' | 'polyimide' | 'paper' | 'textile'
  | 'unrecognized' | 'unrecorded';
export type Finish = 'metal' | 'foil' | 'gloss' | 'satin' | 'matt' | 'foam' | 'fibre' | 'unknown';
export type Texture = 'strands' | 'solid-metal' | 'braid' | 'spiral' | 'tape' | 'foil' | 'foam' | 'fibre' | 'none' | 'unknown';
export type FillSource = 'recorded' | 'conventional-name' | 'material-typical' | 'kind-neutral' | 'unknown';

export interface Appearance {
  /** Always a safe #rrggbb value. */
  base: string;
  fillSource: FillSource;
  /** Tracer stripe from a "base/stripe" colour; always a safe #rrggbb value. */
  stripe?: string;
  family: MaterialFamily;
  finish: Finish;
  texture: Texture;
  /** Physically based hints for the 3D viewer. */
  metalness: number;
  roughness: number;
  clearcoat: number;
  materialLabel: string;
  colorLabel: string;
  /** Plain statements of what is not recorded or only conventional. */
  notes: string[];
}

/** Conventional insulation colours; a recorded name is drawn as this conventional hue. */
export const NAMED_COLORS: Readonly<Record<string, string>> = {
  black: '#1b1b1d', brown: '#6b4423', red: '#c62828', orange: '#e8741c', yellow: '#f2c20f',
  green: '#1f8a3d', blue: '#1f5fbf', violet: '#7a3fa0', purple: '#7a3fa0', grey: '#8a9096', gray: '#8a9096',
  white: '#f4f4f0', pink: '#e58ab0', turquoise: '#2bb5b0', tan: '#c8a97a', natural: '#e9e4d0', clear: '#dfe7ea',
  gold: '#c9a227', silver: '#c0c4c8', copper: '#b87333',
};
const HEX = /^#([0-9a-f]{6})$/i;
const SHORT_HEX = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;

function parseOne(raw: string): { hex: string; named: boolean } | null {
  const text = raw.trim().toLowerCase();
  if (HEX.test(text)) return { hex: text, named: false };
  const short = SHORT_HEX.exec(text);
  if (short) return { hex: `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`, named: false };
  const named = NAMED_COLORS[text];
  return named ? { hex: named, named: true } : null;
}
export type ColorResolution =
  | { status: 'known'; hex: string; stripe?: string; named: boolean; label: string }
  | { status: 'unknown'; reason: 'unrecorded' | 'unparseable'; label: string };

/** Accepts #rgb, #rrggbb, conventional names and "base/stripe". Anything else is unknown, never guessed. */
export function resolveColor(raw: string | null | undefined): ColorResolution {
  if (raw == null || raw.trim() === '') return { status: 'unknown', reason: 'unrecorded', label: 'Unknown' };
  const parts = raw.split('/');
  if (parts.length > 2) return { status: 'unknown', reason: 'unparseable', label: 'Unknown' };
  const base = parseOne(parts[0]!);
  const stripe = parts[1] === undefined ? null : parseOne(parts[1]);
  if (!base || (parts[1] !== undefined && !stripe)) return { status: 'unknown', reason: 'unparseable', label: 'Unknown' };
  return { status: 'known', hex: base.hex, named: base.named || (stripe?.named ?? false),
    ...(stripe ? { stripe: stripe.hex } : {}), label: parts.map(p => p.trim().toLowerCase()).join(' / ') };
}

interface FamilySpec { label: string; metal: boolean; typical?: string; finish: Finish; metalness: number; roughness: number; clearcoat: number }
const SPEC: Record<MaterialFamily, FamilySpec> = {
  'copper': { label: 'Copper', metal: true, typical: '#b87333', finish: 'metal', metalness: 1, roughness: 0.32, clearcoat: 0 },
  'tinned-copper': { label: 'Tinned copper', metal: true, typical: '#c3c8cb', finish: 'metal', metalness: 1, roughness: 0.38, clearcoat: 0 },
  'silver-plated-copper': { label: 'Silver-plated copper', metal: true, typical: '#d5d8db', finish: 'metal', metalness: 1, roughness: 0.28, clearcoat: 0 },
  'nickel-plated-copper': { label: 'Nickel-plated copper', metal: true, typical: '#aeb2b4', finish: 'metal', metalness: 1, roughness: 0.34, clearcoat: 0 },
  'copper-clad-aluminium': { label: 'Copper-clad aluminium', metal: true, typical: '#b87333', finish: 'metal', metalness: 1, roughness: 0.36, clearcoat: 0 },
  'aluminium': { label: 'Aluminium', metal: true, typical: '#c9ced3', finish: 'metal', metalness: 1, roughness: 0.4, clearcoat: 0 },
  'steel': { label: 'Steel', metal: true, typical: '#9aa0a6', finish: 'metal', metalness: 1, roughness: 0.36, clearcoat: 0 },
  'aluminium-foil': { label: 'Aluminium foil', metal: true, typical: '#d2d7dc', finish: 'foil', metalness: 1, roughness: 0.25, clearcoat: 0 },
  'pvc': { label: 'PVC', metal: false, finish: 'satin', metalness: 0, roughness: 0.45, clearcoat: 0.15 },
  'polyethylene': { label: 'Polyethylene', metal: false, finish: 'satin', metalness: 0, roughness: 0.5, clearcoat: 0.05 },
  'foam-polyethylene': { label: 'Foam polyethylene', metal: false, finish: 'foam', metalness: 0, roughness: 0.92, clearcoat: 0 },
  'fluoropolymer': { label: 'Fluoropolymer', metal: false, finish: 'satin', metalness: 0, roughness: 0.35, clearcoat: 0.1 },
  'silicone': { label: 'Silicone', metal: false, finish: 'matt', metalness: 0, roughness: 0.8, clearcoat: 0 },
  'polyurethane': { label: 'Polyurethane', metal: false, finish: 'gloss', metalness: 0, roughness: 0.3, clearcoat: 0.3 },
  'elastomer': { label: 'Rubber / elastomer', metal: false, finish: 'matt', metalness: 0, roughness: 0.85, clearcoat: 0 },
  'polypropylene': { label: 'Polypropylene', metal: false, finish: 'satin', metalness: 0, roughness: 0.5, clearcoat: 0.05 },
  'nylon': { label: 'Nylon', metal: false, finish: 'satin', metalness: 0, roughness: 0.45, clearcoat: 0.05 },
  'polyester-film': { label: 'Polyester film', metal: false, finish: 'gloss', metalness: 0, roughness: 0.25, clearcoat: 0.3 },
  'polyimide': { label: 'Polyimide', metal: false, finish: 'gloss', metalness: 0, roughness: 0.3, clearcoat: 0.2 },
  'paper': { label: 'Paper', metal: false, finish: 'fibre', metalness: 0, roughness: 0.95, clearcoat: 0 },
  'textile': { label: 'Textile / fibre', metal: false, finish: 'fibre', metalness: 0, roughness: 0.95, clearcoat: 0 },
  'unrecognized': { label: 'Unrecognized', metal: false, finish: 'unknown', metalness: 0, roughness: 0.6, clearcoat: 0 },
  'unrecorded': { label: 'Unknown', metal: false, finish: 'unknown', metalness: 0, roughness: 0.6, clearcoat: 0 },
};

/** Ordered: specific before general. Words are matched on lower-cased free text. */
const RULES: [RegExp, MaterialFamily][] = [
  [/copper[- ]?clad[- ]?alumin|\bcca\b/, 'copper-clad-aluminium'],
  [/tinned|tin[- ]?plated|\bsn[- ]?cu\b/, 'tinned-copper'],
  [/silver|\bag[- ]?cu\b/, 'silver-plated-copper'],
  [/nickel|\bni[- ]?cu\b/, 'nickel-plated-copper'],
  [/(alumin(i)?um|\bal\b).*(foil|mylar|laminate|tape)|(foil|mylar|laminate).*(alumin(i)?um|\bal\b)/, 'aluminium-foil'],
  [/\bcopper\b|\bcu\b|\bofc\b|\betp\b/, 'copper'],
  [/alumin(i)?um|\bal\b/, 'aluminium'],
  [/steel|stainless/, 'steel'],
  [/foam|cellular|gas[- ]?injected/, 'foam-polyethylene'],
  [/ptfe|teflon|\bfep\b|\bpfa\b|\betfe\b|fluoro/, 'fluoropolymer'],
  [/polyimide|kapton/, 'polyimide'],
  [/polyester|\bpet\b|mylar/, 'polyester-film'],
  [/\bpvc\b|polyvinyl|vinyl/, 'pvc'],
  [/xlpe|\bpe\b|\bhdpe\b|\bldpe\b|polyethyl|polythene/, 'polyethylene'],
  [/silicone/, 'silicone'],
  [/polyurethane|\bpur\b|\btpu\b/, 'polyurethane'],
  [/\btpe\b|\btpr\b|rubber|epdm|neoprene|chloroprene|elastomer|santoprene/, 'elastomer'],
  [/polypropylene|\bpp\b/, 'polypropylene'],
  [/nylon|polyamide/, 'nylon'],
  [/paper/, 'paper'],
  [/cotton|textile|fibre|fiber|yarn|aramid|kevlar|glass|cord|braid(ed)? (yarn|thread)/, 'textile'],
];
export function classifyMaterial(material: string | null | undefined): MaterialFamily {
  if (material == null || material.trim() === '') return 'unrecorded';
  const text = material.toLowerCase();
  return RULES.find(([pattern]) => pattern.test(text))?.[1] ?? 'unrecognized';
}

const CONDUCTIVE = new Set<SectionFeature['kind']>(['conductor', 'drain', 'shield']);
function textureFor(feature: { kind: SectionFeature['kind']; construction?: SectionFeature['construction'] }, spec: FamilySpec, metalLike: boolean): Texture {
  if (feature.kind === 'shield') {
    if (feature.construction === 'braid' || feature.construction === 'spiral' || feature.construction === 'tape' || feature.construction === 'foil') return feature.construction;
    return metalLike ? (spec.finish === 'foil' ? 'foil' : 'solid-metal') : 'unknown';
  }
  if (feature.kind === 'conductor' || feature.kind === 'drain') {
    if (!metalLike) return 'unknown';
    return feature.construction === "stranded" ? 'strands' : 'solid-metal';
  }
  if (spec.finish === 'foam') return 'foam';
  if (spec.finish === 'fibre') return 'fibre';
  return spec.finish === 'unknown' ? 'unknown' : 'none';
}

/** The resolved display appearance of one stock element. */
export function appearanceOf(feature: { kind: SectionFeature['kind']; color?: string | null; material?: string | null } & { construction?: SectionFeature['construction'] }): Appearance {
  const family = classifyMaterial(feature.material);
  let spec = SPEC[family];
  const color = resolveColor(feature.color);
  const notes: string[] = [];
  const conductive = CONDUCTIVE.has(feature.kind);
  // An unrecorded material on a conducting element is still metallic; only its hue is unknown.
  const metalLike = spec.metal || (conductive && (family === 'unrecorded' || family === 'unrecognized') && feature.kind !== 'shield')
    || (feature.kind === 'shield' && (family === 'unrecorded' || family === 'unrecognized'));
  if (!spec.metal && metalLike) spec = { ...spec, finish: 'metal', metalness: 0.9, roughness: 0.4 };
  if (family === 'unrecorded') notes.push('material not recorded');
  if (family === 'unrecognized') notes.push(`material "${feature.material}" not recognized for appearance`);
  let base: string; let fillSource: FillSource; let stripe: string | undefined;
  if (color.status === 'known') {
    base = color.hex; fillSource = color.named ? 'conventional-name' : 'recorded'; stripe = color.stripe;
    if (color.named) notes.push('named colour drawn in its conventional hue');
  } else {
    if (color.reason === 'unparseable') notes.push(`colour "${feature.color}" not understood`); else notes.push('colour not recorded');
    if (spec.metal && spec.typical) { base = spec.typical; fillSource = 'material-typical'; notes.push(`drawn in the typical colour of ${spec.label.toLowerCase()}`); }
    else if (metalLike) { base = '#a9afb6'; fillSource = 'kind-neutral'; notes.push('metal hue unknown; neutral metallic shown'); }
    else { base = '#d9dde2'; fillSource = 'unknown'; }
  }
  const texture = textureFor(feature, spec, metalLike);
  return { base, fillSource, ...(stripe ? { stripe } : {}), family, finish: spec.finish, texture,
    metalness: spec.metalness, roughness: spec.roughness, clearcoat: spec.clearcoat,
    materialLabel: family === 'unrecorded' ? 'Unknown' : feature.material!.trim(),
    colorLabel: color.label, notes };
}

/** True when nothing but the structural kind determined the drawn fill. */
export const isUnknownFill = (a: Appearance): boolean => a.fillSource === 'unknown';

/* ---- colour arithmetic (display only) ---- */
function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}
export function mixHex(a: string, b: string, t: number): string {
  const x = channels(a), y = channels(b);
  return `#${x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, '0')).join('')}`;
}
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** Edge line that stays visible for both near-black and near-white fills. */
export const edgeColor = (hex: string): string => luminance(hex) < 0.02 ? mixHex(hex, '#ffffff', 0.45) : mixHex(hex, '#000000', 0.5);
