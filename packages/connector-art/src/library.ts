/**
 * The connector face library: each family's mating face as data.
 *
 * Every face is authored once in one gender's mating-face view; the partner gender is
 * its left-right mirror. Pin numbering and layouts come from published connector
 * standards and documentation; outlines are simplified illustrations and say so in
 * `verification`. Nothing here is traced from a vendor drawing.
 */

import { mirrorGeometry, type ConnectorGeometry, type Gender, type Keyway, type Layer, type PinGeometry, type Point, type Verification } from './geometry';

const GENERIC_SOURCE = 'Geometry from published connector standards and documentation; simplified outline.';

const deg = (a: number): number => (a * Math.PI) / 180;
/** a point on a circle, angle measured clockwise from 12 o'clock */
const polar = (r: number, angle: number, cy = 0): Point => [round(r * Math.sin(deg(angle))), round(cy - r * Math.cos(deg(angle)))];
const round = (v: number): number => Math.round(v * 1000) / 1000;

interface Base extends Omit<ConnectorGeometry, 'key' | 'gender'> {
  /** the authored gender; the other is mirrored */
  authored: Exclude<Gender, 'ungendered'>;
}

/** Both genders of a face: `<base>-male` and `<base>-female`. */
function pair(base: string, face: Base): ConnectorGeometry[] {
  const { authored, ...rest } = face;
  const other: Exclude<Gender, 'ungendered'> = authored === 'male' ? 'female' : 'male';
  const own: ConnectorGeometry = { ...rest, key: `${base}-${authored}`, gender: authored };
  const mirrored: ConnectorGeometry = {
    ...mirrorGeometry(own),
    key: `${base}-${other}`,
    gender: other,
    numbering: `Mirror image of the ${authored} face. ${rest.numbering}`,
  };
  return authored === 'male' ? [own, mirrored] : [mirrored, own];
}

const pins = (positions: Record<string, Point>, shape: PinGeometry['shape'], size: PinGeometry['size']): PinGeometry[] =>
  Object.entries(positions).map(([id, at]) => ({ id, at, shape, size }));

/* ------------------------------------------------------------------ *
 * Mini-DIN (9.5 mm shield). Positions are socket (female) mating-face views with the
 * single top notch up; a plug face is the mirror.
 * ------------------------------------------------------------------ */

const MINI_DIN_SHIELD = 9.5;
const MINI_DIN_INSERT = 8.4;

/** lower skirt notches at 135 and 225 degrees, and the round top notch */
function miniDinNotches(top: 'notch' | 'flat' | 'none'): Keyway[] {
  const out: Keyway[] = [
    { kind: 'notch', shape: { kind: 'circle', center: polar(4.2, 135), d: 1.55 }, note: 'lower right skirt notch' },
    { kind: 'notch', shape: { kind: 'circle', center: polar(4.2, 225), d: 1.55 }, note: 'lower left skirt notch' },
  ];
  if (top === 'notch') out.push({ kind: 'notch', shape: { kind: 'circle', center: [0, -4.2], d: 1.65 }, note: 'top skirt notch' });
  if (top === 'flat') out.push({ kind: 'flat', shape: { kind: 'rect', center: [0, -3.95], w: 3.4, h: 0.9 }, note: 'flat at the top of the insert' });
  return out;
}

function miniDin(n: number, positions: Record<string, Point>, options: { key?: { center: Point; w: number; h: number }; top: 'notch' | 'flat' | 'none'; numbering: string; verification: Verification; pinD?: number; extraKeyways?: Keyway[]; label?: string }): Base {
  const keyways = [...miniDinNotches(options.top), ...(options.extraKeyways ?? [])];
  if (options.key) keyways.push({ kind: 'key', shape: { kind: 'rect', center: options.key.center, w: options.key.w, h: options.key.h }, note: 'rectangular plastic key' });
  return {
    authored: 'female',
    label: options.label ?? `Mini-DIN ${n}`,
    family: 'mini-din',
    pinCount: n,
    outline: { kind: 'circle', d: MINI_DIN_SHIELD },
    layers: [{ shape: { kind: 'circle', d: MINI_DIN_INSERT }, tone: 'insert' }],
    keyways,
    pins: [...pins(positions, 'round', options.pinD ?? 0.94), { id: 'shell', at: polar(MINI_DIN_SHIELD / 2, 90), shape: 'ring', size: [0.6, 1.2], role: 'shell' }],
    numbering: options.numbering,
    source: GENERIC_SOURCE,
    verification: options.verification,
  };
}

