import { useMemo, useState } from 'react';
import { Group, Stack, Text, UnstyledButton } from '@mantine/core';
import { renderSectionSvg } from '../../../../packages/section-layout/src';
import type { Section } from '../../../../packages/section-layout/src';
import { rowLook, Swatch } from './Swatch';

/** Realistic cut-face drawing with a keyed list. Selection draws a reticle only; it never changes a fill. */
export function StockSectionView({ section, title, label = 'Stock section drawing', selected, onSelect }: {
  section: Section; title: string; label?: string; selected?: string | null; onSelect?: (path: string | null) => void;
}) {
  const [own, setOwn] = useState<string | null>(null);
  const current = selected !== undefined ? selected : own;
  const choose = (path: string | null) => { setOwn(path); onSelect?.(path); };
  const svg = useMemo(() => renderSectionSvg(section, title, { selected: current }), [section, title, current]);
  return <Stack gap="xs">
    <div aria-label={label} className="sb-viewer" style={{ maxWidth: 440, color: 'var(--sb-text-primary)' }}
      onClick={event => { const hit = (event.target as Element).closest('[data-element]'); if (hit) choose(hit.getAttribute('data-element')); }}
      dangerouslySetInnerHTML={{ __html: svg }} />
    <Group gap="xs" role="group" aria-label="Section key">
      {section.rows.map(row => {
        const look = rowLook(row);
        const on = current === row.path;
        return <UnstyledButton key={row.path} aria-pressed={on} onClick={() => choose(on ? null : row.path)}
          title={look.notes.join('; ') || row.path} className="sb-key-chip">
          <Swatch look={look} />{row.tag} {row.label}{look.fillSource === 'unknown' ? ' (color unknown)' : ''}
        </UnstyledButton>;
      })}
    </Group>
    {section.features.some(f => rowLook(section.rows.find(r => r.path === f.path)!).fillSource === 'unknown') &&
      <Text size="xs">Hatched elements have no recorded color or material; they are drawn neutral, not guessed.</Text>}
  </Stack>;
}
