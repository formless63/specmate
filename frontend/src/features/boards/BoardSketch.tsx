import { Button, Group, Stack, Text } from '@mantine/core';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BoardDrawing } from './BoardDrawing';
import { layoutBoard } from './board-layout';
import type { Board } from './api';

export type BoardSelection = { pad: string } | { path: string } | null;
/** Inspection is inert. Only the explicit drawing mode may add a declared path. */
export function BoardSketch({ board, title, editable, selected, onSelect, onChange }: {
  board: Board; title: string; editable: boolean; selected: BoardSelection;
  onSelect: (value: BoardSelection) => void; onChange: (board: Board) => void;
}) {
  const [drawing, setDrawing] = useState(false); const [armed, setArmed] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const stage = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0]?.contentRect ?? { width: 0, height: 0 };
      // Hidden retained records report zero; keep their last fit until visible again.
      if (width > 0 && height > 0) setBounds(previous => previous?.width === width && previous.height === height ? previous : { width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const layout = useMemo(() => layoutBoard(board), [board]);
  const scale = bounds ? Math.min(bounds.width / layout.width, bounds.height / layout.height) * zoom : null;
  const pickPad = (id: string) => {
    onSelect({ pad: id });
    if (!editable || !drawing) return;
    if (!armed || armed === id) { setArmed(armed === id ? null : id); return; }
    let number = board.paths.length + 1;
    while (board.paths.some(path => path.local_id === `path-${number}`)) number += 1;
    const local_id = `path-${number}`;
    onChange({ ...board, paths: [...board.paths, { local_id, from_terminal: armed, to_terminal: id, via: 'unknown', component: null, switch: null, provenance: 'declared', basis: '' }] });
    setArmed(null); setDrawing(false); onSelect({ path: local_id });
  };
  return <Stack gap="xs"><Group gap="xs">
    <Button size="xs" variant="quiet" onClick={() => setZoom(1)}>Fit diagram</Button>
    <Button size="xs" variant="quiet" aria-label="Zoom diagram in" onClick={() => setZoom(value => Math.min(3, value + .25))}>+</Button>
    <Button size="xs" variant="quiet" aria-label="Zoom diagram out" onClick={() => setZoom(value => Math.max(.5, value - .25))}>−</Button>
    {editable && <Button size="xs" variant="quiet" disabled={board.terminals.length < 2} aria-pressed={drawing} onClick={() => { setDrawing(value => !value); setArmed(null); }}>Draw path</Button>}
    {selected && <Button size="xs" variant="quiet" onClick={() => { onSelect(null); setArmed(null); }}>Clear selection</Button>}
  </Group>
    {drawing && <Text size="xs" role="status">{armed ? `Choose the second pad after ${board.terminals.find(pad => pad.terminal_id === armed)?.label ?? armed}.` : 'Choose two pads, then declare the path kind and basis in Paths.'}</Text>}
    <div ref={stage} className="board-record-stage"><div className="board-record-fit" style={{ width: scale === null ? "100%" : layout.width * scale, height: scale === null ? "100%" : layout.height * scale, marginInline: "auto", minWidth: 0 }}>
      {board.terminals.length ? <BoardDrawing board={board} layout={layout} title={title}
        selectedPad={selected && 'pad' in selected ? selected.pad : null} selectedPath={selected && 'path' in selected ? selected.path : null}
        armedPad={editable && drawing ? armed : null} onPad={pickPad} onPath={id => { setArmed(null); onSelect({ path: id }); }} />
        : <div className="board-record-empty"><Text>No pads declared.</Text><Text size="sm">Add a pad in the Pads inspector. Shape, dimensions and connections remain unknown.</Text></div>}
    </div></div>
    <Text size="xs" c="dimmed">{board.carried_connectors.length > 1 ? `${board.carried_connectors.length} carried bodies declared; the schematic arrangement shows the first. Inspect all exact bodies in Carries. ` : ''}Declared topology. The dashed outline is a schematic placeholder, not board geometry or physical continuity.</Text>
  </Stack>;
}