// Standard grid (socket view): lower row y 2.55, middle row y 0.37, top row y -1.82.
const MD_RULE = 'Socket view, notch up: rows numbered from the bottom row upward, each row right to left (a plug numbers each row left to right).';
const VERIFIED_SCALED: Verification = { numbering: 'verified', positions: 'scaled', note: 'Positions scaled from published diagrams; outline simplified.' };

const MINI_DIN: Record<number, Base> = {
  3: miniDin(3, { '1': [2.74, 0.37], '2': [-2.74, 0.37], '3': [0, -1.82] }, { top: 'notch', key: { center: [0, 1.58], w: 1.49, h: 2.0 }, numbering: MD_RULE, verification: VERIFIED_SCALED }),
  4: miniDin(4, { '1': [2.74, 0.37], '2': [-2.74, 0.37], '3': [2.19, -1.82], '4': [-2.19, -1.82] }, { top: 'notch', key: { center: [0, 2.92], w: 2.4, h: 1.35 }, numbering: MD_RULE, verification: VERIFIED_SCALED }),
  5: miniDin(5, { '1': [1.12, 2.55], '2': [2.74, 0.37], '3': [-2.74, 0.37], '4': [2.19, -1.82], '5': [-2.19, -1.82] }, {
    top: 'notch',
    key: { center: [0, 0], w: 1.32, h: 1.98 },
    numbering: MD_RULE,
    verification: { numbering: 'single-source', positions: 'scaled', note: 'Numbering follows the family rule (pin 1 lowest); not independently confirmed for this pattern.' },
  }),
  6: miniDin(6, { '1': [1.12, 2.55], '2': [-1.12, 2.55], '3': [2.74, 0.37], '4': [-2.74, 0.37], '5': [2.19, -1.82], '6': [-2.19, -1.82] }, { top: 'notch', key: { center: [0, -0.95], w: 1.49, h: 2.65 }, numbering: MD_RULE, verification: VERIFIED_SCALED }),
  7: miniDin(7, { '1': [1.12, 2.55], '2': [-1.12, 2.55], '3': [2.74, 0.37], '4': [-2.74, 0.37], '5': [2.19, -1.82], '6': [0, -1.82], '7': [-2.19, -1.82] }, { top: 'notch', key: { center: [0, -0.15], w: 2.06, h: 1.05 }, numbering: MD_RULE, verification: VERIFIED_SCALED }),
  8: miniDin(8, { '1': [1.12, 2.55], '2': [-1.12, 2.55], '3': [2.74, 0.37], '4': [0.33, 0.37], '5': [-2.74, 0.37], '6': [2.19, -1.82], '7': [0, -1.82], '8': [-2.19, -1.82] }, { top: 'notch', numbering: MD_RULE, verification: VERIFIED_SCALED }),
  // Nine: 3 top (a gap between the second and third), 4 middle, 2 bottom.
  9: miniDin(9, { '1': [0.98, 2.53], '2': [-0.82, 2.53], '3': [2.81, 0.37], '4': [0.98, 0.37], '5': [-0.82, 0.37], '6': [-2.62, 0.37], '7': [1.99, -1.82], '8': [-0.82, -1.82], '9': [-2.2, -1.82] }, {
    top: 'flat',
    numbering: MD_RULE,
    verification: { numbering: 'verified', positions: 'scaled', note: 'Numbering agrees across references; the side of the top-row gap differs between published drawings and is approximate.' },
  }),
  // Ten (the nonstandard 10-pin pattern): 3 top with a gap, 4 middle, 3 on the bottom tab.
  10: miniDin(10, { '1': [1.33, 2.5], '2': [0, 2.5], '3': [-1.33, 2.5], '4': [2.25, 0.33], '5': [0.75, 0.33], '6': [-0.75, 0.33], '7': [-2.25, 0.33], '8': [2.08, -1.83], '9': [-0.42, -1.83], '10': [-2.08, -1.83] }, {
    top: 'none',
    pinD: 0.9,
    extraKeyways: [
      { kind: 'notch', shape: { kind: 'rect', center: [-3.3, 3.0], w: 1.9, h: 2.8 }, note: 'lower left shoulder beside the bottom tab' },
      { kind: 'notch', shape: { kind: 'rect', center: [3.3, 3.0], w: 1.9, h: 2.8 }, note: 'lower right shoulder beside the bottom tab' },
    ],
    numbering: 'Socket view, bottom tab down: bottom row 3-2-1, middle row 7-6-5-4, top row 10-9-8, each left to right (a plug is mirrored).',
    verification: { numbering: 'verified', positions: 'scaled', note: 'Three-row 3/4/3 layout and numbering agree across independent references; nonstandard pattern, outline simplified. Ground is the shell.' },
  }),
};

