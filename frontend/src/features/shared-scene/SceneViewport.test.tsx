import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import SceneViewport from './SceneViewport';
import { syntheticScene } from './test-fixtures';

const lifecycle = vi.hoisted(() => ({ draw: vi.fn(), dispose: vi.fn(), loss: vi.fn(), construct: vi.fn(), disconnect: vi.fn() }));
vi.mock('three', async original => ({ ...await original<typeof import('three')>(), WebGLRenderer: class {
  domElement = document.createElement('canvas');
  constructor() { lifecycle.construct(); }
  setPixelRatio() {} setSize() {}
  render = lifecycle.draw; dispose = lifecycle.dispose; forceContextLoss = lifecycle.loss;
} }));
beforeEach(() => { vi.clearAllMocks(); vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600); vi.stubGlobal('ResizeObserver', class { observe() {} disconnect = lifecycle.disconnect; }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const scene = syntheticScene();
const show = (arrangement: 'canonical' | 'inspection' = 'canonical') => <MantineProvider><SceneViewport scene={scene} arrangement={arrangement} selected={scene.nodes[1]!.address} onSelect={vi.fn()} /></MantineProvider>;

test('one context renders only on demand, changes layout and orthographic views, then disposes on close', () => {
  const raf = vi.spyOn(window, 'requestAnimationFrame');
  const view = render(show()); const drawn = lifecycle.draw.mock.calls.length;
  expect(drawn).toBeGreaterThan(0); view.rerender(show('inspection'));
  fireEvent.click(screen.getByRole('button', { name: 'Orthographic top' })); fireEvent.click(screen.getByRole('button', { name: 'Orthographic end' }));
  expect(lifecycle.draw.mock.calls.length).toBeGreaterThan(drawn); expect(lifecycle.construct).toHaveBeenCalledTimes(1);
  expect(raf).not.toHaveBeenCalled(); view.unmount();
  expect(lifecycle.dispose).toHaveBeenCalledTimes(1); expect(lifecycle.loss).toHaveBeenCalledTimes(1); expect(lifecycle.disconnect).toHaveBeenCalledTimes(1);
});

test('hidden panel or document never draws; visibility restores retained resources', () => {
  let width = 600, resize = () => {};
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  const view = render(show()); const before = lifecycle.draw.mock.calls.length;
  width = 0; act(() => resize()); view.rerender(show('inspection')); expect(lifecycle.draw).toHaveBeenCalledTimes(before);
  width = 600; act(() => resize()); const visible = lifecycle.draw.mock.calls.length; expect(visible).toBeGreaterThan(before);
  visibility.mockReturnValue('hidden'); act(() => document.dispatchEvent(new Event('visibilitychange'))); view.rerender(show()); expect(lifecycle.draw).toHaveBeenCalledTimes(visible);
  visibility.mockReturnValue('visible'); act(() => document.dispatchEvent(new Event('visibilitychange'))); expect(lifecycle.draw).toHaveBeenCalledTimes(visible + 1);
});

test('context loss suppresses all later draws and closing/reopening obtains a fresh context', () => {
  const view = render(show()); const canvas = screen.getByLabelText('Interactive shared engineering scene');
  fireEvent(canvas, new Event('webglcontextlost', { cancelable: true })); const before = lifecycle.draw.mock.calls.length;
  expect(screen.getByRole('alert').textContent).toContain('context was lost');
  fireEvent.click(screen.getByRole('button', { name: 'Orthographic top' })); view.rerender(show('inspection')); expect(lifecycle.draw).toHaveBeenCalledTimes(before);
  view.unmount(); render(show()); expect(lifecycle.construct).toHaveBeenCalledTimes(2); expect(screen.queryByRole('alert')).toBeNull();
});
