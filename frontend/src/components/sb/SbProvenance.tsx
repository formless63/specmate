import { ExactPins, type ExactPin } from "../../lib/IdentityLabel";
import "./sb-components.css";

/** Human summary first; the exact pins (IDs, hashes) stay one disclosure away. */
export function SbProvenance({ summary, pins, label = "Provenance" }: { summary: string; pins: ExactPin[]; label?: string }) {
  return <div className="sb-prov">
    <div className="sb-prov-summary"><span className="sb-silk">{label}</span><span>{summary}</span><ExactPins pins={pins} /></div>
  </div>;
}
