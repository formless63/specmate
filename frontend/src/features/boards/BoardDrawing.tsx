import type { KeyboardEvent } from "react";
import { pathSummary, type Board, type InlineComponent } from "./api";
import type { BoardLayout, DrawnPad, DrawnPath } from "./board-layout";
import { PAD_H, PAD_W } from "./board-layout";

const SIDE_MARK: Record<string, string> = { top: "T", bottom: "B", both: "T+B", unknown: "?" };

function keyed(handler: () => void) {
  return {
    onClick: (e: { stopPropagation: () => void }) => { e.stopPropagation(); handler(); },
    onKeyDown: (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); handler(); } },
  };
}

/** "R1 470R": what is written beside a part; an unknown exact value is said, never zeroed. */
function partLabel(c: InlineComponent | null): string {
  if (!c) return "part ?";
  const exact = c.kind === "resistor" ? c.resistance_ohm : c.kind === "capacitor" ? c.capacitance_f : null;
  return [c.reference, c.value ?? (exact ? exact : null)].filter(Boolean).join(" ") || `${c.kind} ?`;
}

/** Schematic part symbols drawn on the copper, masking it underneath. */
function ComponentGlyph({ c }: { c: InlineComponent | null }) {
  const kind = c?.kind ?? "unknown";
  if (kind === "resistor") return <rect x={-12} y={-5} width={24} height={10} className="bv-sym" />;
  if (kind === "capacitor") return <g><rect x={-5} y={-8} width={10} height={16} className="bv-sym-mask" /><line x1={-3} y1={-8} x2={-3} y2={8} className="bv-sym-line" /><line x1={3} y1={-8} x2={3} y2={8} className="bv-sym-line" /></g>;
  if (kind === "diode") return <g><rect x={-7} y={-7} width={14} height={14} className="bv-sym-mask" /><path d="M-6 -6 L4 0 L-6 6 Z" className="bv-sym" /><line x1={5} y1={-6} x2={5} y2={6} className="bv-sym-line" /></g>;
  if (kind === "inductor") return <g><rect x={-13} y={-6} width={26} height={8} className="bv-sym-mask" /><path d="M-12 0 a3 3 0 0 1 6 0 a3 3 0 0 1 6 0 a3 3 0 0 1 6 0 a3 3 0 0 1 6 0" className="bv-sym-line" fill="none" /></g>;
  return <g><rect x={-11} y={-7} width={22} height={14} className="bv-sym" data-unknown={kind === "unknown" || undefined} /><text y={3.5} textAnchor="middle" className="bv-sym-text">{kind === "unknown" ? "?" : kind === "active" ? "IC" : kind === "transformer" ? "T" : "?"}</text></g>;
}

/** A switch or jumper: closed, open, or (no state chosen) unknown and drawn dashed with a question mark. */
function SwitchGlyph({ state }: { state: "closed" | "open" | "unknown" }) {
  return <g data-switch={state}>
    <rect x={-13} y={-9} width={26} height={12} className="bv-sym-mask" />
    <circle cx={-10} cy={0} r={2.2} className="bv-sw-dot" /><circle cx={10} cy={0} r={2.2} className="bv-sw-dot" />
    {state === "closed" ? <line x1={-10} y1={0} x2={10} y2={0} className="bv-sw-lever" /> : <line x1={-10} y1={0} x2={8} y2={-8} className="bv-sw-lever" strokeDasharray={state === "unknown" ? "2 2" : undefined} />}
    {state === "unknown" && <text x={0} y={-11} textAnchor="middle" className="bv-sym-text">?</text>}
  </g>;
}

export function switchState(path: DrawnPath | Board["paths"][number], states: Record<string, string>): "closed" | "open" | "unknown" {
  if (!path.switch) return "unknown";
  const chosen = states[path.switch.condition_key];
  return chosen === undefined ? "unknown" : chosen === path.switch.closed_when ? "closed" : "open";
}

export type BoardDrawingProps = {
  layout: BoardLayout; board: Board; title: string;
  selectedPad?: string | null; selectedPath?: string | null; armedPad?: string | null; litPads?: Set<string>;
  traced?: Set<string> | null; traceKey?: number; states?: Record<string, string>;
  onPad?: (id: string) => void; onPath?: (id: string) => void;
};

