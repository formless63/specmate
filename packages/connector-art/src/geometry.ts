/**
 * Connector face geometry: a mating face as data.
 *
 * Coordinates are millimeters in the **mating-face view** of the geometry's own gender:
 * looking straight at the face that meets the partner connector, +x right, +y down,
 * origin at the face center. The solder (termination, rear) side is the same face seen
 * from behind, which is the mating face mirrored left to right. The partner gender's
 * mating face is also a left-right mirror (a socket faces a plug).
 *
 * Geometry is presentation of a family's published layout, not engineering evidence:
 * it never establishes fit, clearance, mating compatibility or conductor identity.
 */

export type Point = readonly [number, number];

export type Corner = 'tl' | 'tr' | 'bl' | 'br';

/**
 * A closed outline. `path` uses absolute M, L and Z commands only (in mm), so a
 * mirror reflects it exactly.
 */
export type Shape =
  | { kind: 'circle'; center?: Point; d: number }
  | {
      kind: 'rect';
      center?: Point;
      w: number;
      h: number;
      /** corner radius */
      r?: number;
      /** straight corner cuts: [along x, along y] */
      chamfers?: Partial<Record<Corner, readonly [number, number]>>;
    }
  | {
      kind: 'trapezoid';
      center?: Point;
      /** width of the upper (y < 0) edge */
      top: number;
      /** width of the lower edge */
      bottom: number;
      h: number;
      /** corner easing radius */
      r?: number;
    }
  | { kind: 'path'; d: string };

/** Paint roles; the renderer maps each to a Schematic Bench token. */
export type Tone = 'flange' | 'shell' | 'insert' | 'cavity' | 'key' | 'hole';

export interface Layer {
  shape: Shape;
  tone: Tone;
}

/** A keying feature drawn on the face: a notch, a plastic key, a cut corner or a latch. */
export interface Keyway {
  kind: 'notch' | 'key' | 'chamfer' | 'latch' | 'flat';
  shape: Shape;
  /** what the feature is, for the accessible description */
  note: string;
}

export type PinShape = 'round' | 'square' | 'blade' | 'ring';

export interface PinGeometry {
  /** the body contact id this position carries ("1", "shell", "tip") */
  id: string;
  /** center, mm, mating-face view */
  at: Point;
  shape: PinShape;
  /** round: diameter; square: side; blade: [w, h]; ring: [inner d, outer d] */
  size: number | readonly [number, number];
  /** `shell`: a contact made through the metal shell rather than an insert position */
  role?: 'contact' | 'shell';
}

export type Gender = 'male' | 'female' | 'ungendered';

/** How far a geometry's facts were checked. */
export interface Verification {
  /** pin count and numbering order */
  numbering: 'verified' | 'single-source' | 'unverified' | 'not-applicable';
  /** pin positions and outline dimensions */
  positions: 'nominal' | 'scaled' | 'approximate';
  note?: string;
}

export interface ConnectorGeometry {
  /** stable library key, kebab-case, including the gender for gendered faces */
  key: string;
  /** short caption ("Mini-DIN 10", "SCART") */
  label: string;
  /** family words a body's `family` text may use for this geometry */
  family: string;
  gender: Gender;
  /** numbered contact positions (shell contacts excluded) */
  pinCount: number;
  /** the face's outer edge */
  outline: Shape;
  /** further painted regions, back to front, drawn over the outline */
  layers: Layer[];
  keyways: Keyway[];
  pins: PinGeometry[];
  /** the numbering rule in words, in this geometry's mating-face view */
  numbering: string;
  /** generic public citation; detailed provenance stays outside the application */
  source: string;
  verification: Verification;
  /** an outline without contact positions (the family's pin layout is not drawn) */
  outlineOnly?: boolean;
}

export type FaceView = 'mating' | 'solder';

/* ------------------------------------------------------------------ *
 * Mirroring
 * ------------------------------------------------------------------ */

const swapCorner: Record<Corner, Corner> = { tl: 'tr', tr: 'tl', bl: 'br', br: 'bl' };

