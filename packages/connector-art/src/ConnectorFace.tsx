/**
 * A connector's face drawn from its geometry, themed with Schematic Bench tokens.
 *
 * Pins carry an optional state; a pin a caller lists no entry for (when it lists any)
 * is unknown and drawn hatched, never as an empty or passing contact. Status never
 * relies on hue alone: failed pins are dashed, hazards double-ringed, selection ringed,
 * and every pin's state is in its accessible name.
 */

import { useId, type JSX, type KeyboardEvent } from 'react';

import { fmt, geometryForView, shapeBounds, shapePath, type ConnectorGeometry, type PinGeometry, type Tone } from './geometry';

export type PinState = 'pass' | 'fail' | 'unknown' | 'hazard' | 'selected' | 'dim';

/**
 * Extra outer rings, drawn in addition to the state: `must-not-connect` (thick dashed,
 * invalid ink), `hazard` (dashed, review ink) and `differs` (dashed, compare ink, for a
 * pin whose meaning changes between two compared pin tables).
 */
export type PinRing = 'must-not-connect' | 'hazard' | 'differs';

export interface ConnectorFacePin {
  id: string;
  label?: string;
  fill?: string;
  state?: PinState;
  rings?: readonly PinRing[];
  /**
   * A conditional pin: two or more fills drawn as a split marker, one segment per
   * alternative meaning. The pin's own `fill` is ignored while a split is drawn.
   */
  split?: readonly string[];
}

export interface ConnectorFaceProps {
  geometry: ConnectorGeometry;
  view?: 'mating' | 'solder';
  pins?: ConnectorFacePin[];
  selectedPinId?: string | null;
  onPinClick?: (id: string) => void;
  /** rendered width in CSS pixels (default 240) */
  size?: number;
  title?: string;
}

const TONE_FILL: Record<Tone, string> = {
  flange: 'var(--sb-surface-panel, #1d1f22)',
  shell: 'var(--sb-surface-raised, #2a2d31)',
  insert: 'var(--sb-surface-sunken, #121315)',
  cavity: 'var(--sb-surface-canvas, #0b0c0d)',
  key: 'var(--sb-surface-panel, #1d1f22)',
  hole: 'var(--sb-surface-canvas, #0b0c0d)',
};
const STROKE = 'var(--sb-border-strong, #5b6068)';
const SUBTLE = 'var(--sb-border-control, #3c4046)';
const METAL = 'var(--sb-text-secondary, #b3b8bf)';
const TEXT = 'var(--sb-text-primary, #e8eaed)';
const ON_METAL = 'var(--sb-surface-canvas, #0b0c0d)';

const RING_WORDS: Record<PinRing, string> = {
  'must-not-connect': 'must not connect',
  hazard: 'hazard',
  differs: 'differs between compared pin tables',
};
const RING_STYLE: Record<PinRing, { color: string; scale: number; width: number }> = {
  'must-not-connect': { color: 'var(--sb-invalid, #ff5a5a)', scale: 1.42, width: 2.6 },
  hazard: { color: 'var(--sb-review, #e0b030)', scale: 1.42, width: 2 },
  differs: { color: 'var(--sb-compare, #7ab8ff)', scale: 1.7, width: 1.8 },
};

const STATE_WORDS: Record<PinState, string> = {
  pass: 'passed',
  fail: 'failed',
  unknown: 'unknown',
  hazard: 'hazard',
  selected: 'selected',
  dim: 'not in focus',
};

/**
 * The radius round and square markers are drawn at: their real size, enlarged uniformly
 * toward the face's closest contact spacing so numbers stay legible.
 */
function displayRadii(pins: readonly PinGeometry[]): Map<string, number> {
  const out = new Map<string, number>();
  const markers = pins.filter((p) => p.role !== 'shell' && (p.shape === 'round' || p.shape === 'square'));
  let nearest = Infinity;
  markers.forEach((a, i) => markers.slice(i + 1).forEach((b) => (nearest = Math.min(nearest, Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1])))));
  for (const pin of pins) {
    if (pin.shape !== 'round' && pin.shape !== 'square') continue;
    const real = (typeof pin.size === 'number' ? pin.size : pin.size[1]) / 2;
    out.set(pin.id, pin.role !== 'shell' && Number.isFinite(nearest) ? Math.max(real, Math.min(nearest * 0.4, real * 1.7)) : real);
  }
  return out;
}

