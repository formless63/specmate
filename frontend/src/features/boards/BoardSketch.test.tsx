import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { BoardSketch, type BoardSelection } from './BoardSketch';
import { emptyBoard, type Board } from './api';
afterEach(cleanup);
const initial: Board = { ...emptyBoard(), terminals: ['A', 'B'].map(label => ({ terminal_id: label.toLowerCase(), label, kind: 'solder_pad', side: 'top', group: null, native_pad_ids: [], note: null })) };
let latest: Board;
function Harness() { const [board, setBoard] = useState(initial); const [selected, setSelected] = useState<BoardSelection>(null); latest = board; return <BoardSketch board={board} title="Synthetic" editable selected={selected} onSelect={setSelected} onChange={setBoard} />; }
test('normal keyboard pad inspection never creates a path; explicit drawing adds an unknown declared path', () => {
  render(<MantineProvider env="test"><Harness /></MantineProvider>); fireEvent.keyDown(screen.getByRole('button', { name: 'Pad A' }), { key: 'Enter' }); fireEvent.keyDown(screen.getByRole('button', { name: 'Pad B' }), { key: ' ' }); expect(latest.paths).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Draw path' })); fireEvent.click(screen.getByRole('button', { name: 'Pad A' })); fireEvent.keyDown(screen.getByRole('button', { name: 'Pad B' }), { key: 'Enter' }); expect(latest.paths).toEqual([{ local_id: 'path-1', from_terminal: 'a', to_terminal: 'b', via: 'unknown', component: null, switch: null, provenance: 'declared', basis: '' }]); expect(screen.getByRole('button', { name: 'Draw path' }).getAttribute('aria-pressed')).toBe('false');
});
test('frozen drawing stays inspectable without a path-creation mode', () => { const changed = vi.fn(); render(<MantineProvider env="test"><BoardSketch board={initial} title="Frozen" editable={false} selected={null} onSelect={vi.fn()} onChange={changed} /></MantineProvider>); fireEvent.click(screen.getByRole('button', { name: 'Pad A' })); fireEvent.click(screen.getByRole('button', { name: 'Pad B' })); expect(changed).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: 'Draw path' })).toBeNull(); });
