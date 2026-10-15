import { useEffect, useId, useMemo, useState, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { edgeColor, mixHex, renderSectionSvg, type Section } from "../../../../packages/section-layout/src";
import { LAYER_LABELS } from "../end-assemblies/api";
import { ConnectorFace, type ConnectorFacePin, type PinState } from "../../../../packages/connector-art/src";
import { PITCH, STOCK_KEY, endKey, proposedKey, wireKey, type DrawnColumn, type DrawnEnd, type DrawnTerminal, type DrawnWire, type Drawing } from "./model";
import { familyColor, signalFamily, STATUS_WORDS } from "./palette";
import { ohms } from "./chips";

export type DrawingProps = {
  drawing: Drawing;
  /** Related marks of the probe; null shows everything at full strength. */
  lit: Set<string> | null;
  selection: string | null;
  onSelect: (key: string | null) => void;
  /** While set, terminals of this end are landing targets: a click lands instead of probing. */
  armedEnd?: string | null;
  onLand?: (terminalKey: string) => void;
  section?: Section | null;
  lengthText?: string | null;
  /** Check outcomes are drawn only when an intent check is shown. */
  showStatus?: boolean;
  /** Scale of the drawing; null fits the available box width. */
  zoom?: number | null;
  title: string;
  onDragLanding?: (endpointId: string, path: string, terminalKey: string) => void;
  onDragArm?: (value: { endpointId: string; path: string } | null) => void;
};

const truncate = (text: string, chars: number) => (text.length > chars ? `${text.slice(0, Math.max(1, chars - 1))}…` : text);
const shortLabel = (label: string) => label.split(" ")[0] ?? label;

function activate(handler: () => void) {
  return {
    onClick: (event: MouseEvent) => { event.stopPropagation(); handler(); },
    onKeyDown: (event: KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); handler(); } },
  };
}

/** Status mark beside a wire end or pin: shape plus color, so it never depends on hue alone. */
function StatusMark({ x, y, status }: { x: number; y: number; status: string }) {
  if (status === "fail") return <rect x={x - 3.5} y={y - 3.5} width={7} height={7} className="cwb-st" data-status={status}><title>fail</title></rect>;
  if (status === "unknown") return <circle cx={x} cy={y} r={3.6} className="cwb-st" data-status={status} style={{ fill: "url(#cwb-hatch)" }}><title>unknown</title></circle>;
  return <circle cx={x} cy={y} r={3.4} className="cwb-st" data-status={status}><title>{STATUS_WORDS[status as keyof typeof STATUS_WORDS] ?? status}</title></circle>;
}

function ColumnBody({ column, top, height, side, face }: { column: DrawnColumn; top: number; height: number; side: "left" | "right"; face: boolean }) {
  const { x, width, kind } = column;
  if (kind === "shell") {
    return <g className="cwb-shell" aria-hidden="true">
      <path d={`M${x + width / 2} ${top - 6}h${side === "left" ? -width / 2 + 4 : width / 2 - 4}v${height + 12}h${side === "left" ? width / 2 - 4 : -width / 2 + 4}`} />
      <ellipse cx={x + width / 2} cy={top + height / 2} rx={6} ry={height / 2 + 6} />
    </g>;
  }
  if (kind === "connector" && face) return null;
  if (kind === "connector") return <rect x={x + width / 2 - 20} y={top - 4} width={40} height={height + 8} rx={3} className="cwb-connector-body" aria-hidden="true" />;
  if (kind === "board") return <rect x={x + 4} y={top - 4} width={width - 8} height={height + 8} rx={4} className="cwb-board" style={{ fill: "url(#cwb-pcb)" }} aria-hidden="true" />;
  if (kind === "inline") return null;
  return <rect x={x} y={top - 4} width={width} height={height + 8} className="cwb-unresolved" style={{ fill: "url(#cwb-hatch)" }} aria-hidden="true" />;
}

function terminalTitle(t: DrawnTerminal): string {
  const signal = t.signal ? ` · ${t.signal.name}` : t.signalStatus === "conditional" ? " · signal conditional" : "";
  return `${t.layerKind === "unknown" ? "" : `${LAYER_LABELS[t.layerKind]} `}${t.label}${signal}${t.status ? ` · ${STATUS_WORDS[t.status]}` : ""}`;
}