export function ConnectorFace(props: ConnectorFaceProps): JSX.Element {
  const { view = 'mating', pins, selectedPinId = null, onPinClick, size = 240, title } = props;
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const g = geometryForView(props.geometry, view);
  const byId = new Map((pins ?? []).map((p) => [p.id, p]));
  const radii = displayRadii(g.pins);

  // bounds over everything drawn, plus a margin
  const boxes = [shapeBounds(g.outline), ...g.layers.map((l) => shapeBounds(l.shape)), ...g.keyways.map((k) => shapeBounds(k.shape))];
  for (const pin of g.pins) {
    const r = radii.get(pin.id) ?? (typeof pin.size === 'number' ? pin.size : Math.max(...pin.size)) / 2;
    boxes.push([pin.at[0] - r, pin.at[1] - r, pin.at[0] + r, pin.at[1] + r]);
  }
  const minX = Math.min(...boxes.map((b) => b[0]));
  const minY = Math.min(...boxes.map((b) => b[1]));
  const maxX = Math.max(...boxes.map((b) => b[2]));
  const maxY = Math.max(...boxes.map((b) => b[3]));
  const span = Math.max(maxX - minX, maxY - minY);
  const pad = span * 0.06;
  const vb = [minX - pad, minY - pad, maxX - minX + pad * 2, maxY - minY + pad * 2] as const;
  const height = Math.round((size * vb[3]) / vb[2]);
  const female = g.gender === 'female';

  const caption = title ?? `${g.label} ${g.gender === 'ungendered' ? '' : g.gender === 'male' ? 'plug ' : 'socket '}${view === 'solder' ? 'solder side' : 'mating face'}`.replace(/\s+/g, ' ').trim();
  const stateOf = (pin: PinGeometry): PinState | undefined => {
    if (selectedPinId === pin.id) return 'selected';
    const entry = byId.get(pin.id);
    if (entry?.state) return entry.state;
    if (pins !== undefined && entry === undefined && pin.role !== 'shell') return 'unknown';
    return undefined;
  };
  const describe = (pin: PinGeometry, state: PinState | undefined): string => {
    const entry = byId.get(pin.id);
    const name = pin.role === 'shell' && !/^\d+$/.test(pin.id) ? pin.id : `Pin ${pin.id}`;
    return [name, entry?.label, state ? STATE_WORDS[state] : undefined, entry?.split && entry.split.length > 1 ? 'conditional' : undefined, ...(entry?.rings ?? []).map((ring) => RING_WORDS[ring])].filter(Boolean).join(', ');
  };
  const clickable = onPinClick !== undefined;
  const activate = (id: string) => (event: KeyboardEvent<SVGGElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onPinClick?.(id);
    }
  };
  const hatch = `sb-cf-hatch-${uid}`;
  const glow = `sb-cf-glow-${uid}`;
  const clip = `sb-cf-clip-${uid}`;
  const stroke = span / 260;

  return (
    <svg
      className="sb-connector-face"
      role={clickable ? 'group' : 'img'}
      aria-label={`${caption}${g.outlineOnly ? ', outline only' : `, ${g.pinCount} positions`}`}
      viewBox={vb.map(fmt).join(' ')}
      width={size}
      height={height}
      style={{ display: 'block', maxWidth: '100%', height: 'auto' }}
      data-geometry={g.key}
      data-view={view}
    >
      <title>{caption}</title>
      <defs>
        <pattern id={hatch} patternUnits="userSpaceOnUse" width={span / 40} height={span / 40} patternTransform="rotate(45)">
          <rect width={span / 40} height={span / 40} fill={ON_METAL} />
          <line x1={0} y1={0} x2={0} y2={span / 40} stroke="var(--sb-hatch, #7a7f87)" strokeWidth={span / 110} />
        </pattern>
        <clipPath id={clip}>
          <path d={shapePath(g.outline)} />
        </clipPath>
        <filter id={glow} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation={span / 140} />
        </filter>
      </defs>
      <g aria-hidden="true" strokeWidth={stroke} strokeLinejoin="round">
        <path d={shapePath(g.outline)} fill={TONE_FILL.shell} stroke={STROKE} />
        {g.layers.map((layer, i) => (
          <path key={`l${i}`} d={shapePath(layer.shape)} fill={TONE_FILL[layer.tone]} stroke={layer.tone === 'insert' ? SUBTLE : STROKE} />
        ))}
        <g clipPath={`url(#${clip})`}>{g.keyways.map((keyway, i) => (
          <path key={`k${i}`} d={shapePath(keyway.shape)} fill={keyway.kind === 'key' || keyway.kind === 'latch' ? TONE_FILL.key : keyway.kind === 'chamfer' ? 'none' : TONE_FILL.cavity} stroke={keyway.kind === 'chamfer' ? 'none' : STROKE} data-keyway={keyway.kind}>
            <title>{keyway.note}</title>
          </path>
        ))}</g>
      </g>
      {g.pins.map((pin) => {
        const state = stateOf(pin);
        const entry = byId.get(pin.id);
        const r = radii.get(pin.id);
        const marker = pinMarker(pin, r, { female, fill: entry?.fill, state, hatch, stroke });
        const text = /^\d+$/.test(pin.id) && r !== undefined ? (
          <text x={fmt(pin.at[0])} y={fmt(pin.at[1] + r * 0.36)} fontSize={fmt(r * (pin.id.length > 1 ? 0.9 : 1.05))} textAnchor="middle" fill={entry?.fill || female || state === 'unknown' ? TEXT : ON_METAL} stroke={entry?.fill || state === 'unknown' ? ON_METAL : 'none'} strokeWidth={fmt(r * 0.16)} paintOrder="stroke" style={{ fontFamily: 'var(--sb-font-data, ui-monospace, monospace)', pointerEvents: 'none' }} aria-hidden="true">
            {pin.id}
          </text>
        ) : pin.shape === 'blade' ? (
          <text x={fmt(pin.at[0])} y={fmt(pin.at[1] + (pin.at[1] < 0 ? -1.4 : 2.3))} fontSize={1.5} textAnchor="middle" fill="var(--sb-text-tertiary, #8a8f97)" style={{ fontFamily: 'var(--sb-font-data, ui-monospace, monospace)', pointerEvents: 'none' }} aria-hidden="true">
            {pin.id}
          </text>
        ) : null;
        const halo =
          state === 'selected' ? (
            <>
              <circle cx={fmt(pin.at[0])} cy={fmt(pin.at[1])} r={fmt(haloRadius(pin, r) * 1.25)} fill="var(--sb-accent-glow, rgba(255,140,40,.35))" filter={`url(#${glow})`} />
              <circle cx={fmt(pin.at[0])} cy={fmt(pin.at[1])} r={fmt(haloRadius(pin, r) * 1.18)} fill="none" stroke="var(--sb-accent, #ff8c28)" strokeWidth={stroke * 2.4} />
            </>
          ) : state === 'hazard' ? (
            <circle cx={fmt(pin.at[0])} cy={fmt(pin.at[1])} r={fmt(haloRadius(pin, r) * 1.2)} fill="none" stroke="var(--sb-review, #e0b030)" strokeWidth={stroke * 2} strokeDasharray={`${fmt(stroke * 3)} ${fmt(stroke * 2)}`} />
          ) : null;
        const rings = (entry?.rings ?? []).map((ring) => (
          <circle key={ring} cx={fmt(pin.at[0])} cy={fmt(pin.at[1])} r={fmt(haloRadius(pin, r) * RING_STYLE[ring].scale)} fill="none" stroke={RING_STYLE[ring].color} strokeWidth={stroke * RING_STYLE[ring].width} strokeDasharray={`${fmt(stroke * 3.5)} ${fmt(stroke * 2.2)}`} data-ring={ring} />
        ));
        const split = entry?.split && entry.split.length > 1 && state !== 'unknown' ? splitMarker(pin, r, entry.split, stroke) : null;
        const body = (
          <g data-pin={pin.id} data-state={state ?? 'none'} data-split={split ? entry?.split?.length : undefined} opacity={state === 'dim' ? 0.35 : undefined}>
            {rings}
            {halo}
            {marker}
            {split}
            {text}
            {!clickable && <title>{describe(pin, state)}</title>}
          </g>
        );
        if (!clickable) return <g key={pin.id}>{body}</g>;
        return (
          <g
            key={pin.id}
            role="button"
            tabIndex={0}
            aria-label={describe(pin, state)}
            aria-pressed={selectedPinId === pin.id}
            onClick={() => onPinClick(pin.id)}
            onKeyDown={activate(pin.id)}
            style={{ cursor: 'pointer', outline: 'none' }}
            className="sb-connector-face-pin"
          >
            {body}
          </g>
        );
      })}
    </svg>
  );
}

