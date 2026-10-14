import { Fragment, type ReactNode } from "react";

function copyFull(value: string) {
  try { void navigator.clipboard?.writeText(value); } catch { /* clipboard unavailable: the full value is still in the title */ }
}

const LONG_ID = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{24,}/gi;

/** Shortens one long hash or ID in the middle; the full value stays in the title and in the copied text. */
export function shortenMiddle(value: string, head = 6, tail = 4): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Text with every long hex hash or UUID abbreviated in the middle (full value on hover and on copy). */
export function MiddleTruncate({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(LONG_ID)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(<Fragment key={`t${last}`}>{text.slice(last, at)}</Fragment>);
    const full = match[0];
    parts.push(<span key={`h${at}`} style={{ whiteSpace: "nowrap" }}>
      <abbr title={full} className="sb-mono sb-hash" data-full={full} style={{ textDecoration: "none" }}>{shortenMiddle(full)}</abbr>
      <button type="button" className="sb-hash-copy" aria-label={`Copy ${full}`} title="Copy full value" onClick={() => copyFull(full)}
        style={{ border: 0, background: "none", color: "inherit", cursor: "pointer", padding: "0 2px", font: "inherit", fontSize: "0.85em" }}>{"\u29c9"}</button>
    </span>);
    last = at + match[0].length;
  }
  if (last < text.length) parts.push(<Fragment key={`t${last}`}>{text.slice(last)}</Fragment>);
  return <>{parts}</>;
}
