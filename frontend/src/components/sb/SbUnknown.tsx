import type { ReactNode } from "react";
import "./sb-components.css";

/** A hatched statement that a fact is not recorded, with an optional next step. Never zero, never OK. */
export function SbUnknown({ what, next }: { what?: string; next?: ReactNode }) {
  return <span className="sb-unknown" data-unknown="true">
    <span aria-hidden="true">– – –</span>
    <span>{what ? `${what} unknown` : "unknown"}</span>
    {next && <span className="sb-unknown-next">{next}</span>}
  </span>;
}