/* ------------------------------------------------------------------ *
 * Full-size DIN (13.2 mm shield, contacts on a 7.0 mm circle), socket view, key notch down.
 * ------------------------------------------------------------------ */

const DIN_SHIELD = 13.2;
const DIN_RULE = 'Socket view, notch down: the arc numbered 1-4-2-5-3 from left to right (a plug numbers it right to left).';

function din(label: string, positions: Record<string, Point>, numbering: string, verification: Verification): Base {
  return {
    authored: 'female',
    label,
    family: 'din',
    pinCount: Object.keys(positions).length,
    outline: { kind: 'circle', d: DIN_SHIELD },
    layers: [{ shape: { kind: 'circle', d: 11.2 }, tone: 'insert' }],
    keyways: [{ kind: 'notch', shape: { kind: 'circle', center: [0, 6.0], d: 2.2 }, note: 'shield key notch' }],
    pins: [...pins(positions, 'round', 1.0), { id: 'shell', at: polar(DIN_SHIELD / 2, 270), shape: 'ring', size: [0.7, 1.4], role: 'shell' }],
    numbering,
    source: GENERIC_SOURCE,
    verification,
  };
}

const arc = (ids: readonly string[], angles: readonly number[]): Record<string, Point> => Object.fromEntries(ids.map((id, i) => [id, polar(3.5, angles[i] as number)]));

const DIN_5_180 = din('DIN 5 (180°)', arc(['1', '4', '2', '5', '3'], [-90, -45, 0, 45, 90]), DIN_RULE, { numbering: 'verified', positions: 'nominal' });
const DIN_5_240 = din('DIN 5 (240°)', arc(['1', '4', '2', '5', '3'], [-120, -60, 0, 60, 120]), DIN_RULE, {
  numbering: 'single-source',
  positions: 'nominal',
  note: 'Uses the general DIN 1-4-2-5-3 order; not independently confirmed for the 240° pattern.',
});
const DIN8_ORDER = ['6', '1', '4', '2', '5', '3', '7'];
const DIN8_RULE = 'Socket view, notch down: the arc numbered 6-1-4-2-5-3-7 from left to right, 8 in the middle (a plug is mirrored).';
const DIN_8_270 = din('DIN 8 (270°)', { ...arc(DIN8_ORDER, [-135, -90, -45, 0, 45, 90, 135]), '8': [0, 1.07] }, DIN8_RULE, {
  numbering: 'verified',
  positions: 'scaled',
  note: 'Center contact offset toward the notch as in published drawings (scaled).',
});
const DIN_8_262 = din(
  'DIN 8 (262°)',
  { '6': [-3.54, 2.49], '1': [-3.5, 0], '4': polar(3.5, -45), '2': [0, -3.5], '5': polar(3.5, 45), '3': [3.5, 0], '7': [3.54, 2.49], '8': [0, 1.07] },
  DIN8_RULE,
  { numbering: 'verified', positions: 'scaled', note: 'The two lowest contacts sit below the side contacts (horseshoe); not interchangeable with the 270° pattern.' },
);

/* ------------------------------------------------------------------ *
 * SCART / JP21: same 21-way shell. Socket view, long axis horizontal, cut corner at the
 * pin 20/21 end on the odd row.
 * ------------------------------------------------------------------ */