/** A round or square marker cut into equal wedges, one per alternative meaning. */
function splitMarker(pin: PinGeometry, r: number | undefined, fills: readonly string[], stroke: number): JSX.Element | null {
  if (r === undefined || (pin.shape !== 'round' && pin.shape !== 'square')) return null;
  const [x, y] = pin.at;
  const n = fills.length;
  const radius = pin.shape === 'square' ? r * 1.0 : r;
  return (
    <g aria-hidden="true" style={{ pointerEvents: 'none' }}>
      {fills.map((fill, i) => {
        const a0 = -Math.PI / 2 + (i * 2 * Math.PI) / n;
        const a1 = -Math.PI / 2 + ((i + 1) * 2 * Math.PI) / n;
        const large = a1 - a0 > Math.PI ? 1 : 0;
        const d = `M${fmt(x)} ${fmt(y)} L${fmt(x + radius * Math.cos(a0))} ${fmt(y + radius * Math.sin(a0))} A${fmt(radius)} ${fmt(radius)} 0 ${large} 1 ${fmt(x + radius * Math.cos(a1))} ${fmt(y + radius * Math.sin(a1))} Z`;
        return <path key={i} d={d} fill={fill} stroke="var(--sb-surface-canvas, #0b0c0d)" strokeWidth={stroke * 1.2} />;
      })}
    </g>
  );
}

