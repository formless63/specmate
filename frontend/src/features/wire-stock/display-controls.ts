import type { Section } from '../../../../packages/section-layout/src';
import type { DisplayProfile, End } from '../../../../packages/wire-geometry/src/model';

export type StripLayer = 'jacket' | 'sheath' | 'screen' | 'insulation';
/** Grouped controls change only explicitly selected display cuts, never engineering content. */
export function layerPaths(section: Section, layer: StripLayer): string[] {
  return section.rows.filter(row => layer === 'jacket' ? row.kind === 'jacket' && row.path.split('.').length === 2 : layer === 'sheath' ? row.kind === 'jacket' && row.path.split('.').length > 2 : layer === 'screen' ? row.kind === 'shield' : row.kind === 'insulation' || row.kind === 'dielectric').map(row => row.path);
}
export function cutValue(profile: DisplayProfile, paths: string[], end: End): number | null {
  const values = paths.map(path => profile.cuts[path]?.[end] ?? (path in profile.cuts ? null : 0));
  return values.length && values.every(value => value === values[0]) ? values[0]! : null;
}
export function withLayerCut(profile: DisplayProfile, paths: string[], end: End, value: number | null): DisplayProfile {
  const cuts = { ...profile.cuts };
  for (const path of paths) cuts[path] = { ...(cuts[path] ?? { a: 0, b: 0 }), [end]: value };
  return { ...profile, id: 'local-preview', label: 'Local display cuts', cuts };
}
