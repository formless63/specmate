import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Plane } from 'three';
import SceneViewport from './SceneViewport';
import { syntheticScene } from './test-fixtures';

const lifecycle = vi.hoisted(() => ({ draw: vi.fn(), dispose: vi.fn(), loss: vi.fn(), construct: vi.fn(), disconnect: vi.fn(), planes: vi.fn() }));
vi.mock('three', async original => ({ ...await original<typeof import('three')>(), WebGLRenderer: class {
  domElement = document.createElement('canvas');
  constructor() { lifecycle.construct(); }
  setPixelRatio() {} setSize() {}
  set clippingPlanes(value: Plane[]) { lifecycle.planes(value); }
  render = lifecycle.draw; dispose = lifecycle.dispose; forceContextLoss = lifecycle.loss;
} }));
beforeEach(() => { vi.clearAllMocks(); vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600); vi.stubGlobal('ResizeObserver', class {
  viewport = false;
  observe(target: Element) { this.viewport = !!target.querySelector('[aria-label="Interactive shared engineering scene"]'); }
  unobserve() {}
  disconnect() { if (this.viewport) lifecycle.disconnect(); }
}); });
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
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: () => void) {}
    observe(target: Element) { if (target.querySelector('[aria-label="Interactive shared engineering scene"]')) resize = this.callback; }
    unobserve() {} disconnect() {}
  });
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

test('display opening/explosion/clipping restore canonical inputs and selection without a new renderer', () => {
  const source = syntheticScene(), before = structuredClone(source), select = vi.fn(), restore = vi.fn();
  const view = render(<MantineProvider><SceneViewport scene={source} arrangement="canonical" selected={source.nodes[1]!.address} onSelect={select} onRestoreCanonical={restore} /></MantineProvider>);
  fireEvent.click(screen.getByLabelText('Exploded display'));
  fireEvent.click(screen.getByRole('button', { name: 'Open displayed occurrence branch' }));
  expect(screen.getByText(/Displayed open branch: right\/board/)).toBeTruthy();
  fireEvent.click(screen.getByLabelText('Illustrative section clipping'));
  fireEvent.change(screen.getByLabelText('Section chosen world display offset (mm)'), { target: { value: '5' } });
  const plane = (lifecycle.planes.mock.calls.at(-1)![0] as Plane[])[0]!;
  expect(plane.normal.toArray()).toEqual([0, 0, 1]); expect(plane.constant).toBe(-5);
  fireEvent.click(screen.getByRole('button', { name: 'Orthographic front' }));
  fireEvent.click(screen.getByRole('button', { name: 'Restore canonical display' }));
  expect(restore).toHaveBeenCalledTimes(1); expect(select).not.toHaveBeenCalled();
  expect((screen.getByLabelText('Exploded display') as HTMLInputElement).checked).toBe(false);
  expect((screen.getByLabelText('Illustrative section clipping') as HTMLInputElement).checked).toBe(false);
  expect(lifecycle.planes.mock.calls.at(-1)![0]).toEqual([]);
  expect(screen.queryByText(/Displayed open branch:/)).toBeNull(); expect(source).toEqual(before);
  expect(lifecycle.construct).toHaveBeenCalledTimes(1); view.unmount(); expect(lifecycle.dispose).toHaveBeenCalledTimes(1);
});

test('snapshot replacement disposes old geometry/display state before its new scope is shown', () => {
  const source = syntheticScene(), select = vi.fn();
  const showScope = (value: typeof source) => <MantineProvider><SceneViewport scene={value} arrangement="canonical" selected={value.nodes[1]!.address} onSelect={select} /></MantineProvider>;
  const view = render(showScope(source)); fireEvent.click(screen.getByLabelText('Exploded display'));
  fireEvent.click(screen.getByRole('button', { name: 'Open displayed occurrence branch' }));
  const replacement = structuredClone(source); replacement.sha256 = 'f'.repeat(64);
  view.rerender(showScope(replacement));
  expect(lifecycle.dispose).toHaveBeenCalledTimes(1); expect(lifecycle.construct).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(/Displayed open branch:/)).toBeNull(); expect((screen.getByLabelText('Exploded display') as HTMLInputElement).checked).toBe(false);
  expect(select).not.toHaveBeenCalled();
});

test('unknown world frame or local inspection cannot invent an opening pivot', () => {
  const source = syntheticScene(); source.nodes[1]!.world_transform = null;
  const view = render(<MantineProvider><SceneViewport scene={source} arrangement="canonical" selected={source.nodes[1]!.address} onSelect={vi.fn()} /></MantineProvider>);
  expect((screen.getByRole('button', { name: 'Open displayed occurrence branch' }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(show('inspection'));
  expect((screen.getByRole('button', { name: 'Open displayed occurrence branch' }) as HTMLButtonElement).disabled).toBe(true);
});