function scart(label: string, family: string, verification: Verification): Base {
  const positions: PinGeometry[] = [];
  for (let k = 0; k < 10; k += 1) positions.push({ id: String(20 - 2 * k), at: [-18 + 4 * k, -2.4], shape: 'blade', size: [2.4, 0.9] });
  for (let k = 0; k < 10; k += 1) positions.push({ id: String(19 - 2 * k), at: [-16 + 4 * k, 2.4], shape: 'blade', size: [2.4, 0.9] });
  positions.push({ id: '21', at: [-20.4, 2.4], shape: 'blade', size: [0.9, 2.0], role: 'shell' });
  positions.push({ id: 'shell', at: [24, 0], shape: 'ring', size: [0.6, 1.2], role: 'shell' });
  return {
    authored: 'female',
    label,
    family,
    pinCount: 21,
    outline: { kind: 'rect', w: 48, h: 15.5, r: 0.8, chamfers: { bl: [3.0, 6.0] } },
    layers: [{ shape: { kind: 'rect', w: 45.6, h: 13.1, r: 0.5, chamfers: { bl: [2.6, 5.2] } }, tone: 'insert' }],
    keyways: [{ kind: 'chamfer', shape: { kind: 'path', d: 'M-24 1.75 L-24 7.75 L-21 7.75 Z' }, note: 'cut corner at the pin 20/21 end' }],
    pins: positions,
    numbering: 'Socket view: even contacts 20 to 2 along the top row, odd contacts 19 to 1 along the bottom row (offset half a pitch), contact 21 at the cut corner; a plug is mirrored and carries 21 on its shell.',
    source: GENERIC_SOURCE,
    verification,
  };
}

/* ------------------------------------------------------------------ *
 * D-subminiature, plug (male) view, wide row up.
 * ------------------------------------------------------------------ */

interface DsubSpec {
  rows: number[];
  shift?: number[];
  pitch: number;
  rowGap: number;
  flange: number;
  holes: number;
  highDensity: boolean;
}

function dsub(label: string, spec: DsubSpec, verification: Verification): Base {
  const out: PinGeometry[] = [];
  let next = 1;
  const rowsN = spec.rows.length;
  let reach = 0;
  spec.rows.forEach((n, row) => {
    const y = round((row - (rowsN - 1) / 2) * spec.rowGap);
    for (let i = 0; i < n; i += 1) {
      const x = round((i - (n - 1) / 2 + (spec.shift?.[row] ?? 0)) * spec.pitch);
      reach = Math.max(reach, Math.abs(x));
      out.push({ id: String(next), at: [x, y], shape: 'round', size: spec.highDensity ? 0.8 : 1.0 });
      next += 1;
    }
  });
  const halfAcross = ((rowsN - 1) / 2) * spec.rowGap + (spec.highDensity ? 2.0 : 2.3);
  const top = 2 * (reach + (spec.highDensity ? 2.3 : 2.6));
  const bottom = top - 2 * Math.tan(deg(10)) * 2 * halfAcross;
  out.push({ id: 'shell', at: [spec.holes / 2, 0], shape: 'ring', size: [1.6, 3.0], role: 'shell' });
  return {
    authored: 'male',
    label,
    family: 'd-sub',
    pinCount: next - 1,
    outline: { kind: 'rect', w: spec.flange, h: 12.5, r: 1.0 },
    layers: [
      { shape: { kind: 'trapezoid', top: round(top), bottom: round(bottom), h: round(2 * halfAcross), r: 0.8 }, tone: 'shell' },
      { shape: { kind: 'trapezoid', top: round(top - 1.4), bottom: round(bottom - 1.1), h: round(2 * halfAcross - 1.4), r: 0.6 }, tone: 'insert' },
      { shape: { kind: 'circle', center: [-spec.holes / 2, 0], d: 3.1 }, tone: 'hole' },
      { shape: { kind: 'circle', center: [spec.holes / 2, 0], d: 3.1 }, tone: 'hole' },
    ],
    keyways: [{ kind: 'key', shape: { kind: 'path', d: `M${round(-top / 2)} ${round(-halfAcross)} L${round(top / 2)} ${round(-halfAcross)} L${round(bottom / 2)} ${round(halfAcross)} L${round(-bottom / 2)} ${round(halfAcross)} Z` }, note: 'D-shaped shell, wide side up' }],
    pins: out,
    numbering: 'Plug view, wide row up: rows numbered from the top row down, each left to right (a socket numbers each row right to left).',
    source: GENERIC_SOURCE,
    verification,
  };
}

