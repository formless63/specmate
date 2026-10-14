import { appearanceOf, edgeColor } from '../../../../packages/section-layout/src';
import type { Appearance, SectionRow } from '../../../../packages/section-layout/src';

/** Small chip in the element's drawn colour. Unknown colour is hatched, never a guessed hue. */
export function Swatch({ look, size = 14 }: { look: Appearance; size?: number }) {
  const unknown = look.fillSource === 'unknown';
  const edge = edgeColor(look.base);
  const background = unknown
    ? `repeating-linear-gradient(45deg, ${look.base} 0 3px, #3d444b 3px 4px)`
    : look.stripe ? `linear-gradient(90deg, ${look.base} 0 62%, ${look.stripe} 62% 80%, ${look.base} 80%)` : look.base;
  return <span role="img" aria-label={`${look.colorLabel === 'Unknown' ? 'Colour unknown' : `Colour ${look.colorLabel}`}${look.fillSource === 'material-typical' ? ' (typical for material)' : ''}`}
    data-fill-source={look.fillSource}
    style={{ display: 'inline-block', width: size, height: size, borderRadius: '50%', verticalAlign: 'middle', marginRight: 6, background, border: `1px solid ${edge}`, boxSizing: 'border-box' }} />;
}

export const rowLook = (row: SectionRow): Appearance => appearanceOf({ kind: row.kind, color: row.color, material: row.material, construction: row.construction ?? null });
