import { Button } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { useQuery } from "@tanstack/react-query";
import type { CSSProperties, KeyboardEvent } from "react";
import { ConnectorFace, type ConnectorFacePin } from "../../../../packages/connector-art/src";
import { SbUnknown } from "../../components/sb";
import type { CableEnd, Inspection } from "../interfaces/api";
import { faceForBody } from "../interfaces/BodyFace";
import { CONDITIONING_LABELS, read, type IntentRow, type RequiredPart } from "./api";
import { familyColor } from "./signal-palette";
import { ROW, type Callout, type RailPin, type Wiring } from "./wiring-model";
import "./intent-visual.css";

export type Selection = { rowId: string } | { side: "a" | "b"; contactId: string } | null;

export const QUESTION_WORDS: Record<NonNullable<IntentRow["question"]>["kind"], string> = {
  several_destinations: "which contact", name_and_type_only: "name match only", conditional_pin: "depends on condition",
};

/** "R 470 Ω": a required part as drawn on its line. */
export function partText(p: RequiredPart): string {
  const short = p.conditioning === "series_resistor" || p.conditioning === "shunt_resistor" ? "R" : p.conditioning === "series_capacitor" ? "C" : p.conditioning === "attenuator" ? "ATT" : "part";
  return `${short}${p.value ? ` ${p.value}` : ""}`;
}

function keyed(handler: () => void) {
  return {
    onClick: handler,
    onKeyDown: (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handler(); } },
  };
}

/** One end's connector face: drawn from its body's face key, or a labeled unknown, never a guessed shape. */
function EndFace({ end, side, pins, selected, onPin, caption, lit }: { end: CableEnd | undefined; side: "a" | "b"; pins: RailPin[]; selected: string | null; onPin: (id: string) => void; caption: string; lit: Set<string> | null }) {
  const body = useQuery({ queryKey: ["interface-inspect", end?.body_revision_id], queryFn: () => read<Inspection>(`interfaces/revisions/${end!.body_revision_id}`), enabled: !!end?.body_revision_id });
  const geometry = body.data?.interface?.kind === "connector_body" ? faceForBody(body.data.interface) : null;
  const facePins: ConnectorFacePin[] = pins.map((p) => ({ id: p.contactId, label: p.label || undefined, fill: p.signal ? familyColor(p.family) : undefined, state: lit && !lit.has(`${side}:${p.contactId}`) ? "dim" : p.mustNotConnect ? "hazard" : p.signal ? undefined : "unknown" }));
  return <figure className="ibv-face" data-side={side}>
    <figcaption className="sb-silk">{caption}</figcaption>
    {geometry ? <ConnectorFace geometry={geometry} pins={facePins} selectedPinId={selected} onPinClick={onPin} size={150} title={`${caption}: ${geometry.label} mating face`} />
      : <div className="ibv-face-unknown">{end ? <SbUnknown what="Face geometry" /> : <span className="sb-silk">Choose this end</span>}</div>}
    {end && <div className="ibv-face-meta">{end.kind === "port" ? end.device_label ?? "Device unknown" : "Pinout variant"} · {end.variant_label ?? "variant unnamed"}</div>}
  </figure>;
}

function RailList({ side, pins, lit, selected, onPick, questions }: { side: "a" | "b"; pins: RailPin[]; lit: Set<string> | null; selected: string | null; onPick: (id: string) => void; questions: Set<string> }) {
  return <ol className="ibv-rail" data-side={side} aria-label={side === "a" ? "From end pins" : "To end pins"}>
    {pins.map((p) => <li key={p.contactId} style={{ height: ROW }}>
      <button type="button" className="ibv-pin" data-dim={lit && !lit.has(`${side}:${p.contactId}`) ? true : undefined} aria-pressed={selected === p.contactId}
        data-question={questions.has(p.contactId) || undefined} data-mnc={p.mustNotConnect || undefined}
        aria-label={`${side === "a" ? "From" : "To"} pin ${p.number}${p.label ? `, ${p.label}` : ", signal unknown"}${p.mustNotConnect ? ", must not connect" : ""}`}
        onClick={() => onPick(p.contactId)}>
        <span className="ibv-pin-num">{p.number}</span>
        <span className="ibv-pin-name" data-unknown={!p.label || undefined}>{p.label || "unknown"}</span>
        <span className="ibv-swatch" data-family={p.family} style={{ background: p.signal ? familyColor(p.family) : undefined }} />
      </button>
    </li>)}
  </ol>;
}