const DSUB_STD: Verification = { numbering: 'verified', positions: 'nominal', note: 'Contact pitch and row spacing nominal; shell outline simplified.' };

/* ------------------------------------------------------------------ *
 * Coaxial and audio ends (end-on views).
 * ------------------------------------------------------------------ */

const RCA: Base = {
  authored: 'female',
  label: 'RCA',
  family: 'rca',
  pinCount: 2,
  outline: { kind: 'circle', d: 8.3 },
  layers: [{ shape: { kind: 'circle', d: 6.2 }, tone: 'insert' }],
  keyways: [],
  pins: [
    { id: 'tip', at: [0, 0], shape: 'round', size: 3.2 },
    { id: 'sleeve', at: [0, -3.6], shape: 'ring', size: [0.6, 1.2], role: 'shell' },
  ],
  numbering: 'Center contact (tip) and outer sleeve; no numbered positions.',
  source: GENERIC_SOURCE,
  verification: { numbering: 'not-applicable', positions: 'approximate' },
};

const BNC: Base = {
  authored: 'female',
  label: 'BNC',
  family: 'bnc',
  pinCount: 2,
  outline: { kind: 'circle', d: 9.6 },
  layers: [{ shape: { kind: 'circle', d: 6.6 }, tone: 'insert' }],
  keyways: [
    { kind: 'latch', shape: { kind: 'circle', center: [-5.3, 0], d: 1.4 }, note: 'bayonet stud' },
    { kind: 'latch', shape: { kind: 'circle', center: [5.3, 0], d: 1.4 }, note: 'bayonet stud' },
  ],
  pins: [
    { id: 'center', at: [0, 0], shape: 'round', size: 1.4 },
    { id: 'shield', at: [0, -4.15], shape: 'ring', size: [0.6, 1.2], role: 'shell' },
  ],
  numbering: 'Center contact and outer shield; no numbered positions.',
  source: GENERIC_SOURCE,
  verification: { numbering: 'not-applicable', positions: 'approximate' },
};

function phone(label: string, ids: string[], ringsMm: [number, number][]): Base {
  return {
    authored: 'male',
    label,
    family: 'phone-3.5',
    pinCount: ids.length,
    outline: { kind: 'circle', d: 3.5 },
    layers: [],
    keyways: [],
    pins: ids.map((id, i) => {
      const [inner, outer] = ringsMm[i] as [number, number];
      return inner === 0 ? { id, at: [0, 0] as Point, shape: 'round' as const, size: outer } : { id, at: [0, 0] as Point, shape: 'ring' as const, size: [inner, outer] as const };
    }),
    numbering: 'End-on schematic: contacts are bands along the plug axis, drawn as concentric rings from the tip (center) to the sleeve (outside).',
    source: GENERIC_SOURCE,
    verification: { numbering: 'verified', positions: 'approximate', note: 'Contact order only; band lengths and diameters are not drawn to scale.' },
  };
}

/* ------------------------------------------------------------------ *
 * Wire-to-board headers: header (male) top view, pin 1 left.
 * ------------------------------------------------------------------ */

function header(label: string, family: string, n: number, pitch: number, body: { w: number; h: number; cy: number }, verification: Verification): Base {
  const x0 = -((n - 1) * pitch) / 2;
  return {
    authored: 'male',
    label,
    family,
    pinCount: n,
    outline: { kind: 'rect', center: [0, body.cy], w: body.w, h: body.h, r: 0.3 },
    layers: [{ shape: { kind: 'rect', center: [0, body.cy], w: body.w - 1.0, h: body.h - 1.4, r: 0.2 }, tone: 'cavity' }],
    keyways: [{ kind: 'key', shape: { kind: 'rect', center: [0, round(body.cy - body.h / 2 + 0.35)], w: Math.max(1.2, body.w - 3.4), h: 0.7 }, note: 'polarizing wall slot' }],
    pins: Array.from({ length: n }, (_, i) => ({ id: String(i + 1), at: [round(x0 + i * pitch), 0] as Point, shape: 'square' as const, size: 0.64 })),
    numbering: 'Header view: positions numbered 1 to n from left to right (a mating housing is mirrored).',
    source: GENERIC_SOURCE,
    verification,
  };
}

