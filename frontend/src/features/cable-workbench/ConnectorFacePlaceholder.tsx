/**
 * Placeholder for the shared connector art package (`packages/connector-art`). It keeps that
 * package's interface exactly, so replacing this import with the package is a one-line change:
 * `ConnectorFace({ geometry, view, pins, selectedPinId, onPinClick, size, title })`,
 * `geometryForBody(body)` and `CONNECTOR_GEOMETRIES`.
 *
 * It draws only what is recorded: contact positions from the body when every contact has one;
 * otherwise a plainly schematic face (dashed outline, "layout not recorded"), never a guessed shape.
 */
import type { KeyboardEvent } from "react";
import type { Body } from "../interfaces/api";

export type ConnectorView = "mating" | "termination";
export type ConnectorGeometry = { id: string; name: string; outline: "circle" | "rect"; width: number; height: number; pins: { id: string; x: number; y: number }[] };
export type FacePin = { id: string; label: string; fill: string; state?: "pass" | "fail" | "unknown" | "not_evaluated" | "flagged" | "none" | null };

/** Known connector geometries by family; empty until the shared package provides them. */
export const CONNECTOR_GEOMETRIES: Record<string, ConnectorGeometry> = {};

/** Recorded geometry of a body: its contact positions, else a known family geometry, else null. */
export function geometryForBody(body: Body | null | undefined): ConnectorGeometry | null {
  if (!body) return null;
  const family = body.family ? CONNECTOR_GEOMETRIES[body.family] : undefined;
  if (family) return family;
  const contacts = body.contacts.filter((c) => c.physical_role !== "key");
  if (!contacts.length || contacts.some((c) => !c.position_mm)) return null;
  const xs = contacts.map((c) => c.position_mm![0]);
  const ys = contacts.map((c) => c.position_mm![1]);
  const width = Math.max(...xs) - Math.min(...xs) || 1;
  const height = Math.max(...ys) - Math.min(...ys) || 1;
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
  const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  return { id: `body:${body.family ?? "unnamed"}`, name: body.family ?? "Connector", outline: "rect", width, height,
    pins: contacts.map((c) => ({ id: c.contact_id, x: c.position_mm![0] - cx, y: cy - c.position_mm![1] })) };
}

/** Schematic placement when no geometry is recorded: a ring for small counts, else two staggered rows. */
function schematic(pins: FacePin[]): { x: number; y: number }[] {
  const n = pins.length;
  if (n <= 12) return pins.map((_, i) => { const a = (i / Math.max(n, 1)) * Math.PI * 2 - Math.PI / 2; return { x: Math.cos(a) * 0.62, y: Math.sin(a) * 0.62 }; });
  const top = Math.ceil(n / 2);
  return pins.map((_, i) => {
    const row = i < top ? 0 : 1;
    const k = row === 0 ? i : i - top;
    const count = row === 0 ? top : n - top;
    return { x: -0.82 + (1.64 * (k + (row ? 0.5 : 0))) / Math.max(count, 1), y: row === 0 ? -0.2 : 0.2 };
  });
}

const RING: Record<string, string> = { pass: "var(--sb-pass)", fail: "var(--sb-invalid)", unknown: "var(--sb-review)", flagged: "var(--sb-info)", not_evaluated: "var(--sb-text-tertiary)" };

export function ConnectorFace({ geometry, view = "mating", pins, selectedPinId = null, onPinClick, size = 96, title }: {
  geometry: ConnectorGeometry | null; view?: ConnectorView; pins: FacePin[]; selectedPinId?: string | null;
  onPinClick?: (id: string) => void; size?: number; title?: string;
}) {
  const mirror = view === "termination" ? -1 : 1;
  const scale = geometry ? 1.64 / Math.max(geometry.width, geometry.height, 1) : 1;
  const placed = geometry
    ? pins.map((pin) => { const g = geometry.pins.find((p) => p.id === pin.id); return g ? { x: g.x * scale * mirror, y: g.y * scale } : null; })
    : schematic(pins).map((p) => ({ x: p.x * mirror, y: p.y }));
  const radius = Math.min(0.13, pins.length > 12 ? 0.075 : 0.12);
  const key = (id: string) => (event: KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onPinClick?.(id); } };
  return <svg className="cwb-face" width={size} height={size} viewBox="-1 -1 2 2" role="group" aria-label={title ?? "Connector face"} data-geometry={geometry ? "recorded" : "schematic"} data-view={view}>
    {title && <title>{title}</title>}
    {geometry?.outline === "rect" || (!geometry && pins.length > 12)
      ? <rect x={-0.96} y={pins.length > 12 && !geometry ? -0.5 : -0.96} width={1.92} height={pins.length > 12 && !geometry ? 1 : 1.92} rx={0.12} className="cwb-face-body" data-schematic={!geometry || undefined} />
      : <circle r={0.96} className="cwb-face-body" data-schematic={!geometry || undefined} />}
    {pins.map((pin, i) => {
      const at = placed[i];
      if (!at) return null;
      const selected = pin.id === selectedPinId;
      return <g key={pin.id} className="cwb-face-pin" data-pin={pin.id} data-state={pin.state ?? undefined} role="button" tabIndex={onPinClick ? 0 : -1}
        aria-label={`Pin ${pin.label}`} aria-pressed={selected} onClick={() => onPinClick?.(pin.id)} onKeyDown={key(pin.id)}>
        {pin.state && pin.state !== "none" && <circle cx={at.x} cy={at.y} r={radius * 1.55} style={{ fill: "none", stroke: RING[pin.state] }} strokeWidth={0.035} strokeDasharray={pin.state === "unknown" ? "0.04 0.03" : undefined} />}
        <circle cx={at.x} cy={at.y} r={radius} style={{ fill: pin.fill, stroke: "var(--sb-surface-canvas)" }} strokeWidth={0.02} />
        {selected && <circle cx={at.x} cy={at.y} r={radius * 2} style={{ fill: "none", stroke: "var(--sb-accent)" }} strokeWidth={0.05} />}
        <text x={at.x} y={at.y + radius * 0.4} fontSize={radius * 1.1} textAnchor="middle" className="cwb-face-num">{pin.label}</text>
      </g>;
    })}
    {!geometry && <text y={0.93} fontSize={0.12} textAnchor="middle" className="cwb-face-note">layout not recorded</text>}
  </svg>;
}
