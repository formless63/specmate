import { ActionIcon, Button, Group, Text } from "@mantine/core";
import { useId, useMemo, useState, type KeyboardEvent } from "react";
import type { DrawingInput } from "../../features/cable-workbench/model";
import { schematicRows, type SchematicLanding } from "./schematicModel";
import "./schematic.css";

type Props = DrawingInput & {
  name: string; state: string; unreleased: boolean;
  selection: string | null; onSelect: (key: string | null) => void;
};
const WIDTH = 1200, ROW = 92, TOP = 110;
const short = (value: string, max: number) => value.length > max ? value.slice(0, max - 1) + "…" : value;

/** An interactive declaration sheet. Selecting a mark probes it; this view never edits wiring. */
export function Schematic({ name, state, unreleased, selection, onSelect, ...input }: Props) {
  const rows = useMemo(() => schematicRows(input), [input.cable, input.stacks, input.stock, input.conductors]);
  const [zoom, setZoom] = useState<number | null>(null);
  const hatch = `schematic-unknown-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const height = TOP + Math.max(1, rows.length) * ROW + 50;
  const scale = (delta: number) => setZoom(value => Math.min(2.5, Math.max(0.5, (value ?? 1) + delta)));
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); onSelect(null); return; }
    if (event.target !== event.currentTarget) return;
    if (["+", "=", "-", "0"].includes(event.key)) event.preventDefault();
    if (event.key === "+" || event.key === "=") scale(0.25);
    if (event.key === "-") scale(-0.25);
    if (event.key === "0") setZoom(null);
  };
  const pick = (target: string) => onSelect(selection === target ? null : target);
  const activate = (target: string) => ({ onClick: () => pick(target), onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); pick(target); }
  } });
  const landing = (value: SchematicLanding, index: number, y: number) => {
    const x = index === 0 ? 30 : 820;
    return <g key={index} className="editor-schematic-landing" data-state={value.state} data-selected={value.key && value.key === selection || undefined}
      role={value.key ? "button" : undefined} tabIndex={value.key ? 0 : undefined} aria-label={`${value.end}: ${value.target}`} aria-pressed={value.key ? value.key === selection : undefined}
      {...value.key ? activate(value.key) : {}}>
      <rect x={x} y={y - 21} width={350} height={56} rx={3} fill={value.state === "declared" ? "white" : `url(#${hatch})`} />
      <text x={x + 10} y={y - 3}>{short(value.target, 43)}</text>
      <text x={x + 10} y={y + 19} className="editor-schematic-sub">{value.state === "declared" ? "declared landing" : value.state === "unresolved" ? "Target not resolved" : "No declared landing"}</text>
      <title>{value.end}: {value.target}{value.basis ? ` · Basis: ${value.basis}` : ""}</title>
    </g>;
  };
  return <section className="editor-schematic" aria-label="Live declared schematic">
    <Group justify="space-between" gap="xs" className="editor-schematic-toolbar">
      <Text size="xs">{state} · {rows.length} element row{rows.length === 1 ? "" : "s"}</Text>
      <Group gap={4} role="group" aria-label="Schematic zoom">
        <ActionIcon aria-label="Zoom schematic out" size="sm" variant="default" onClick={() => scale(-0.25)}>−</ActionIcon>
        <Button size="compact-xs" variant={zoom === null ? "primary" : "default"} onClick={() => setZoom(null)}>Fit schematic</Button>
        <Button size="compact-xs" variant="default" onClick={() => setZoom(1)}>100%</Button>
        <ActionIcon aria-label="Zoom schematic in" size="sm" variant="default" onClick={() => scale(0.25)}>+</ActionIcon>
      </Group>
    </Group>
    <Text size="xs" c="dimmed">Declared terminations only. Physical continuity, routing and test outcomes are not evaluated. Select a wire or terminal to probe the same feature in Build.</Text>
    <div className="editor-schematic-viewport" tabIndex={0} onKeyDown={key} aria-label="Schematic sheet: scroll to pan, plus or minus to zoom, zero to fit, Escape to clear probe">
      <svg className="editor-schematic-sheet" role="group" aria-label={`Declared schematic of ${name}`} viewBox={`0 0 ${WIDTH} ${height}`}
        width={zoom === null ? "100%" : WIDTH * zoom} style={{ minWidth: 0, height: "auto" }}>
        <defs><pattern id={hatch} width={7} height={7} patternUnits="userSpaceOnUse"><rect width={7} height={7} fill="#f4f4f4" /><path d="M0 7L7 0" stroke="#ccc" /></pattern></defs>
        <rect width={WIDTH} height={height} fill="white" />
        <text x={30} y={32} className="editor-schematic-title">{short(name, 100)}</text>
        <text x={30} y={55}>{state}</text>
        {unreleased && <text x={1170} y={32} textAnchor="end" className="editor-schematic-unreleased">UNRELEASED</text>}
        <text x={30} y={87}>{short(input.cable.endpoints[0]?.label || "End A", 43)}</text>
        <text x={440} y={87}>STOCK ELEMENT · DECLARED IDENTITY</text>
        <text x={820} y={87}>{short(input.cable.endpoints[1]?.label || "End B", 43)}</text>
        {rows.map((row, index) => {
          const y = TOP + index * ROW + 23;
          return <g key={row.key} className="editor-schematic-row" data-key={row.key} data-selected={selection === row.key || undefined}>
            {row.ends.map((end, side) => landing(end, side, y))}
            <g role="button" tabIndex={0} aria-label={`Probe wire ${row.label}`} aria-pressed={selection === row.key} {...activate(row.key)} className="editor-schematic-wire">
              <rect x={390} y={y - 21} width={420} height={56} rx={3} fill={row.stock === "declared" ? "#f4f7fb" : `url(#${hatch})`} />
              {row.ends.map((end, side) => <path key={side} d={`M${side === 0 ? 380 : 810} ${y + 4}h10`} strokeDasharray={end.state !== "declared" ? "4 3" : undefined} />)}
              <circle cx={406} cy={y - 1} r={5} fill={row.color || `url(#${hatch})`} />
              <text x={420} y={y - 1}>{short(row.label, 47)}</text>
              <text x={400} y={y + 21} className="editor-schematic-sub">{row.stock === "missing" ? "NOT IN PINNED STOCK" : row.stock === "unknown" ? "Stock membership not evaluated" : `${row.kind} · ${short(row.path, 42)}`}</text>
              <title>{row.path} · {row.kind}. The stock feature is a shared identity; physical continuity is not evaluated.</title>
            </g>
          </g>;
        })}
        {!rows.length && <text x={30} y={TOP + 23}>No conductive elements are available. Stock connectivity is unknown.</text>}
        <text x={30} y={height - 20} className="editor-schematic-sub">Authored assignments and exact pinned sources; no inferred connections across unresolved targets.</text>
      </svg>
    </div>
  </section>;
}