function dupont(rows: 1 | 2, cols: number): Base {
  const pitch = 2.54;
  const out: PinGeometry[] = [];
  for (let c = 0; c < cols; c += 1) {
    for (let r = 0; r < rows; r += 1) {
      const id = rows === 1 ? String(c + 1) : String(c * 2 + r + 1);
      out.push({ id, at: [round((c - (cols - 1) / 2) * pitch), round((r - (rows - 1) / 2) * pitch)], shape: 'square', size: 0.64 });
    }
  }
  return {
    authored: 'male',
    label: `2.54 mm header ${rows}×${cols}`,
    family: 'pin-header-2.54',
    pinCount: rows * cols,
    outline: { kind: 'rect', w: cols * pitch, h: rows * pitch, r: 0.2 },
    layers: [],
    keyways: [{ kind: 'chamfer', shape: { kind: 'path', d: `M${round((-cols * pitch) / 2)} ${round((-rows * pitch) / 2)} L${round((-cols * pitch) / 2 + 0.8)} ${round((-rows * pitch) / 2)} L${round((-cols * pitch) / 2)} ${round((-rows * pitch) / 2 + 0.8)} Z` }, note: 'pin 1 corner mark' }],
    pins: out,
    numbering: rows === 1 ? 'Header view: 1 to n from left to right.' : 'Header view: odd positions along the top row and even positions along the bottom row, pin 1 at the top left.',
    source: GENERIC_SOURCE,
    verification: { numbering: 'verified', positions: 'nominal', note: 'Generic 2.54 mm pitch; pin 1 marking varies by manufacturer.' },
  };
}

/* ------------------------------------------------------------------ *
 * USB receptacle outlines (contacts not drawn).
 * ------------------------------------------------------------------ */

function outlineOnly(label: string, family: string, shape: ConnectorGeometry['outline'], inner: Layer[]): Base {
  return {
    authored: 'female',
    label,
    family,
    pinCount: 0,
    outline: shape,
    layers: inner,
    keyways: [],
    pins: [],
    numbering: 'Outline only; contact positions are not drawn.',
    source: GENERIC_SOURCE,
    verification: { numbering: 'not-applicable', positions: 'approximate' },
    outlineOnly: true,
  };
}

/* ------------------------------------------------------------------ *
 * The library
 * ------------------------------------------------------------------ */

