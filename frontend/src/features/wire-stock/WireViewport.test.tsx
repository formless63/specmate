import { MantineProvider } from '@mantine/core';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('reuses one context across model edits, renders on demand, and cleans up on close', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect = lifecycle.disconnected; });
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
