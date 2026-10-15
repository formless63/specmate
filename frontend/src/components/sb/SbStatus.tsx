import "./sb-components.css";

export type SbLed = "active" | "review" | "failed" | "idle" | "not-evaluated" | "info" | "stale" | "off" | "pass" | "unknown";

/**
 * LED plus a named dimension and its value, such as "compile · compiled, 5 outputs".
 * There is deliberately no generic OK: both dimension and value are required.
 */
export function SbStatus({ led, dimension, value, pulse }: { led: SbLed; dimension: string; value: string; pulse?: "breathe" | "blink" }) {
  return <span className="sb-st" data-led={led}>
    <span className="sb-led" data-state={led} data-pulse={pulse} aria-hidden="true" />
    <span className="sb-st-dim">{dimension}</span>
    <span className="sb-st-value">{value}</span>
  </span>;
}
