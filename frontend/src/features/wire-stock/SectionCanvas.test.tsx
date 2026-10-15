import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { evaluateFit, sectionLayout } from '../../../../packages/section-layout/src';
import { blankSpec, generate } from './builder';
import { fitOverlay } from './builder-visual';
import { SectionCanvas } from './SectionCanvas';

afterEach(cleanup);
const spec = (() => { const s = blankSpec('round', 2); return { ...s, conductor: { ...s.conductor, diameter_mm: 0.5 }, insulation: { od_mm: 1.3, material: null }, shield: 'braid' as const, braid_thickness_mm: 0.1,
  jacket: { od_mm: 3.2, wall_mm: 0.4, material: null, color: null } }; })();
const stock = generate(spec), section = sectionLayout(stock), fit = evaluateFit(stock);

test('keyboard nudges the jacket handle and a drag maps pointer position to OD', () => {
  const onOd = vi.fn();
  const { container } = render(<SectionCanvas section={section} title="t" handle={{ od: 3.2, minOd: 2.85 }} editable onOd={onOd} />);
  const handle = screen.getByRole('slider', { name: 'Jacket outer diameter handle' });
  fireEvent.keyDown(handle, { key: 'ArrowRight' });
  expect(onOd).toHaveBeenLastCalledWith(3.25);
  fireEvent.keyDown(handle, { key: 'ArrowLeft' });
  expect(onOd).toHaveBeenLastCalledWith(3.15);
  // Drag: stub the overlay box so 1 client pixel is 0.01 mm around the centered origin.
  const overlay = container.querySelector('[data-overlay]') as SVGSVGElement;
  const vb = overlay.getAttribute('viewBox')!.split(' ').map(Number) as [number, number, number, number];
  overlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: vb[2] * 100, height: vb[3] * 100, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
  fireEvent.pointerDown(handle, { pointerId: 1 });
  fireEvent(window, Object.assign(new Event('pointermove'), { clientX: (0 - vb[0]) * 100 + 2.5 * 100, clientY: (0 - vb[1]) * 100 }));
  expect(onOd).toHaveBeenLastCalledWith(5);
  fireEvent(window, new Event('pointerup'));
});

test('fit failures are drawn on the section with a numbered callout and a worded list', () => {
  const { container } = render(<SectionCanvas section={section} title="t" handle={null} editable={false} overlay={fitOverlay(section, fit)} />);
  expect(container.querySelector('[data-fit-bore="stock.jacket"]')).toBeTruthy();
  expect(container.querySelector('[data-fit-band]')).toBeTruthy();
  expect(container.querySelector('[data-fit-ring]')).toBeTruthy();
  expect(container.querySelector('[data-fit-callout="1"]')).toBeTruthy();
  expect(screen.getByLabelText('Fit problems').textContent).toMatch(/won't fit .* bore .* mm \(\+/);
  expect(screen.queryByRole('slider')).toBeNull();
});