const mirrorPoint = (p: Point | undefined): Point | undefined => (p === undefined ? undefined : [-p[0], p[1]]);

/** A path's absolute M/L/Z commands reflected across x = 0. */
export function mirrorPath(d: string): string {
  return (d.match(/[A-Za-z][^A-Za-z]*/g) ?? [])
    .map((part) => {
      const command = part[0] as string;
      if (!'MLZ'.includes(command)) throw new Error('Connector face paths use absolute M, L and Z commands only.');
      if (command === 'Z') return 'Z';
      const nums = (part.slice(1).match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? []).map(Number);
      const out: number[] = [];
      for (let i = 0; i + 1 < nums.length; i += 2) out.push(-(nums[i] as number), nums[i + 1] as number);
      return `${command}${out.map(fmt).join(' ')}`;
    })
    .join(' ');
}

export const fmt = (v: number): string => String(Math.round(v * 1000) / 1000);

export function mirrorShape(shape: Shape): Shape {
  switch (shape.kind) {
    case 'circle':
      return { ...shape, ...(shape.center ? { center: mirrorPoint(shape.center) } : {}) };
    case 'trapezoid':
      return { ...shape, ...(shape.center ? { center: mirrorPoint(shape.center) } : {}) };
    case 'rect': {
      const chamfers = shape.chamfers
        ? Object.fromEntries(Object.entries(shape.chamfers).map(([corner, size]) => [swapCorner[corner as Corner], size]))
        : undefined;
      return { ...shape, ...(shape.center ? { center: mirrorPoint(shape.center) } : {}), ...(chamfers ? { chamfers } : {}) };
    }
    case 'path':
      return { kind: 'path', d: mirrorPath(shape.d) };
  }
}

/** The geometry reflected left to right (positions, outline, layers and keyways). */
export function mirrorGeometry(geometry: ConnectorGeometry): ConnectorGeometry {
  return {
    ...geometry,
    outline: mirrorShape(geometry.outline),
    layers: geometry.layers.map((layer) => ({ ...layer, shape: mirrorShape(layer.shape) })),
    keyways: geometry.keyways.map((keyway) => ({ ...keyway, shape: mirrorShape(keyway.shape) })),
    pins: geometry.pins.map((pin) => ({ ...pin, at: [-pin.at[0], pin.at[1]] as Point })),
  };
}

/** The face as drawn for a view: the mating face as authored, the solder side mirrored. */
export function geometryForView(geometry: ConnectorGeometry, view: FaceView = 'mating'): ConnectorGeometry {
  return view === 'solder' ? mirrorGeometry(geometry) : geometry;
}

/* ------------------------------------------------------------------ *
 * Shapes as SVG path data
 * ------------------------------------------------------------------ */

export function shapePath(shape: Shape): string {
  switch (shape.kind) {
    case 'circle': {
      const [cx, cy] = shape.center ?? [0, 0];
      const r = shape.d / 2;
      return `M${fmt(cx - r)} ${fmt(cy)} A${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(cx + r)} ${fmt(cy)} A${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(cx - r)} ${fmt(cy)} Z`;
    }
    case 'rect':
      return rectPath(shape);
    case 'trapezoid': {
      const [cx, cy] = shape.center ?? [0, 0];
      const t = shape.top / 2;
      const b = shape.bottom / 2;
      const h = shape.h / 2;
      return polygonPath(
        [
          [cx - t, cy - h],
          [cx + t, cy - h],
          [cx + b, cy + h],
          [cx - b, cy + h],
        ],
        shape.r ?? 0,
      );
    }
    case 'path':
      return shape.d;
  }
}

