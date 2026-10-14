import { MantineProvider } from '@mantine/core';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { sectionLayout } from '../../../../packages/section-layout/src';
import { unpreparedProfile, wireModel } from '../../../../packages/wire-geometry/src/model';
import { stockPresets } from './presets';
import WireViewport from './WireViewport';

const lifecycle = vi.hoisted(() => ({ render: vi.fn(), dispose: vi.fn(), loss: vi.fn(), construct: vi.fn(), disconnected: vi.fn() }));
vi.mock('three', async original => ({ ...await original<typeof import('three')>(), WebGLRenderer: class {
  domElement = document.createElement('canvas');
  constructor() { lifecycle.construct(); }
  setPixelRatio() {} setSize() {}
  render = lifecycle.render;
  dispose = lifecycle.dispose;
  forceContextLoss = lifecycle.loss;
} }));
beforeEach(() => { vi.clearAllMocks(); vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('reuses one context across model edits, renders on demand, and cleans up on close', () => {
  vi.stubGlobal('ResizeObserver', class {
    target: Element | null = null;
    observe(el: Element) { this.target = el; }
    disconnect = () => { if (this.target?.classList.contains('sb-viewer-3d')) lifecycle.disconnected(); };
  });
  const raf = vi.spyOn(window, 'requestAnimationFrame');
  const section = sectionLayout(stockPresets.coax!);
  const first = wireModel(section, 50, unpreparedProfile());
  const show = (length: number) => <MantineProvider><WireViewport model={length === 50 ? first : wireModel(section, length, unpreparedProfile())} /></MantineProvider>;
  const view = render(show(50));
  expect(lifecycle.construct).toHaveBeenCalledTimes(1);
  const initialRenders = lifecycle.render.mock.calls.length;
  expect(initialRenders).toBeGreaterThan(0);
  view.rerender(show(75));
  expect(lifecycle.construct).toHaveBeenCalledTimes(1);
  expect(lifecycle.loss).not.toHaveBeenCalled();
  expect(lifecycle.render.mock.calls.length).toBeGreaterThan(initialRenders);
  expect(raf).not.toHaveBeenCalled();
  view.unmount();
  expect(lifecycle.dispose).toHaveBeenCalledTimes(1);
  expect(lifecycle.loss).toHaveBeenCalledTimes(1);
  expect(lifecycle.disconnected).toHaveBeenCalledTimes(1);
  raf.mockRestore();
});

test('hidden tabs and documents suppress drawing and reveal renders the retained model', () => {
  let width = 600;
  let resize = () => {};
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: () => void) {}
    observe(el: Element) { if (el.classList.contains('sb-viewer-3d')) resize = this.callback; }
    disconnect = lifecycle.disconnected;
  });
  const section = sectionLayout(stockPresets.coax!);
  const show = (length: number) => <MantineProvider><WireViewport model={wireModel(section, length, unpreparedProfile())} /></MantineProvider>;
  const view = render(show(50));
  const drawn = lifecycle.render.mock.calls.length;
  expect(drawn).toBeGreaterThan(0);
  width = 0;
  act(() => resize());
  view.rerender(show(75));
  expect(lifecycle.render).toHaveBeenCalledTimes(drawn);
  expect(lifecycle.construct).toHaveBeenCalledTimes(1);
  width = 600;
  act(() => resize());
  expect(lifecycle.render.mock.calls.length).toBeGreaterThan(drawn);
  const revealed = lifecycle.render.mock.calls.length;
  visibility.mockReturnValue('hidden');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  view.rerender(show(100));
  expect(lifecycle.render).toHaveBeenCalledTimes(revealed);
  visibility.mockReturnValue('visible');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(lifecycle.render).toHaveBeenCalledTimes(revealed + 1);
  view.unmount();
  const closed = lifecycle.render.mock.calls.length;
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(lifecycle.render).toHaveBeenCalledTimes(closed);
  expect(lifecycle.dispose).toHaveBeenCalledTimes(1);
  expect(lifecycle.loss).toHaveBeenCalledTimes(1);
});

test('top and front camera presets reframe the retained model on demand', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect = lifecycle.disconnected; });
  const { fireEvent, screen } = await import('@testing-library/react');
  const section = sectionLayout(stockPresets.coax!);
  render(<MantineProvider><WireViewport model={wireModel(section, 50, unpreparedProfile())} /></MantineProvider>);
  for (const name of ['Top view', 'Front view']) {
    const before = lifecycle.render.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name }));
    expect(lifecycle.render.mock.calls.length).toBeGreaterThan(before);
  }
  expect(lifecycle.construct).toHaveBeenCalledTimes(1);
});

test('explode slider is stepped under reduced motion, offsets apply without a rebuild, x-ray toggles', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect = lifecycle.disconnected; });
  const { fireEvent, screen } = await import('@testing-library/react');
  const raf = vi.spyOn(window, 'requestAnimationFrame');
  const section = sectionLayout(stockPresets.coax!);
  const view = render(<MantineProvider><WireViewport model={wireModel(section, 50, unpreparedProfile())} /></MantineProvider>);
  const slider = screen.getByRole('slider');
  expect(slider.getAttribute('aria-valuemax')).toBe('1');
  const before = lifecycle.render.mock.calls.length;
  fireEvent.keyDown(slider, { key: 'ArrowRight' });
  expect(slider.getAttribute('aria-valuenow')).toBe('0.25');
  expect(lifecycle.render.mock.calls.length).toBeGreaterThan(before);
  expect(raf).not.toHaveBeenCalled();
  expect(screen.getByText(/Explode: 25% \(stepped\)/)).toBeTruthy();
  const afterExplode = lifecycle.render.mock.calls.length;
  fireEvent.click(screen.getByRole('switch', { name: 'X-ray' }));
  expect(lifecycle.render.mock.calls.length).toBeGreaterThan(afterExplode);
  fireEvent.click(screen.getByLabelText('Radial'));
  expect(lifecycle.construct).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(lifecycle.dispose).toHaveBeenCalledTimes(1);
});

test('without reduced motion the slider is smooth and eases over the theme motion token, then settles', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const original = window.matchMedia;
  window.matchMedia = ((q: string) => ({ ...original(q), matches: false })) as typeof window.matchMedia;
  const real = window.getComputedStyle;
  vi.spyOn(window, 'getComputedStyle').mockImplementation(el => ({ ...real(el), getPropertyValue: (n: string) => (n === '--sb-motion-quick' ? '120ms' : '') }) as CSSStyleDeclaration);
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => frames.push(cb));
  const { fireEvent, screen } = await import('@testing-library/react');
  try {
    render(<MantineProvider><WireViewport model={wireModel(sectionLayout(stockPresets.coax!), 50, unpreparedProfile())} /></MantineProvider>);
    const slider = screen.getByRole('slider');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(slider.getAttribute('aria-valuenow')).toBe('0.01');
    expect(screen.queryByText(/stepped/)).toBeNull();
    expect(frames.length).toBe(1);
    const before = lifecycle.render.mock.calls.length;
    frames.shift()!(performance.now() + 1000);
    expect(lifecycle.render.mock.calls.length).toBeGreaterThan(before);
    expect(frames.length).toBe(0);
  } finally { window.matchMedia = original; }
});