function haloRadius(pin: PinGeometry, r: number | undefined): number {
  if (r !== undefined) return r;
  if (typeof pin.size === 'number') return pin.size / 2;
  return Math.max(pin.size[0], pin.size[1]) / 2;
}

function pinMarker(pin: PinGeometry, r: number | undefined, o: { female: boolean; fill?: string; state?: PinState; hatch: string; stroke: number }): JSX.Element {
  const [x, y] = pin.at;
  const unknown = o.state === 'unknown';
  const fail = o.state === 'fail';
  const pass = o.state === 'pass';
  const edge = fail ? 'var(--sb-invalid, #ff5a5a)' : pass ? 'var(--sb-pass, #4cc38a)' : unknown ? 'var(--sb-text-tertiary, #8a8f97)' : STROKE;
  const width = fail || pass ? o.stroke * 2.2 : o.stroke;
  const dash = fail ? `${fmt(o.stroke * 3)} ${fmt(o.stroke * 2)}` : unknown ? `${fmt(o.stroke * 2)} ${fmt(o.stroke * 2)}` : undefined;
  const base = unknown ? `url(#${o.hatch})` : o.fill ?? (o.female ? TONE_FILL.cavity : METAL);
  if (pin.shape === 'ring') {
    const [inner, outer] = typeof pin.size === 'number' ? [pin.size * 0.5, pin.size] : pin.size;
    const mid = (inner + outer) / 4;
    return <circle cx={fmt(x)} cy={fmt(y)} r={fmt(mid)} fill="none" stroke={unknown ? `url(#${o.hatch})` : o.fill ?? (pin.role === 'shell' ? METAL : 'var(--sb-text-tertiary, #8a8f97)')} strokeWidth={fmt((outer - inner) / 2)} strokeDasharray={dash} />;
  }
  if (pin.shape === 'blade') {
    const [w, h] = typeof pin.size === 'number' ? [pin.size, pin.size] : pin.size;
    const hh = Math.max(h, Math.min(w, 1.3));
    return <rect x={fmt(x - w / 2)} y={fmt(y - hh / 2)} width={fmt(w)} height={fmt(hh)} rx={fmt(Math.min(w, hh) * 0.15)} fill={base} stroke={edge} strokeWidth={width} strokeDasharray={dash} />;
  }
  const radius = r ?? (typeof pin.size === 'number' ? pin.size / 2 : pin.size[0] / 2);
  if (pin.shape === 'square') {
    return <rect x={fmt(x - radius)} y={fmt(y - radius)} width={fmt(radius * 2)} height={fmt(radius * 2)} rx={fmt(radius * 0.15)} fill={base} stroke={edge} strokeWidth={width} strokeDasharray={dash} />;
  }
  return <circle cx={fmt(x)} cy={fmt(y)} r={fmt(radius)} fill={base} stroke={edge} strokeWidth={width} strokeDasharray={dash} />;
}
