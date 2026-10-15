import type { Feature, Proposal, Rect } from './api';

const rects = (value: unknown): Rect[] => (Array.isArray(value) ? (value as Rect[]) : []);
const asRect = (value: unknown): Rect | null => (value && typeof value === 'object' && 'x0' in value ? (value as Rect) : null);
const get = (feature: Feature, key: string) => feature.geometry[key];
const numeric = (value: unknown): number | null => (typeof value === 'number' ? value : null);

/** Plan view of declared geometry in the native board frame; unknown parts are simply absent. */
export function PlanPreview({ proposal }: { proposal: Proposal }) {
  const shell = proposal.features.find(f => f.kind === 'enclosure_outline');
  const envelope = shell ? asRect(get(shell, 'board_envelope')) : null;
  const cavity = shell ? asRect(get(shell, 'cavity')) : null;
  const outer = shell ? asRect(get(shell, 'outer')) : null;
  const frame = outer ?? cavity ?? envelope;
  if (!frame) return <p role="note">No plan preview: the accepted board supplies no closed outline.</p>;
  const pad = 4;
  const x = frame.x0 - pad, y = frame.y0 - pad, w = frame.x1 - frame.x0 + 2 * pad, h = frame.y1 - frame.y0 + 2 * pad;
  const stroke = 'var(--sb-text-secondary)';
  return (
    <svg role="img" aria-label="Plan view of the declared proposal geometry in millimeters" viewBox={`${x} ${y} ${w} ${h}`} style={{ width: '100%', maxHeight: 420, background: 'var(--sb-surface-sunken)' }}>
      {outer && <rect x={outer.x0} y={outer.y0} width={outer.x1 - outer.x0} height={outer.y1 - outer.y0} fill="none" stroke={stroke} strokeWidth={0.3} />}
      {cavity && <rect x={cavity.x0} y={cavity.y0} width={cavity.x1 - cavity.x0} height={cavity.y1 - cavity.y0} fill="none" stroke={stroke} strokeWidth={0.3} strokeDasharray="1.5 1" />}
      {envelope && <rect x={envelope.x0} y={envelope.y0} width={envelope.x1 - envelope.x0} height={envelope.y1 - envelope.y0} fill="none" stroke="var(--sb-text-primary)" strokeWidth={0.4} />}
      {proposal.features.map(feature => {
        if (feature.kind === 'mount_boss' || feature.kind === 'mount_candidate') {
          const center = get(feature, 'center') as [number, number];
          const diameter = numeric(get(feature, 'outer_diameter_mm'));
          const drill = (get(feature, 'native_hole_drill_mm') ?? get(feature, 'drill_mm')) as [number, number] | undefined;
          const selected = feature.kind === 'mount_boss';
          return <g key={feature.feature_id} data-feature={feature.feature_id}>
            {selected && diameter !== null && <circle cx={center[0]} cy={center[1]} r={diameter / 2} fill="none" stroke="var(--sb-accent)" strokeWidth={0.4} />}
            <circle cx={center[0]} cy={center[1]} r={(drill?.[0] ?? 1) / 2} fill="none" stroke={selected ? 'var(--sb-accent)' : stroke} strokeWidth={0.3} strokeDasharray={selected ? undefined : '0.8 0.8'} />
          </g>;
        }
        if (feature.kind === 'connector_opening') {
          const lateral = numeric(get(feature, 'lateral_center_mm')), width = numeric(get(feature, 'width_mm')), wall = numeric(get(feature, 'wall_coordinate_mm'));
          if (lateral === null || width === null || wall === null) return null;
          const horizontal = get(feature, 'side') === 'north' || get(feature, 'side') === 'south';
          return horizontal
            ? <line key={feature.feature_id} x1={lateral - width / 2} x2={lateral + width / 2} y1={wall} y2={wall} stroke="var(--sb-info)" strokeWidth={1.2} />
            : <line key={feature.feature_id} y1={lateral - width / 2} y2={lateral + width / 2} x1={wall} x2={wall} stroke="var(--sb-info)" strokeWidth={1.2} />;
        }
        if (feature.kind === 'vent_array') {
          const slots = (get(feature, 'slots') as [number, number][] | null) ?? [];
          const sw = numeric(get(feature, 'slot_width_mm')), sl = numeric(get(feature, 'slot_length_mm'));
          if (sw === null || sl === null) return null;
          return <g key={feature.feature_id}>{slots.map(([cx, cy]) => <rect key={`${cx}:${cy}`} x={cx - sl / 2} y={cy - sw / 2} width={sl} height={sw} fill="none" stroke={stroke} strokeWidth={0.2} />)}</g>;
        }
        if (feature.kind === 'cable_guide') {
          return <g key={feature.feature_id}>{rects(get(feature, 'posts')).map((r, index) => <rect key={index} x={r.x0} y={r.y0} width={r.x1 - r.x0} height={r.y1 - r.y0} fill="var(--sb-text-secondary)" />)}</g>;
        }
        return null;
      })}
    </svg>
  );
}
