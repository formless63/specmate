import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { BoardSketch } from './BoardSketch';
import { emptyBoard } from './api';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
for (const [width, height] of [[900, 500], [360, 400]] as const) {
  test(`a tall board initially fits both ${width}×${height} bounds, follows resizing and restores after zoom`, () => {
    let resize: (width: number, height: number) => void = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: (entries: unknown[]) => void) {}
      observe() { resize = (width, height) => this.callback([{ contentRect: { width, height } }]); }
      disconnect = disconnect;
    });
    const board = { ...emptyBoard(), terminals: Array.from({ length: 48 }, (_, i) => ({ terminal_id: `pad-${i}`, label: String(i + 1), kind: 'solder_pad' as const, group: null, side: 'top' as const, native_pad_ids: [], note: null })) };
    const select = vi.fn(), change = vi.fn();
    const view = render(<MantineProvider><BoardSketch board={board} title="Tall board" editable={false} selected={null} onSelect={select} onChange={change} /></MantineProvider>);
    const fit = view.container.querySelector<HTMLElement>('.board-record-fit')!;
    const dimensions = (): [number, number] => [parseFloat(fit.style.width), parseFloat(fit.style.height)];
    act(() => resize(width, height));
    const initial = dimensions();
    expect(initial[0]).toBeLessThanOrEqual(width); expect(initial[1]).toBeLessThanOrEqual(height);
    expect(initial[1]).toBeCloseTo(height); // Height, rather than width, constrains this tall drawing.
    fireEvent.click(screen.getByRole('button', { name: 'Zoom diagram in' })); expect(dimensions()[1]).toBeGreaterThan(height);
    fireEvent.click(screen.getByRole('button', { name: 'Fit diagram' })); expect(dimensions()).toEqual(initial);
    act(() => resize(300, 260)); expect(dimensions()[0]).toBeLessThanOrEqual(300); expect(dimensions()[1]).toBeLessThanOrEqual(260);
    const retained = dimensions(); act(() => resize(0, 0)); expect(dimensions()).toEqual(retained);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Pad 48' }), { key: 'Enter' }); expect(select).toHaveBeenCalledWith({ pad: 'pad-47' }); expect(change).not.toHaveBeenCalled();
    view.unmount(); expect(disconnect).toHaveBeenCalled();
  });
}
