import type { Signal } from "../interfaces/api";
import { FAMILIES, FAMILY_LABELS, familyColor, signalFamily } from "./palette";

/**
 * Signal chips of one exact signal set, grouped by type family. Pick a pin, then a chip.
 * Chips are buttons, so the keyboard path is: focus a pin, Enter, Tab to a chip, Enter.
 */
export function SignalPalette({ signals, uses, current, disabled, onPick, hint }: {
  signals: readonly Signal[]; uses: ReadonlyMap<string, number>; current: string | null; disabled: boolean; onPick: (signal: Signal) => void; hint?: string;
}) {
  const groups = FAMILIES.map((family) => ({ family, signals: signals.filter((s) => signalFamily(s.type) === family) })).filter((g) => g.signals.length);
  return <div className="pwb-palette" role="group" aria-label="Signals">
    {hint && <p className="pwb-hint">{hint}</p>}
    {groups.map((g) => <div className="pwb-group" key={g.family}>
      <span className="sb-silk" style={{ color: familyColor(g.family) }}>{FAMILY_LABELS[g.family]}</span>
      <div className="pwb-chips">{g.signals.map((s) => <button type="button" key={s.key} className="pwb-chip" disabled={disabled} aria-pressed={current === s.key}
        style={{ borderLeftColor: familyColor(g.family) }} onClick={() => onPick(s)} title={s.notes ?? undefined} aria-label={`Assign ${s.name}`}>
        <span>{s.name}</span>{(uses.get(s.key) ?? 0) > 0 && <span className="pwb-chip-uses" aria-label={`used on ${uses.get(s.key)} pins`}>×{uses.get(s.key)}</span>}
      </button>)}</div>
    </div>)}
  </div>;
}
