import { usePermission, type PermissionName } from '../../lib/permissions';
import type { Known } from './builder';
import { MmEntry } from './MmEntry';

/** Count stepper: direct, bounded +/- control that replaces a bare number field. */
export function Stepper({ label, value, min, max, onChange, permission = "item.create" }: { permission?: PermissionName; label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  const edit = usePermission(permission);
  return <div role="group" aria-label={label} className="sb-stepper">
    <span className="sb-silk">{label}</span>
    <span className="sb-stepper__box">
      <button type="button" aria-label={`Fewer ${label.toLowerCase()}`} disabled={!edit.allowed || value <= min} onClick={() => onChange(value - 1)}>−</button>
      <output aria-label={`${label} count`}>{value}</output>
      <button type="button" aria-label={`More ${label.toLowerCase()}`} disabled={!edit.allowed || value >= max} onClick={() => onChange(value + 1)}>+</button>
    </span>
  </div>;
}

/**
 * A millimeter dimension as a slider plus the exact numeric entry. An unknown value keeps an
 * unknown numeric field; the slider rests at its minimum and is marked unknown, so moving it
 * is the deliberate act that supplies a value.
 */
export function DimRow({ label, value, onChange, max, step = 0.01, min = 0, permission = "item.create" }: { permission?: PermissionName; label: string; value: Known; onChange: (v: Known) => void; max: number; step?: number; min?: number }) {
  const edit = usePermission(permission);
  const top = Math.max(max, value === null ? 0 : Math.ceil(value * 1.25));
  return <div className="sb-dim">
    <MmEntry label={label} value={value} onChange={onChange} />
    <input type="range" className="sb-dim__slider" aria-label={`${label} slider`} min={min} max={top} step={step} value={value ?? min} data-unknown={value === null || undefined}
      disabled={!edit.allowed} onChange={e => { if (edit.allowed) onChange(Number(Number(e.target.value).toFixed(4))); }} />
  </div>;
}