/** An open question beside its pin with one button per answer; answering is an ordinary row edit. */
export function QuestionCard({ row, source, onAnswer, lockedReason, style }: { row: IntentRow; source: string; onAnswer?: (ids: string[]) => void; lockedReason?: string; style?: CSSProperties }) {
  const q = row.question!;
  const locked = !onAnswer;
  const gate = locked ? { disabled: true, title: lockedReason ?? "Read-only" } : {};
  return <div className="ibv-callout" role="group" aria-label={`Question on ${source}`} style={style} data-row={row.row_id}>
    <div className="ibv-callout-head"><span className="ibv-q" aria-hidden="true">?</span><span className="sb-silk">{QUESTION_WORDS[q.kind]}</span><span className="ibv-callout-src">{source}</span></div>
    <p className="ibv-callout-text" title={q.text}>{q.text}</p>
    <div className="ibv-callout-actions">
      {q.options.map((o) => <Button key={o.contact_id} size="compact-xs" variant="default" {...gate} onClick={() => onAnswer?.([o.contact_id])}>{o.label}</Button>)}
      {q.options.length > 1 && <Button size="compact-xs" variant="default" {...gate} onClick={() => onAnswer?.(q.options.map((o) => o.contact_id))}>All {q.options.length}</Button>}
      {q.options.length === 0 && <Button size="compact-xs" variant="default" {...gate} onClick={() => onAnswer?.([])}>Answer: no destination</Button>}
    </div>
  </div>;
}