/**
 * The board as a drawing: a placeholder outline (the shape is not declared), labeled pads in a
 * column per group, declared paths as straight copper with the part, switch or unknown on them,
 * and the connector the board carries with a lead per landed contact. Traced paths light up once.
 */
export function BoardDrawing({ layout, board, title, selectedPad = null, selectedPath = null, armedPad = null, litPads, traced = null, traceKey = 0, states = {}, onPad, onPath }: BoardDrawingProps) {
  const { outline, connector } = layout;
  const pathName = (p: DrawnPath) => `Path ${p.fromPad.label} to ${p.toPad.label}, ${pathSummary(p, board.conditions)}`;
  const padName = (p: DrawnPad) => `Pad ${p.label}${p.group ? `, ${p.group}` : ""}${armedPad === p.terminal_id ? ", start of new path" : ""}`;
  const pathsOf = new Map<string, number>();
  for (const p of layout.paths) { pathsOf.set(p.from_terminal, (pathsOf.get(p.from_terminal) ?? 0) + 1); pathsOf.set(p.to_terminal, (pathsOf.get(p.to_terminal) ?? 0) + 1); }
  return <svg className="bv-board" viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width} height={layout.height} role="group" aria-label={`${title} drawing`} data-traced={traced?.size ? true : undefined}>
    <defs>
      <pattern id="bv-hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" className="bv-hatch-line" /></pattern>
    </defs>
    <g aria-hidden="true">
      <rect x={outline.x} y={outline.y} width={outline.w} height={outline.h} rx={6} className="bv-outline" data-placeholder="true" />
      <text x={outline.x + 10} y={outline.y + 14} className="bv-silk">{title.toUpperCase()}</text>
      <text x={outline.x + outline.w - 10} y={outline.y + outline.h - 8} textAnchor="end" className="bv-silk bv-placeholder-note">OUTLINE NOT DECLARED · PLACEHOLDER</text>
      {layout.columns.map((c, i) => <text key={c.name} x={c.x} y={outline.y + 34} textAnchor={layout.columns.length > 1 && i === layout.columns.length - 1 ? "end" : layout.columns.length > 1 && i > 0 ? "middle" : "start"} dx={layout.columns.length > 1 && i === layout.columns.length - 1 ? PAD_W / 2 : i === 0 ? -PAD_W / 2 : 0} className="bv-silk">{c.name.toUpperCase()}</text>)}
    </g>
    {connector && <g className="bv-connector" aria-label={`Carried connector ${connector.name}`} role="img">
      {connector.leads.map((l) => <g key={l.padId}>
        <line x1={connector.side === "left" ? connector.x + connector.w : connector.x} y1={l.y} x2={l.padX} y2={l.y} className="bv-lead" />
        <text x={connector.side === "left" ? connector.x + connector.w - 4 : connector.x + 4} y={l.y + 3} textAnchor={connector.side === "left" ? "end" : "start"} className="bv-contact">{l.contact}</text>
      </g>)}
      <rect x={connector.x} y={connector.y} width={connector.w} height={connector.h} className="bv-connector-body" />
      <text transform={`translate(${connector.x + connector.w / 2 + 3} ${connector.y + connector.h / 2}) rotate(-90)`} textAnchor="middle" className="bv-silk">{connector.name.toUpperCase()}</text>
    </g>}
    <g className="bv-paths">{layout.paths.map((p) => {
      const lit = traced?.has(p.local_id);
      const dim = (traced?.size && !lit) || (selectedPath && selectedPath !== p.local_id) ? true : undefined;
      const native = p.provenance !== "declared";
      const sw = p.via === "switch" ? switchState(p, states) : null;
      return <g key={p.local_id} className="bv-path" data-via={p.via} data-native={native || undefined} data-traced={lit || undefined} data-dim={dim} data-selected={selectedPath === p.local_id || undefined}
        role="button" tabIndex={0} aria-pressed={selectedPath === p.local_id} aria-label={pathName(p)} {...keyed(() => onPath?.(p.local_id))}>
        <path d={p.d} className="bv-hit" />
        {selectedPath === p.local_id && <path d={p.d} className="bv-glow" />}
        <path d={p.d} className="bv-copper" strokeDasharray={native ? "6 3" : p.via === "unknown" ? "2 3" : undefined} />
        {lit && <path key={traceKey} d={p.d} className="bv-follow" pathLength={100} />}
        {p.glyph && <g transform={`translate(${p.glyph.x} ${p.glyph.y})${p.glyph.vertical ? " rotate(90)" : ""}`}>
          {p.via === "component" ? <ComponentGlyph c={p.component} /> : p.via === "switch" ? <SwitchGlyph state={sw!} /> : <g><rect x={-9} y={-7} width={18} height={14} className="bv-sym" data-unknown="true" /><text y={3.5} textAnchor="middle" className="bv-sym-text">?</text></g>}
          <text y={p.glyph.vertical ? 16 : -10} transform={p.glyph.vertical ? "rotate(-90)" : undefined} textAnchor="middle" className="bv-part-label">
            {p.via === "component" ? partLabel(p.component) : p.via === "switch" ? `${pathSummary(p, board.conditions).split(":")[0]} · ${sw}` : "unknown"}
          </text>
        </g>}
        <title>{pathName(p)}</title>
      </g>;
    })}</g>
    <g className="bv-pads">{layout.pads.map((p) => {
      if (p.internal) return <g key={p.terminal_id} role="img" aria-label={`Internal graph node ${p.label}, not a physical pad`}>
        <circle cx={p.x} cy={p.y} r={3} className="bv-sw-dot" />
        <text x={p.x + 8} y={p.y - 6} className="bv-silk">{p.label}</text>
        <title>{p.label} · internal graph junction only · not a termination target</title>
      </g>;
      const tht = p.kind === "through_hole" || p.kind === "connector_contact";
      const labelX = p.anchor === "start" ? p.x - PAD_W / 2 - 6 : p.anchor === "end" ? p.x + PAD_W / 2 + 6 : p.x;
      const labelY = p.anchor === "middle" ? p.y - PAD_H / 2 - 4 : p.y + 4;
      const unknownConnection = !pathsOf.has(p.terminal_id);
      const selected = selectedPad === p.terminal_id || armedPad === p.terminal_id || litPads?.has(p.terminal_id);
      return <g key={p.terminal_id} className="bv-pad" data-kind={p.kind} data-selected={selected || undefined} data-armed={armedPad === p.terminal_id || undefined} data-unconnected={unknownConnection || undefined}
        role="button" tabIndex={0} aria-pressed={!!selected} aria-label={padName(p)} {...keyed(() => onPad?.(p.terminal_id))}>
        <rect x={p.x - PAD_W / 2 - 4} y={p.y - PAD_H / 2 - 4} width={PAD_W + 8} height={PAD_H + 8} className="bv-hit" />
        {selected && <rect x={p.x - PAD_W / 2 - 3} y={p.y - PAD_H / 2 - 3} width={PAD_W + 6} height={PAD_H + 6} rx={tht ? PAD_H : 2} className="bv-pad-ring" />}
        {tht ? <g><rect x={p.x - PAD_W / 2} y={p.y - PAD_H / 2} width={PAD_W} height={PAD_H} rx={PAD_H / 2} className="bv-pad-copper" data-unknown={p.kind === "unknown" || undefined} /><circle cx={p.x} cy={p.y} r={3} className="bv-drill" /></g>
          : <rect x={p.x - PAD_W / 2} y={p.y - PAD_H / 2} width={PAD_W} height={PAD_H} rx={1.5} className="bv-pad-copper" data-unknown={p.kind === "unknown" || undefined} />}
        {!tht && <text x={p.x} y={p.y + 3} textAnchor="middle" className="bv-pad-side">{SIDE_MARK[p.side]}</text>}
        <text x={labelX} y={labelY} textAnchor={p.anchor === "start" ? "end" : p.anchor === "end" ? "start" : "middle"} className="bv-pad-label">{p.label}</text>
        {unknownConnection && <circle cx={p.x + (p.anchor === "end" ? -PAD_W / 2 - 8 : PAD_W / 2 + 8)} cy={p.y} r={4} className="bv-open"><title>Connection unknown: no declared path</title></circle>}
        <title>{padName(p)}{unknownConnection ? " · connection unknown" : ""}</title>
      </g>;
    })}</g>
  </svg>;
}
