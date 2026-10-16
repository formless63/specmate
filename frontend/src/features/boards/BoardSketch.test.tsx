import { MantineProvider } from '@mantine/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { BoardSketch, type BoardSelection } from './BoardSketch';
import { emptyBoard, type Board } from './api';
beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const initial: Board = { ...emptyBoard(), terminals: ['A', 'B'].map(label => ({ terminal_id: label.toLowerCase(), label, kind: 'solder_pad', side: 'top', group: null, native_pad_ids: [], note: null })) };
let latest: Board;
function Harness() { const [board, setBoard] = useState(initial); const [selected, setSelected] = useState<BoardSelection>(null); latest = board; return <BoardSketch board={board} title="Synthetic" editable selected={selected} onSelect={setSelected} onChange={setBoard} />; }
test('normal keyboard pad inspection never creates a path; explicit drawing adds an unknown declared path', () => {
  render(<MantineProvider env="test"><Harness /></MantineProvider>); fireEvent.keyDown(screen.getByRole('button', { name: 'Pad A' }), { key: 'Enter' }); fireEvent.keyDown(screen.getByRole('button', { name: 'Pad B' }), { key: ' ' }); expect(latest.paths).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Draw path' })); fireEvent.click(screen.getByRole('button', { name: 'Pad A' })); fireEvent.keyDown(screen.getByRole('button', { name: 'Pad B' }), { key: 'Enter' }); expect(latest.paths).toEqual([{ local_id: 'path-1', from_terminal: 'a', to_terminal: 'b', via: 'unknown', component: null, switch: null, provenance: 'declared', basis: '' }]); expect(screen.getByRole('button', { name: 'Draw path' }).getAttribute('aria-pressed')).toBe('false');
});
test('frozen drawing stays inspectable without a path-creation mode', () => { const changed = vi.fn(); render(<MantineProvider env="test"><BoardSketch board={initial} title="Frozen" editable={false} selected={null} onSelect={vi.fn()} onChange={changed} /></MantineProvider>); fireEvent.click(screen.getByRole('button', { name: 'Pad A' })); fireEvent.click(screen.getByRole('button', { name: 'Pad B' })); expect(changed).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: 'Draw path' })).toBeNull(); });

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

test('internal passage nodes are drawn distinctly and cannot become pad selections', () => {
  const select = vi.fn();
  const board: Board = { ...initial, schema_version: '0.2', internal_nodes: [{ node_id: 'between', label: 'Between parts', basis: 'Declared series path' }], paths: [
    { local_id: 'first', from_terminal: 'a', to_terminal: 'between', via: 'component', component: { kind: 'capacitor', value: '100 nF', reference: 'C1', capacitance_f: '0.0000001', resistance_ohm: null }, switch: null, provenance: 'declared', basis: 'Declared' },
    { local_id: 'second', from_terminal: 'between', to_terminal: 'b', via: 'component', component: { kind: 'resistor', value: '2k2', reference: 'R1', resistance_ohm: '2200', capacitance_f: null }, switch: null, provenance: 'declared', basis: 'Declared' },
  ] };
  render(<MantineProvider env="test"><BoardSketch board={board} title="Series" editable selected={null} onSelect={select} onChange={vi.fn()} /></MantineProvider>);
  expect(screen.getByRole('img', { name: 'Internal graph node Between parts, not a physical pad' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Pad Between parts' })).toBeNull();
  expect(screen.getAllByRole('button', { name: /^Path / })).toHaveLength(2);
  fireEvent.keyDown(screen.getByRole('img', { name: 'Internal graph node Between parts, not a physical pad' }), { key: 'Enter' });
  expect(select).not.toHaveBeenCalled();
});