function curve(x1: number, y1: number, x2: number, y2: number): string {
  const dx = (x2 - x1) * 0.45;
  return `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
}

/** A point on ``curve`` near its source, where required parts sit clear of the crossing middle. */
function along(W: number, y1: number, y2: number, t: number): [number, number] {
  const u = 1 - t, dx = W * 0.45;
  const x = 3 * u * u * t * dx + 3 * u * t * t * (W - dx) + t * t * t * W;
  const y = (u * u * u + 3 * u * u * t) * y1 + (3 * u * t * t + t * t * t) * y2;
  return [x, y];
}

const STUB = 30;

/**
 * Intent wiring: the two ends' faces side by side, their pin rails, and between them a line per
 * matched pin in its signal-type color. Open questions are callouts beside their pin (or ``?``
 * marks in compact layouts, where the inspector carries the questions); must-not-connect pins end
 * in red crossed stubs; required parts sit on their lines.
 */
export function IntentWiring({ wiring, rows, from, to, fromCaption, toCaption, selection, onSelect, compact, onAnswer, lockedReason }: {
  wiring: Wiring; rows: IntentRow[]; from?: CableEnd; to?: CableEnd; fromCaption: string; toCaption: string;
  selection: Selection; onSelect: (s: Selection) => void; compact: boolean;
  onAnswer?: (rowId: string, ids: string[]) => void; lockedReason?: string;
}) {
  const { ref, width: measured } = useElementSize();
  const W = Math.max(measured || 360, 140);
  const byRow = new Map(rows.map((r) => [r.row_id, r]));
  const selectedRow = selection && "rowId" in selection ? selection.rowId : null;
  const rowsOf = (side: "a" | "b", id: string) => rows.filter((r) => (side === "a" ? r.from_contact_id === id : r.to_contact_ids.includes(id) || r.question?.options.some((o) => o.contact_id === id)));
  // The probe: a selected row lights its pins; a selected pin lights its rows and their pins.
  let lit: Set<string> | null = null;
  const litRows = new Set<string>();
  if (selection) {
    lit = new Set();
    const rowsLit = "rowId" in selection ? [byRow.get(selection.rowId)].filter((r): r is IntentRow => !!r) : rowsOf(selection.side, selection.contactId);
    if (!("rowId" in selection)) lit.add(`${selection.side}:${selection.contactId}`);
    for (const r of rowsLit) {
      litRows.add(r.row_id);
      if (r.from_contact_id) lit.add(`a:${r.from_contact_id}`);
      for (const id of r.to_contact_ids) lit.add(`b:${id}`);
      for (const o of r.question?.options ?? []) lit.add(`b:${o.contact_id}`);
    }
  }
  const dim = (rowId: string) => (lit && !litRows.has(rowId) ? true : undefined);
  const pickRow = (rowId: string) => onSelect(selectedRow === rowId ? null : { rowId });
  const pickPin = (side: "a" | "b") => (id: string) => {
    const same = selection && !("rowId" in selection) && selection.side === side && selection.contactId === id;
    onSelect(same ? null : { side, contactId: id });
  };
  const selectedPin = (side: "a" | "b") => (selection && !("rowId" in selection) && selection.side === side ? selection.contactId : null);
  const facePin = (side: "a" | "b") => {
    const row = selectedRow ? byRow.get(selectedRow) : undefined;
    if (!row) return selectedPin(side);
    return side === "a" ? row.from_contact_id : row.to_contact_ids[0] ?? null;
  };
  const questionsA = new Set(rows.filter((r) => r.question && r.from_contact_id).map((r) => r.from_contact_id!));
  const height = compact ? Math.max(wiring.a.length, wiring.b.length, 1) * ROW : wiring.height;
  const cw = Math.min(260, Math.max(170, W - 90));
  const cx = (W - cw) / 2;
  const sourceText = (row: IntentRow) => {
    const p = wiring.a.find((x) => x.contactId === row.from_contact_id);
    return p ? `from ${p.number}${p.label ? ` · ${p.label}` : ""}` : "no source pin";
  };
  const lineLabel = (rowId: string, name: string) => `Line ${name}`.trim() + (selectedRow === rowId ? ", selected" : "");

  return <div className="ibv-wiring" data-compact={compact || undefined}>
    <EndFace end={from} side="a" pins={wiring.a} selected={facePin("a")} onPin={pickPin("a")} caption={fromCaption} lit={lit} />
    <div className="ibv-legend" aria-hidden="true">
      {(["video", "sync", "audio", "control", "power", "ground"] as const).map((f) => <span key={f}><i style={{ background: familyColor(f) }} />{f}</span>)}
      <span><i className="ibv-legend-mnc" />must not connect</span>
    </div>
    <EndFace end={to} side="b" pins={wiring.b} selected={facePin("b")} onPin={pickPin("b")} caption={toCaption} lit={lit} />
    <RailList side="a" pins={wiring.a} lit={lit} selected={selectedPin("a")} onPick={pickPin("a")} questions={questionsA} />
    <div className="ibv-mid" ref={ref} style={{ height }}>
      <svg className="ibv-lines" width={W} height={height} viewBox={`0 0 ${W} ${height}`} role="group" aria-label="Intent lines">
        <defs>
          <pattern id="ibv-hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" className="ibv-hatch-line" /></pattern>
        </defs>
        {wiring.lines.map((l) => {
          const d = curve(0, l.from, W, l.to);
          const [mx, my] = along(W, l.from, l.to, 0.12);
          return <g key={l.key} className="ibv-line" data-row={l.rowId} data-dim={dim(l.rowId)} data-selected={selectedRow === l.rowId || undefined} data-optional={l.optional || undefined}
            role="button" tabIndex={0} aria-pressed={selectedRow === l.rowId} aria-label={lineLabel(l.rowId, l.name)} {...keyed(() => pickRow(l.rowId))}>
            <path d={d} className="ibv-line-hit" />
            {selectedRow === l.rowId && <path d={d} className="ibv-line-glow" />}
            <path d={d} className="ibv-line-core" style={{ stroke: l.color }} strokeDasharray={l.optional ? "5 4" : l.family === "unknown" ? "2 3" : undefined} />
            {l.parts.map((p, i) => <g key={i} className="ibv-part" transform={`translate(${mx + i * 30 - (l.parts.length - 1) * 15} ${my})`}>
              <rect x={-11} y={-5} width={22} height={10} style={{ stroke: l.color }} />
              <text y={-8} textAnchor="middle">{partText(p)}</text>
              <title>{`Required ${CONDITIONING_LABELS[p.conditioning].toLowerCase()}${p.value ? ` ${p.value}` : ""} (${p.where.replace("_", " ")})`}</title>
            </g>)}
          </g>;
        })}
        {wiring.stubs.map((s) => {
          const x0 = s.side === "from" ? 0 : W;
          const x1 = s.side === "from" ? STUB : W - STUB;
          const label = s.kind === "must_not_connect" ? "must not connect" : s.side === "from" ? "no destination" : "no source";
          return <g key={s.key} className="ibv-stub" data-kind={s.kind} data-dim={dim(s.rowId)} data-selected={selectedRow === s.rowId || undefined} role="button" tabIndex={0}
            aria-label={`${s.side === "from" ? "From" : "To"} pin ${label}`} aria-pressed={selectedRow === s.rowId} {...keyed(() => pickRow(s.rowId))}>
            <line x1={x0} y1={s.y} x2={x1} y2={s.y} className="ibv-line-hit" />
            <line x1={x0} y1={s.y} x2={x1} y2={s.y} className="ibv-stub-line" />
            {s.kind === "must_not_connect"
              ? <path d={`M${x1 - 5} ${s.y - 5} L${x1 + 5} ${s.y + 5} M${x1 - 5} ${s.y + 5} L${x1 + 5} ${s.y - 5}`} className="ibv-stub-cross" />
              : <circle cx={x1} cy={s.y} r={4} className="ibv-stub-open" />}
            <title>{label}</title>
          </g>;
        })}
        {wiring.callouts.map((c) => compact
          ? <g key={c.rowId} className="ibv-qmark" data-dim={dim(c.rowId)} role="button" tabIndex={0} aria-label={`Open question on ${sourceText(byRow.get(c.rowId)!)}`} {...keyed(() => pickRow(c.rowId))}>
            <line x1={0} y1={c.anchor} x2={22} y2={c.anchor} style={{ stroke: c.color }} className="ibv-q-lead" />
            <circle cx={30} cy={c.anchor} r={8} /><text x={30} y={c.anchor + 3.5} textAnchor="middle">?</text>
          </g>
          : <CalloutLeads key={c.rowId} c={c} x={cx} w={cw} W={W} dim={dim(c.rowId)} />)}
      </svg>
      {!compact && wiring.callouts.map((c) => {
        const row = byRow.get(c.rowId);
        if (!row?.question) return null;
        return <QuestionCard key={c.rowId} row={row} source={sourceText(row)} lockedReason={lockedReason} onAnswer={onAnswer ? (ids) => onAnswer(row.row_id, ids) : undefined}
          style={{ position: "absolute", left: cx, top: c.top, width: cw, opacity: dim(c.rowId) ? 0.35 : 1 }} />;
      })}
    </div>
    <RailList side="b" pins={wiring.b} lit={lit} selected={selectedPin("b")} onPick={pickPin("b")} questions={new Set()} />
  </div>;
}

function CalloutLeads({ c, x, w, W, dim }: { c: Callout; x: number; w: number; W: number; dim?: true }) {
  const y = c.top + 14;
  return <g className="ibv-leads" data-dim={dim} aria-hidden="true">
    <path d={curve(0, c.anchor, x, y)} style={{ stroke: c.color }} className="ibv-q-lead" />
    {c.options.filter((o) => o.y !== null).map((o) => <path key={o.contactId} d={curve(x + w, y, W, o.y!)} className="ibv-q-option" />)}
  </g>;
}
