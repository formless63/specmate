import { useId } from "react";
import "./sb-components.css";
import { SbUnknown } from "./SbUnknown";

export type QuantityState = "known" | "unknown" | "na" | "invalid";

export type SbQuantityProps = {
  label: string;
  /** null or undefined is unknown unless `state` says otherwise; it is never rendered as 0. */
  value: number | string | null | undefined;
  unit?: string;
  state?: QuantityState;
  /** Why not applicable, or what is wrong when invalid. */
  note?: string;
  /** Exact basis line for a known value, such as "manual declaration · 10-09". */
  basis?: string;
  /** Present: the value is editable and reports the raw entry (empty string means cleared). */
  onChange?: (raw: string) => void;
  /** Next step shown on an unknown value. */
  next?: React.ReactNode;
};

export function quantityState(value: SbQuantityProps["value"], state?: QuantityState): QuantityState {
  if (state) return state;
  return value === null || value === undefined || value === "" ? "unknown" : "known";
}

/** Inline read-only quantity for table cells: value plus a separate unit, or an explicit unknown / n/a / invalid. */
export function SbQuantity({ value, unit, state, note }: Pick<SbQuantityProps, "value" | "unit" | "state" | "note">) {
  const s = quantityState(value, state);
  if (s === "unknown") return <span className="sb-q-inline" data-state="unknown">– – – unknown</span>;
  if (s === "na") return <span className="sb-q-inline" data-state="na" title={note}>n/a</span>;
  return <span className="sb-q-inline" data-state={s} title={s === "invalid" ? note : undefined}>{String(value)}{unit && <> <span className="sb-q-unit">{unit}</span></>}</span>;
}

/**
 * Quantity with a separate unit suffix. Known, unknown, not applicable and invalid
 * are four distinct looks and none falls back to zero or blank.
 */
export function SbQuantityField({ label, value, unit, state, note, basis, onChange, next }: SbQuantityProps) {
  const id = useId();
  const s = quantityState(value, state);
  const editable = Boolean(onChange) && s !== "na";
  const shown = s === "unknown" ? "" : s === "na" ? "n/a" : String(value ?? "");
  const noteId = `${id}-note`;
  return <div className="sb-q" data-state={s}>
    <label className="sb-silk" htmlFor={id}>{label}</label>
    <div className="sb-q-box">
      <input id={id} className="sb-q-value" value={shown} readOnly={!editable} inputMode="decimal"
        placeholder={s === "unknown" ? "– – –" : undefined} aria-invalid={s === "invalid" || undefined}
        aria-describedby={noteId} onChange={(event) => onChange?.(event.currentTarget.value)} />
      {unit && s !== "na" && <span className="sb-q-unit">{unit}</span>}
      {s === "unknown" && <span className="sb-silk">Unknown</span>}
    </div>
    <span id={noteId} className="sb-q-note">
      {s === "unknown" && (next ? <>not recorded · {next}</> : <SbUnknown />)}
      {s === "na" && (note ?? "not applicable")}
      {s === "invalid" && (note ?? "Invalid value.")}
      {s === "known" && basis}
    </span>
  </div>;
}