/**
 * The cable as one drawing: End A's exploded stack, the stock with each conductive element as a
 * curve from its End A landing to its End B landing, End B's stack. Selection dims everything
 * not related to the probe; proposed landings are dashed.
 */
export function CableDrawing({ drawing, lit, selection, onSelect, armedEnd = null, onLand, section, lengthText, showStatus = false, zoom = null, title, onDragLanding, onDragArm }: DrawingProps) {
  const [drag, setDrag] = useState<{ endpointId: string; path: string; pointerId: number; start: { x: number; y: number }; point: { x: number; y: number } } | null>(null);
  const cancelDrag = () => { setDrag(null); onDragArm?.(null); };
  useEffect(() => {
    if (!drag) return;
    const cancel = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); cancelDrag(); } };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [drag]);
  const pointAt = (event: ReactPointerEvent<SVGSVGElement>) => {
    const matrix = event.currentTarget.getScreenCTM?.();
    if (matrix) { const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()); return { x: point.x, y: point.y }; }
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * (rect.width ? drawing.width / rect.width : 1), y: (event.clientY - rect.top) * (rect.height ? drawing.height / rect.height : 1) };
  };
  const clipId = `cwb-callout-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const dim = (key: string) => (armedEnd ? undefined : lit && !lit.has(key) ? true : undefined);
  const { stock, bodyTop, bodyHeight } = drawing;
  const jacket = stock.jacket?.base ?? "#2a2a2f";
  const sectionSvg = useMemo(() => {
    if (!section) return null;
    const selected = selection?.startsWith("w:") ? selection.slice(2) : null;
    const svg = renderSectionSvg(section, "Stock cross-section", { selected, callouts: false, idPrefix: "cwbx" });
    // The section renderer pads its drawing generously; draw it larger and let the callout ring clip it.
    const r = stock.callout.r * 1.45;
    return svg.replace("<svg ", `<svg x="${stock.callout.x - r}" y="${stock.callout.y - r}" width="${2 * r}" height="${2 * r}" `);
  }, [section, selection, stock.callout]);

  const faces: ReactNode[] = drawing.ends.map((end) => {
    const face = end.connector?.face;
    if (!face) return null;
    const contacts = end.terminals.filter((t) => t.onFace);
    const pinState = (t: DrawnTerminal): PinState | undefined => {
      if (armedEnd === end.endpointId) return undefined;
      if (lit && !lit.has(t.key)) return "dim";
      if (!showStatus || !t.status) return undefined;
      return t.status === "pass" ? "pass" : t.status === "fail" ? "fail" : t.status === "unknown" ? "unknown" : undefined;
    };
    const pins: ConnectorFacePin[] = contacts.map((t) => ({ id: t.terminalId, label: t.signal?.name, fill: t.signal ? familyColor(signalFamily(t.signal.type)) : undefined, state: pinState(t) }));
    const selectedPin = contacts.find((t) => t.key === selection)?.terminalId ?? null;
    return <svg key={`face-${end.endpointId}`} x={face.x} y={face.y} width={face.width} height={face.height} viewBox={`0 0 ${face.width} ${face.height}`} overflow="visible"
      className="cwb-face-wrap" data-end={end.endpointId} onClick={(event) => event.stopPropagation()}>
      <ConnectorFace geometry={face.geometry} view="mating" pins={pins} selectedPinId={selectedPin} size={face.width}
        title={`${end.label}: ${face.geometry.label} mating face${end.connector?.name ? `, ${end.connector.name}` : ""}`}
        onPinClick={(id) => { const t = contacts.find((c) => c.terminalId === id); if (t) (armedEnd === end.endpointId && onLand ? onLand(t.key) : onSelect(selection === t.key ? null : t.key)); }} />
    </svg>;
  });

  const wire = (w: DrawnWire) => {
    const base = w.look && w.look.fillSource !== "unknown" ? w.look.base : null;
    const color = base ?? "var(--sb-text-tertiary)";
    const edge = base ? edgeColor(base) : "var(--sb-border-strong)";
    const width = w.kind === "conductor" ? 2.6 : w.kind === "shield" ? 2.2 : 1.6;
    const signal = w.signal ? ` · ${w.signal.name}` : "";
    return <g key={w.key} className="cwb-wire" data-key={w.key} data-kind={w.kind} data-dim={dim(w.key)} data-selected={selection === w.key || undefined}
      role="button" tabIndex={0} aria-label={`Wire ${w.display}${signal}${showStatus && w.status ? `, ${STATUS_WORDS[w.status]}` : ""}`} aria-pressed={selection === w.key}
      {...activate(() => onSelect(selection === w.key ? null : w.key))}>
      <path d={w.d} className="cwb-wire-hit" />
      {selection === w.key && <path d={w.d} className="cwb-wire-glow" strokeWidth={width + 6} />}
      <path d={w.d} style={{ stroke: edge }} strokeWidth={width + 1.4} className="cwb-wire-edge" />
      <path d={w.d} style={{ stroke: color }} strokeWidth={width} className="cwb-wire-core" strokeDasharray={!base ? "3 2" : w.kind === "shield" ? "1.6 1.1" : undefined} />
      {w.look?.stripe && <path d={w.d} style={{ stroke: w.look.stripe }} strokeWidth={width * 0.45} strokeDasharray="6 6" className="cwb-wire-core" />}
      {w.open.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={3} className="cwb-open" style={{ fill: "url(#cwb-hatch)" }}><title>Not landed at this end</title></circle>)}
      {showStatus && w.status && w.b && <StatusMark x={w.b.x + (w.b.x > stock.jacketX1 ? -10 : 10)} y={w.b.y - 6} status={w.status} />}
      {onDragLanding && drawing.ends.slice(0, 2).map((end, index) => {
        const point = index === 0 ? w.a : w.b;
        return point ? <circle key={end.endpointId} cx={point.x} cy={point.y} r={6} className="cwb-drag-handle" role="button" tabIndex={0}
          aria-label={`Move ${w.display} landing at ${end.label}`} style={{ touchAction: "none" }}
          onClick={event => event.stopPropagation()}
          onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); onSelect(w.key); onDragArm?.({ endpointId: end.endpointId, path: w.path }); } }}
          onPointerDown={event => {
            if (event.button !== 0) return;
            event.preventDefault(); event.stopPropagation();
            event.currentTarget.ownerSVGElement?.setPointerCapture?.(event.pointerId);
            setDrag({ endpointId: end.endpointId, path: w.path, pointerId: event.pointerId, start: point, point });
            onSelect(w.key); onDragArm?.({ endpointId: end.endpointId, path: w.path });
          }}><title>Drag to a terminal of this end, or press Enter and choose a landing target. Escape cancels.</title></circle> : null;
      })}
      <title>{`${w.display}${signal}`}</title>
    </g>;
  };

  const end = (e: DrawnEnd) => {
    const top = bodyTop;
    const height = bodyHeight - PITCH;
    return <g key={e.endpointId} className="cwb-end" data-end={e.endpointId}>
      <text x={e.side === "left" ? e.x0 : e.x1} y={14} textAnchor={e.side === "left" ? "start" : "end"} className="cwb-end-title" data-dim={dim(endKey(e.endpointId))}
        role="button" tabIndex={0} aria-label={`${e.label}: open end details`} {...activate(() => onSelect(endKey(e.endpointId)))}>
        {`END ${e.endpointId.toUpperCase()} · ${e.label}`.toUpperCase()}
      </text>
      {e.columns.map((c) => <g key={c.key}>
        <ColumnBody column={c} top={top} height={height} side={e.side} face={!!e.connector?.face} />
        <text x={c.x + c.width / 2} y={top - 12} textAnchor="middle" className="cwb-silk">{c.kind === "unknown" ? "STACK NOT RESOLVED" : LAYER_LABELS[c.kind].toUpperCase()}</text>
        {c.name && c.kind !== "shell" && <text x={c.x + c.width / 2} y={top + height + 18} textAnchor="middle" className="cwb-col-name"><title>{c.name}</title>{truncate(c.name, Math.floor(c.width / 5.6))}</text>}
        {c.kind === "shell" && c.name && <text x={c.x + c.width / 2} y={top + height + 18} textAnchor="middle" className="cwb-col-name"><title>{c.name}</title>shell</text>}
      </g>)}
      {e.joins.map((j) => <path key={j.key} d={j.d} className="cwb-join" data-kind={j.kind} data-status={j.status} data-dim={lit && !(lit.has(j.a) && lit.has(j.b)) ? true : undefined}><title>{`${j.kind} · ${j.basis}`}</title></path>)}
      {e.traces.map((t) => <g key={t.key} className="cwb-trace" data-key={t.key} data-status={t.status} data-dim={dim(t.key)} role="button" tabIndex={0} aria-label={`Board path ${t.summary}`} {...activate(() => onSelect(t.key))}>
        <path d={t.d} />
        {t.via === "component" && <g transform={`translate(${t.mid.x} ${t.mid.y})`}><rect x={-9} y={-4} width={18} height={8} rx={1.5} className="cwb-smd" /><text y={-7} textAnchor="middle" className="cwb-part-label">{truncate(ohms(t.summary), 14)}</text></g>}
        <title>{t.summary}</title>
      </g>)}
      {e.parts.map((p) => <g key={p.key} className="cwb-part" data-key={p.key} data-dim={dim(p.key)} data-selected={selection === p.key || undefined} role="button" tabIndex={0}
        aria-label={`Inline part ${p.name}, ${p.summary}`} {...activate(() => onSelect(p.key))} transform={`translate(${p.x} ${p.y})`}>
        <line x1={-38} x2={38} y1={0} y2={0} className="cwb-lead" />
        {p.component === "capacitor"
          ? <g className="cwb-cap"><line x1={-3} x2={-3} y1={-8} y2={8} /><line x1={3} x2={3} y1={-8} y2={8} /></g>
          : <rect x={-14} y={-5} width={28} height={10} rx={4} className="cwb-resistor" />}
        <text y={-11} textAnchor="middle" className="cwb-part-label">{truncate(ohms(p.summary || p.name), 20)}</text>
        <title>{`${p.name}: ${p.summary}`}</title>
      </g>)}
      {e.terminals.map((t) => {
        const candidate = armedEnd === e.endpointId && t.layerKind !== "shell";
        const fill = familyColor(signalFamily(t.signal?.type));
        const pick = () => (candidate && onLand ? onLand(t.key) : onSelect(selection === t.key ? null : t.key));
        const labelRight = t.side === "connector" ? e.side === "right" : t.side === "cable" ? e.side === "left" : e.side === "left";
        // Pins on a drawn face are the face's own buttons; only the landing hint is drawn over them.
        if (t.onFace) return candidate ? <circle key={t.key} cx={t.x} cy={t.y} r={t.halfWidth + 3} className="cwb-candidate" pointerEvents="none" /> : null;
        return <g key={t.key} className="cwb-term" data-key={t.key} data-layer={t.layerKind} data-dim={armedEnd ? (candidate ? undefined : true) : dim(t.key)} data-candidate={candidate || undefined}
          data-selected={selection === t.key || undefined} role="button" tabIndex={0} aria-label={candidate ? `Land on ${terminalTitle(t)}` : terminalTitle(t)} aria-pressed={selection === t.key} {...activate(pick)}>
          {t.layerKind === "connector"
            ? <rect x={t.x - t.halfWidth} y={t.y - 6} width={t.halfWidth * 2} height={12} rx={2} className="cwb-cup" style={{ stroke: fill }} />
            : t.layerKind === "board"
              ? <rect x={t.x - t.halfWidth} y={t.y - 5} width={t.halfWidth * 2} height={10} rx={1.5} className="cwb-pad" />
              : <circle cx={t.x} cy={t.y} r={t.halfWidth} className="cwb-node" />}
          {t.signal && t.layerKind !== "connector" && <circle cx={t.x} cy={t.y} r={2.2} style={{ fill }} />}
          {t.layerKind === "connector" && <text x={t.x} y={t.y + 3} textAnchor="middle" className="cwb-cup-num">{truncate(shortLabel(t.label), 3)}</text>}
          {t.layerKind !== "connector" && t.layerKind !== "inline" && t.layerKind !== "shell" && <text x={t.x + (labelRight ? t.halfWidth + 3 : -t.halfWidth - 3)} y={t.y + 3} textAnchor={labelRight ? "start" : "end"} className="cwb-pad-label">{truncate(t.label, 6)}</text>}
          {showStatus && t.status && t.layerKind === "connector" && <StatusMark x={t.x + (e.side === "left" ? -t.halfWidth - 6 : t.halfWidth + 6)} y={t.y} status={t.status} />}
          {candidate && <rect x={t.x - t.halfWidth - 3} y={t.y - 8} width={t.halfWidth * 2 + 6} height={16} rx={3} className="cwb-candidate" />}
          {selection === t.key && <rect x={t.x - t.halfWidth - 4} y={t.y - 9} width={t.halfWidth * 2 + 8} height={18} rx={3} className="cwb-selected-ring" />}
          <title>{terminalTitle(t)}</title>
        </g>;
      })}
    </g>;
  };

  const jacketTop = stock.cy - stock.height / 2;
  const breakHalf = 9;
  const zig = (x: number) => {
    const steps = 6;
    const h = stock.height + 8;
    const y0 = jacketTop - 4;
    let d = `M${x} ${y0}`;
    for (let i = 1; i <= steps; i += 1) d += `L${x + (i % 2 ? 4 : -4)} ${y0 + (h * i) / steps}`;
    return d;
  };
  const light = mixHex(jacket.startsWith("#") ? jacket : "#2a2a2f", "#ffffff", 0.22);
  const dark = mixHex(jacket.startsWith("#") ? jacket : "#2a2a2f", "#000000", 0.45);

  const size = zoom === null ? { width: "100%", style: { minWidth: 0, height: "auto" } } : { width: drawing.width * zoom, height: drawing.height * zoom };
  return <svg className="cwb-drawing" viewBox={`0 0 ${drawing.width} ${drawing.height}`} {...size}
    role="group" aria-label={title} onClick={() => onSelect(null)}
    onPointerMove={event => { if (drag && event.pointerId === drag.pointerId) setDrag({ ...drag, point: pointAt(event) }); }}
    onPointerUp={event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const point = pointAt(event);
      const target = [...drawing.terminals.values()].filter(terminal => terminal.endpointId === drag.endpointId && terminal.layerKind !== "unknown")
        .map(terminal => ({ terminal, distance: Math.hypot(terminal.x - point.x, terminal.y - point.y) }))
        .sort((a, b) => a.distance - b.distance)[0];
      if (target && target.distance <= Math.max(12, target.terminal.halfWidth + 6)) onDragLanding?.(drag.endpointId, drag.path, target.terminal.key);
      cancelDrag();
    }} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}>
    <defs>
      <pattern id="cwb-hatch" width={4} height={4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1={0} y1={0} x2={0} y2={4} className="cwb-hatch-line" /></pattern>
      <linearGradient id="cwb-jacket" x1={0} y1={0} x2={0} y2={1}>
        <stop offset={0} stopColor={light} /><stop offset={0.35} stopColor={jacket} /><stop offset={0.75} stopColor={dark} /><stop offset={1} stopColor={jacket} />
      </linearGradient>
      <clipPath id={clipId}><circle cx={stock.callout.x} cy={stock.callout.y} r={stock.callout.r - 1} /></clipPath>
      <linearGradient id="cwb-pcb" x1={0} y1={0} x2={1} y2={1}><stop offset={0} stopColor="#1A5A37" /><stop offset={1} stopColor="#0E3B24" /></linearGradient>
    </defs>
    <rect x={0} y={0} width={drawing.width} height={drawing.height} className="cwb-ground" />
    {drawing.ends.map(end)}
    {faces}
    <g className="cwb-stock" data-dim={dim(STOCK_KEY) && !drawing.wires.some((w) => lit?.has(w.key)) ? true : undefined}>
      {/* Keep the selected landing handles above crossing wires and their hit paths. */}
      {drawing.wires.filter(w => w.key !== selection).concat(drawing.wires.filter(w => w.key === selection)).map(wire)}
      <g role="button" tabIndex={0} aria-label="Stock: open stock details" {...activate(() => onSelect(STOCK_KEY))} className="cwb-jacket-hit">
        <rect x={stock.jacketX0} y={jacketTop} width={stock.jacketX1 - stock.jacketX0} height={stock.height} rx={stock.height / 2.6} className="cwb-jacket" style={{ fill: stock.jacket ? "url(#cwb-jacket)" : "url(#cwb-hatch)" }} data-selected={selection === STOCK_KEY || undefined} />
        <ellipse cx={stock.jacketX0} cy={stock.cy} rx={4} ry={stock.height / 2} className="cwb-jacket-cut" />
        <ellipse cx={stock.jacketX1} cy={stock.cy} rx={4} ry={stock.height / 2} className="cwb-jacket-cut" />
      </g>
      {drawing.wires.map((w) => <path key={`x-${w.key}`} d={`M${stock.jacketX0 + 8} ${w.lane}L${stock.jacketX1 - 8} ${w.lane}`} className="cwb-xray" data-dim={dim(w.key)}
        style={{ stroke: w.look && w.look.fillSource !== "unknown" ? w.look.base : "var(--sb-text-tertiary)" }} />)}
      <rect x={stock.breakX - breakHalf} y={jacketTop - 6} width={breakHalf * 2} height={stock.height + 12} className="cwb-break-gap" />
      <path d={zig(stock.breakX - breakHalf)} className="cwb-break" /><path d={zig(stock.breakX + breakHalf)} className="cwb-break" />
      <g className="cwb-dim-line" aria-label={lengthText ? `Length ${lengthText}` : "Length unknown"}>
        <line x1={stock.jacketX0} x2={stock.jacketX1} y1={stock.dimY} y2={stock.dimY} />
        <line x1={stock.jacketX0} x2={stock.jacketX0} y1={stock.dimY - 6} y2={stock.dimY + 6} />
        <line x1={stock.jacketX1} x2={stock.jacketX1} y1={stock.dimY - 6} y2={stock.dimY + 6} />
        <path d={`M${stock.jacketX0} ${stock.dimY}l7 -3v6z M${stock.jacketX1} ${stock.dimY}l-7 -3v6z`} className="cwb-arrow" />
        <rect x={stock.breakX - 70} y={stock.dimY - 8} width={140} height={16} className="cwb-dim-bg" style={lengthText ? undefined : { fill: "url(#cwb-hatch)" }} />
        <text x={stock.breakX} y={stock.dimY + 4} textAnchor="middle" className="cwb-dim-text">{lengthText ?? "LENGTH UNKNOWN"}</text>
      </g>
      <g className="cwb-callout" aria-label="Stock cross-section: click an element to probe it"
        onClick={(event) => { const hit = (event.target as Element).closest("[data-element]"); if (hit) { event.stopPropagation(); onSelect(wireKey(hit.getAttribute("data-element")!)); } }}>
        <line x1={stock.callout.x} x2={stock.callout.x} y1={stock.callout.y + stock.callout.r} y2={jacketTop} className="cwb-leader" />
        <circle cx={stock.callout.x} cy={stock.callout.y} r={stock.callout.r} className="cwb-callout-ring" />
        {sectionSvg ? <g clipPath={`url(#${clipId})`} dangerouslySetInnerHTML={{ __html: sectionSvg }} /> : <text x={stock.callout.x} y={stock.callout.y + 3} textAnchor="middle" className="cwb-silk">SECTION UNKNOWN</text>}
        <text x={stock.callout.x + stock.callout.r + 6} y={stock.callout.y - 4} className="cwb-silk">CROSS-SECTION</text>
      </g>
    </g>
    {drawing.proposals.map((p) => <g key={`${p.key}-${p.path}-${p.endpointId}`} className="cwb-proposal" data-key={proposedKey(p.rowId)} data-change={p.change}
      data-dim={lit && !lit.has(p.key) ? true : undefined} data-selected={selection === p.key || undefined} role="button" tabIndex={0}
      aria-label={`Proposed: ${p.path} to ${p.terminalLabel} at end ${p.endpointId.toUpperCase()}`} {...activate(() => onSelect(p.key))}>
      <path d={p.d} className="cwb-wire-hit" /><path d={p.d} className="cwb-proposal-halo" /><path d={p.d} className="cwb-proposal-line" />
      <circle cx={p.to.x} cy={p.to.y} r={4} className="cwb-proposal-end" />
      <title>{`Proposed ${p.change}: ${p.path} → ${p.terminalLabel}`}</title>
    </g>)}
    {drawing.extraEnds > 0 && <text x={drawing.width - 14} y={drawing.height - 6} textAnchor="end" className="cwb-silk">{`${drawing.extraEnds} MORE END${drawing.extraEnds === 1 ? "" : "S"} NOT DRAWN`}</text>}
    {drag && <path d={`M${drag.start.x} ${drag.start.y} L${drag.point.x} ${drag.point.y}`} className="cwb-drag-preview" pointerEvents="none" />}
  </svg>;
}
