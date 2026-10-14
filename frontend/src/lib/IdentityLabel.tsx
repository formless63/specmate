import { useId, useState } from "react";
import type { ReactNode } from "react";
import { useRevisionLabel, type RevisionLabelData } from "./revision-labels";

/** One exact identifier or hash as inspectable evidence: monospace with a copy control. */
export function ExactId({ label, value }: { label: string; value: string }) {
  const copy = () => {
    try { void navigator.clipboard?.writeText(value); } catch { /* clipboard unavailable: the value stays selectable */ }
  };
  return <span className="sb-exact-row">
    <span className="sb-silk">{label}</span>
    <code className="sb-mono sb-exact-value">{value}</code>
    <button type="button" className="sb-exact-copy" aria-label={`Copy ${label}`} onClick={copy}>copy</button>
  </span>;
}

export type ExactPin = { label: string; value: string | null | undefined };

/**
 * Collapsed by default. The values stay in the document (hidden) for assistive
 * technology and tests. Spans only, so the label can sit inside paragraphs.
 */
export function ExactPins({ pins, summary = "exact pins" }: { pins: ExactPin[]; summary?: string }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const present = pins.filter((pin): pin is { label: string; value: string } => Boolean(pin.value));
  if (!present.length) return null;
  return <span className="sb-exact">
    <button type="button" className="sb-exact-toggle" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(value => !value)}>
      {open ? "\u25BE" : "\u25B8"} {summary}
    </button>
    <span id={panel} className="sb-exact-body" hidden={!open}>{present.map(pin => <ExactId key={pin.label} label={pin.label} value={pin.value} />)}</span>
  </span>;
}

/** Name first (sans, weight 500), kind as silk label, revision as mono rN. */
export function IdentityLabel({ name, kind, number, role, state, pins, children }: {
  name?: string | null; kind?: string | null; number?: number | null; role?: string;
  state?: "resolving" | "unreadable" | "unavailable" | "unrecorded"; pins?: ExactPin[]; children?: ReactNode;
}) {
  const shown = state === "unreadable" ? "Not readable by you"
    : state === "unavailable" ? "Name unavailable"
    : state === "unrecorded" ? "Not recorded"
    : state === "resolving" ? "Resolving name…"
    : name || "Unnamed definition";
  return <span className="sb-ident" data-state={state ?? "resolved"}>
    {role && <span className="sb-silk">{role}</span>}
    <span className={state ? "sb-ident-name sb-ident-unknown" : "sb-ident-name"}>{shown}</span>
    {!state && kind && <span className="sb-silk">{kind}</span>}
    {!state && number != null && <span className="sb-mono sb-ident-rev">r{number}</span>}
    {children}
    {pins && <ExactPins pins={pins} />}
  </span>;
}

export type RevisionLabelProps = {
  /** Exact revision ID; always kept in the "exact pins" disclosure. */
  id: string | null | undefined;
  /** Short role shown as a silk label, such as "Stock" or "Profile". */
  role?: string;
  /** Additional exact evidence for the same pin (snapshot hash, snapshot ID). */
  sha256?: string | null;
  snapshotId?: string | null;
  /** Skip the lookup when the caller already holds the display identity. */
  known?: { name: string; kind?: string | null; number: number };
  /** Which kind of revision the ID names; source bundle revisions resolve separately. */
  kind?: "design" | "source";
  /** Extra exact evidence shown only inside the disclosure. */
  extraPins?: ExactPin[];
};

/**
 * Human-readable identity for an exact revision. Names resolve through the scoped
 * revision-label read; a revision the reader cannot read shows "Not readable by you".
 */
export function RevisionLabel({ id, role, sha256, snapshotId, known, kind = "design", extraPins = [] }: RevisionLabelProps) {
  const query = useRevisionLabel(id, !known, kind);
  if (!id) return <IdentityLabel role={role} state="unrecorded" />;
  const pins: ExactPin[] = [{ label: kind === "source" ? "Source revision ID" : "Revision ID", value: id }, { label: "SHA-256", value: sha256 }, { label: "Snapshot ID", value: snapshotId }, ...extraPins];
  if (known) return <IdentityLabel role={role} name={known.name} kind={known.kind} number={known.number} pins={pins} />;
  const data: RevisionLabelData | null = query.data;
  if (!data && query.isError) return <IdentityLabel role={role} state="unavailable" pins={pins} />;
  if (!data) return <IdentityLabel role={role} state="resolving" pins={pins} />;
  if (!data.readable) return <IdentityLabel role={role} state="unreadable" pins={pins} />;
  return <IdentityLabel role={role} name={data.name} kind={data.kind} number={data.number} pins={pins} />;
}