const ENTRIES: ConnectorGeometry[] = [
  ...[3, 4, 5, 6, 7, 8, 9, 10].flatMap((n) => pair(`mini-din-${n}`, MINI_DIN[n] as Base)),
  ...pair('s-video', { ...(MINI_DIN[4] as Base), label: 'S-Video (Mini-DIN 4)', family: 's-video' }),
  ...pair('din-5-180', DIN_5_180),
  ...pair('din-5-240', DIN_5_240),
  ...pair('din-8-262', DIN_8_262),
  ...pair('din-8-270', DIN_8_270),
  ...pair('scart', scart('SCART', 'scart', { numbering: 'verified', positions: 'approximate', note: 'Numbering and cut-corner side agree across references; dimensions approximate.' })),
  ...pair('jp21', scart('JP21', 'jp21', { numbering: 'single-source', positions: 'approximate', note: 'Same physical shell and contact numbering as SCART; the signal assignment differs.' })),
  ...pair('de-9', dsub('DE-9', { rows: [5, 4], pitch: 2.77, rowGap: 2.84, flange: 30.81, holes: 24.99, highDensity: false }, DSUB_STD)),
  ...pair('da-15', dsub('DA-15', { rows: [8, 7], pitch: 2.77, rowGap: 2.84, flange: 39.14, holes: 33.32, highDensity: false }, DSUB_STD)),
  ...pair('db-25', dsub('DB-25', { rows: [13, 12], pitch: 2.77, rowGap: 2.84, flange: 53.04, holes: 47.04, highDensity: false }, DSUB_STD)),
  ...pair(
    'de-15-hd',
    dsub('DE-15 (high density)', { rows: [5, 5, 5], shift: [0, -0.5, 0], pitch: 2.29, rowGap: 1.98, flange: 30.81, holes: 24.99, highDensity: true }, {
      numbering: 'verified',
      positions: 'nominal',
      note: 'Middle row offset half a pitch; the offset direction is single-source.',
    }),
  ),
  ...pair('rca', RCA),
  ...pair('bnc', BNC),
  ...pair('trs-3.5', phone('3.5 mm TRS', ['tip', 'ring', 'sleeve'], [[0, 1.2], [1.6, 2.4], [2.8, 3.5]])),
  ...pair('trrs-3.5', phone('3.5 mm TRRS', ['tip', 'ring1', 'ring2', 'sleeve'], [[0, 1.0], [1.3, 1.9], [2.2, 2.8], [3.0, 3.5]])),
  ...[2, 3, 4].flatMap((n) =>
    pair(`jst-xh-${n}`, header(`JST XH ${n}`, 'jst-xh', n, 2.5, { w: (n - 1) * 2.5 + 4.9, h: 5.75, cy: 0.525 }, { numbering: 'verified', positions: 'nominal', note: 'Header body outline approximate.' })),
  ),
  ...[2, 3, 4].flatMap((n) =>
    pair(`jst-ph-${n}`, header(`JST PH ${n}`, 'jst-ph', n, 2.0, { w: (n - 1) * 2.0 + 3.9, h: 4.6, cy: 0.6 }, { numbering: 'verified', positions: 'nominal', note: 'Header body outline approximate.' })),
  ),
  ...pair('header-2.54-1x2', dupont(1, 2)),
  ...pair('header-2.54-1x3', dupont(1, 3)),
  ...pair('header-2.54-1x4', dupont(1, 4)),
  ...pair('header-2.54-1x6', dupont(1, 6)),
  ...pair('header-2.54-2x5', dupont(2, 5)),
  ...pair('usb-c', outlineOnly('USB Type-C', 'usb-c', { kind: 'rect', w: 8.94, h: 3.16, r: 1.58 }, [{ shape: { kind: 'rect', w: 8.34, h: 2.56, r: 1.28 }, tone: 'cavity' }, { shape: { kind: 'rect', w: 5.6, h: 0.7, r: 0.1 }, tone: 'insert' }])),
  ...pair('usb-micro-b', outlineOnly('USB Micro-B', 'usb-micro-b', { kind: 'rect', w: 7.45, h: 2.4, r: 0.2, chamfers: { bl: [0.9, 0.9], br: [0.9, 0.9] } }, [{ shape: { kind: 'rect', w: 6.85, h: 1.8, r: 0.1, chamfers: { bl: [0.6, 0.6], br: [0.6, 0.6] } }, tone: 'cavity' }])),
];

/**
 * Bare family keys (`mini-din-10`, `scart`) name the receptacle face for round and
 * audio/video families and the header face for wire-to-board families.
 */
const ALIASES: Record<string, string> = Object.fromEntries(
  ENTRIES.filter((g) => g.key.endsWith(`-${['jst-', 'header-', 'de-', 'da-', 'db-', 'trs-', 'trrs-'].some((p) => g.key.startsWith(p)) ? 'male' : 'female'}`)).map((g) => [g.key.replace(/-(male|female)$/, ''), g.key]),
);

export const CONNECTOR_GEOMETRIES: Record<string, ConnectorGeometry> = Object.freeze({
  ...Object.fromEntries(ENTRIES.map((g) => [g.key, g])),
  ...Object.fromEntries(Object.entries(ALIASES).map(([alias, key]) => [alias, ENTRIES.find((g) => g.key === key) as ConnectorGeometry])),
});

/** The base keys (without gender), for pickers. */
export const GEOMETRY_BASE_KEYS: readonly string[] = Object.freeze(Object.keys(ALIASES).sort());
