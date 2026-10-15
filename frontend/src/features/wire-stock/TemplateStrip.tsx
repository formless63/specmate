import { useMemo } from 'react';
import { renderSectionSvg, sectionLayout } from '../../../../packages/section-layout/src';
import { usePermission } from '../../lib/permissions';
import { blankSpec, generate, illustrate, TEMPLATES } from './builder';
import type { TemplateKind } from './builder';

/** One drawn mini cross-section per template, with placeholder proportions (a picture of the shape, not dimensions). */
function mini(kind: TemplateKind): string {
  const drawn = illustrate(blankSpec(kind, kind === 'multicoax' ? 3 : kind === 'round' ? 3 : undefined)).spec;
  return renderSectionSvg(sectionLayout(generate(drawn)), TEMPLATES.find(t => t.value === kind)!.label, { callouts: false });
}

/** Compact strip for starting a new construction from a drawn template. */
export function TemplateStrip({ onChoose }: { onChoose: (kind: TemplateKind) => void }) {
  const edit = usePermission('item.create');
  const pictures = useMemo(() => TEMPLATES.map(t => ({ ...t, svg: mini(t.value) })), []);
  return <div role="group" aria-label="New construction" className="sb-template-strip">
    {pictures.map(t => <button key={t.value} type="button" className="sb-template-strip__item" aria-label={`New ${t.label}`} title={`${t.label}: ${t.hint}`} onClick={() => onChoose(t.value)} {...edit.props}>
      <span className="sb-template-strip__art" aria-hidden="true" dangerouslySetInnerHTML={{ __html: t.svg }} />
      <span className="sb-silk">{t.label}</span>
    </button>)}
  </div>;
}
