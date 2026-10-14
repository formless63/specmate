import { Fragment, type ReactNode } from "react";

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
    parts.push(<abbr key={`h${at}`} title={match[0]} className="sb-mono sb-hash" data-full={match[0]} style={{ textDecoration: "none" }}>{shortenMiddle(match[0])}</abbr>);
    last = at + match[0].length;
  }
  if (last < text.length) parts.push(<Fragment key={`t${last}`}>{text.slice(last)}</Fragment>);
  return <>{parts}</>;
}