function rectPath(shape: Extract<Shape, { kind: 'rect' }>): string {
  const [cx, cy] = shape.center ?? [0, 0];
  const w = shape.w / 2;
  const h = shape.h / 2;
  const c = shape.chamfers ?? {};
  const pts: [number, number][] = [];
  const corner = (name: Corner, x: number, y: number, sx: number, sy: number, first: boolean): void => {
    const cut = c[name];
    if (cut === undefined) {
      pts.push([x, y]);
      return;
    }
    // walk clockwise: tl → tr → br → bl
    const a: [number, number] = first ? [x, y - sy * cut[1]] : [x - sx * cut[0], y];
    const b: [number, number] = first ? [x - sx * cut[0], y] : [x, y - sy * cut[1]];
    pts.push(a, b);
  };
  corner('tl', cx - w, cy - h, -1, -1, true);
  corner('tr', cx + w, cy - h, 1, -1, false);
  corner('br', cx + w, cy + h, 1, 1, true);
  corner('bl', cx - w, cy + h, -1, 1, false);
  return polygonPath(pts, shape.r ?? 0);
}

/** A closed polygon; corners eased with radius `r` (clamped to half the shorter edge). */
export function polygonPath(points: readonly (readonly [number, number])[], r = 0): string {
  if (r <= 0) return `${points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${fmt(x)} ${fmt(y)}`).join(' ')} Z`;
  const n = points.length;
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const prev = points[(i + n - 1) % n] as readonly [number, number];
    const cur = points[i] as readonly [number, number];
    const next = points[(i + 1) % n] as readonly [number, number];
    const toPrev = [prev[0] - cur[0], prev[1] - cur[1]];
    const toNext = [next[0] - cur[0], next[1] - cur[1]];
    const lp = Math.hypot(toPrev[0] as number, toPrev[1] as number);
    const ln = Math.hypot(toNext[0] as number, toNext[1] as number);
    const k = Math.min(r, lp / 2, ln / 2);
    const a: [number, number] = [cur[0] + ((toPrev[0] as number) / lp) * k, cur[1] + ((toPrev[1] as number) / lp) * k];
    const b: [number, number] = [cur[0] + ((toNext[0] as number) / ln) * k, cur[1] + ((toNext[1] as number) / ln) * k];
    out.push(`${i === 0 ? 'M' : 'L'}${fmt(a[0])} ${fmt(a[1])}`);
    // a two-step bevel eases the corner and keeps the path mirror-exact without arcs
    out.push(`L${fmt(a[0] + (cur[0] - a[0]) * 0.55)} ${fmt(a[1] + (cur[1] - a[1]) * 0.55)} L${fmt(b[0] + (cur[0] - b[0]) * 0.55)} ${fmt(b[1] + (cur[1] - b[1]) * 0.55)} L${fmt(b[0])} ${fmt(b[1])}`);
  }
  return `${out.join(' ')} Z`;
}

/** Axis-aligned bounds of a shape, mm. */
export function shapeBounds(shape: Shape): [number, number, number, number] {
  switch (shape.kind) {
    case 'circle': {
      const [cx, cy] = shape.center ?? [0, 0];
      const r = shape.d / 2;
      return [cx - r, cy - r, cx + r, cy + r];
    }
    case 'rect': {
      const [cx, cy] = shape.center ?? [0, 0];
      return [cx - shape.w / 2, cy - shape.h / 2, cx + shape.w / 2, cy + shape.h / 2];
    }
    case 'trapezoid': {
      const [cx, cy] = shape.center ?? [0, 0];
      const half = Math.max(shape.top, shape.bottom) / 2;
      return [cx - half, cy - shape.h / 2, cx + half, cy + shape.h / 2];
    }
    case 'path': {
      const nums = (shape.d.match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? []).map(Number);
      const xs = nums.filter((_, i) => i % 2 === 0);
      const ys = nums.filter((_, i) => i % 2 === 1);
      if (xs.length === 0) return [0, 0, 0, 0];
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
  }
}

/** The numbered contact ids in ascending numeric order. */
export function numberedPinIds(geometry: ConnectorGeometry): string[] {
  return geometry.pins
    .filter((pin) => pin.role !== 'shell' && /^\d+$/.test(pin.id))
    .map((pin) => pin.id)
    .sort((a, b) => Number(a) - Number(b));
}
