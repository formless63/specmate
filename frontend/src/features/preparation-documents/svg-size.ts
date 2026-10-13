/** Adapted from WireHub by formless63, cbf919edf30a9d906a791971d3a40e22cb78b67e,
 * packages/docs/src/schematic-sheet.ts, AGPL-3.0-only. See NOTICE and LICENSE.
 * Reads the generated inert SVG viewBox only; this is not geometry validation. */
export function svgSize(svg: string): { width: number; height: number } | undefined {
  const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? '';
  const vb = /viewBox="([^"]+)"/.exec(root)?.[1]?.trim().split(/[\s,]+/).map(Number);
  if (vb !== undefined && vb.length === 4 && vb.every(Number.isFinite) && vb[2]! > 0 && vb[3]! > 0) return { width: vb[2]!, height: vb[3]! };
  return undefined;
}
