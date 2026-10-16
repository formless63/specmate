import { useMemo } from "react";
import { displayColor, renderSectionSvg, sectionLayout } from "../../../../packages/section-layout/src";
import type { Section, StockSpecification } from "../../../../packages/section-layout/src";
import type { LibraryPreview } from "./api";
import { ConnectorThumb } from "./ConnectorThumb";

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** The parsed section of a stock specification, or null when it cannot be laid out. */
export function stockSection(stock: unknown): Section | null {
  const spec = obj(stock);
  if (!spec.structure) return null;
  try { return sectionLayout(spec as unknown as StockSpecification); } catch { return null; }
}

/** Declared values recorded with status "unknown" (the convention the backend counts too). */
export function countUnknown(value: unknown, depth = 0): number {
  if (depth > 12 || !value || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + countUnknown(item, depth + 1), 0);
  const own = (value as Json).status === "unknown" ? 1 : 0;
  return own + Object.values(value).reduce<number>((sum, item) => sum + countUnknown(item, depth + 1), 0);
}

function Note({ children }: { children: string }) {
  return <text x={120} y={64} textAnchor="middle" className="lg-thumb-note">{children}</text>;
}

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return <svg viewBox="0 0 240 120" role="img" aria-label={title} className="lg-thumb-svg">{children}</svg>;
}

function StockThumb({ stock, title, id }: { stock: unknown; title: string; id: string }) {
  const drawn = useMemo(() => {
    const section = stockSection(stock);
    if (!section) return { svg: null, rows: 0 };
    const svg = section.features.length ? renderSectionSvg(section, title, { callouts: false, idPrefix: `lg${id.replace(/[^a-z0-9]/gi, "").slice(0, 12)}` }) : null;
    return { svg, rows: section.rows.length };
  }, [stock, title, id]);
  if (!drawn.svg) {
    return <Frame title={title}><rect x={80} y={20} width={80} height={80} rx={40} className="lg-unknown-fill" />
      <Note>{drawn.rows ? `${drawn.rows} elements, dimensions not recorded` : "construction not recorded"}</Note></Frame>;
  }
  return <div className="lg-thumb-html" dangerouslySetInnerHTML={{ __html: drawn.svg }} />;
}

/** Cable as a drawn sketch: two ends, the jacket in its recorded color and the conductors fanned out. */
function CableThumb({ content, stock, title }: { content: Json; stock: unknown; title: string }) {
  const cable = obj(content.cable);
  if (cable.schema_version === '0.3') return <Frame title={title}>
    {arr(cable.sections).slice(0, 6).map((section, i) => <g key={i}><path d={`M40 ${24 + i * 12} H200`} className="lg-jacket-unknown" strokeWidth={4} strokeDasharray="5 3" /><text x={120} y={23 + i * 12} textAnchor="middle" className="lg-thumb-caption">{String(obj(section).local_id)}</text></g>)}
    <text x={120} y={110} textAnchor="middle" className="lg-thumb-caption">{arr(cable.sections).length} pieces · {arr(cable.endpoints).length} declared ends</text>
  </Frame>;
  const ends = arr(cable.endpoints).map(obj);
  const section = stock ? stockSection(stock) : null;
  const conductors = section ? section.features.filter((f) => f.kind === "conductor").slice(0, 8) : [];
  const jacket = section?.features.find((f) => f.kind === "jacket");
  const jacketColor = jacket ? displayColor(jacket) : null;
  const label = (end: Json, fallback: string) => (str(end.label) ?? fallback).slice(0, 14);
  const fan = (side: "left" | "right") => conductors.map((f, i) => {
    const spread = conductors.length > 1 ? (i / (conductors.length - 1) - 0.5) * 30 : 0;
    const [x1, x2] = side === "left" ? [76, 56] : [164, 184];
    return <path key={`${side}${f.path}`} d={`M${x1} 60 L${x2} ${60 + spread}`} stroke={displayColor(f)} strokeWidth={2.4} strokeLinecap="round" className="lg-wire" />;
  });
  return <Frame title={title}>
    <rect x={14} y={38} width={42} height={44} rx={5} className="lg-end-body" />
    <rect x={184} y={38} width={42} height={44} rx={5} className="lg-end-body" />
    {section
      ? <path d="M76 60 C 100 58 140 62 164 60" stroke={jacketColor ?? "currentColor"} strokeWidth={12} strokeLinecap="round" fill="none" className="lg-jacket" />
      : <path d="M56 60 L184 60" strokeWidth={10} strokeDasharray="4 3" fill="none" className="lg-jacket-unknown" />}
    {section && <path d="M76 56 C 100 54 140 58 164 56" stroke="#ffffff" strokeOpacity={0.25} strokeWidth={1} fill="none" />}
    {fan("left")}{fan("right")}
    <text x={35} y={96} textAnchor="middle" className="lg-thumb-caption">{ends[0] ? label(ends[0], "End A") : "end unknown"}</text>
    <text x={205} y={96} textAnchor="middle" className="lg-thumb-caption">{ends[1] ? label(ends[1], "End B") : "end unknown"}</text>
    {!section && <text x={120} y={46} textAnchor="middle" className="lg-thumb-note">stock not chosen</text>}
  </Frame>;
}

/** Board terminals by group with declared paths; the outline is not part of board content. */
function BoardThumb({ content, title }: { content: Json; title: string }) {
  const board = obj(content.interface);
  const terminals = arr(board.terminals).map(obj);
  if (!terminals.length) return <Frame title={title}><rect x={30} y={16} width={180} height={88} className="lg-board-outline" /><Note>no terminals recorded</Note></Frame>;
  const groups = [...new Set(terminals.map((t) => str(t.group) ?? ""))];
  const position = new Map<string, [number, number]>();
  groups.slice(0, 2).forEach((group, side) => {
    const members = terminals.filter((t) => (str(t.group) ?? "") === group).slice(0, 14);
    members.forEach((t, i) => position.set(String(t.terminal_id), [side === 0 ? 46 : 194, 24 + ((i + 0.5) * 72) / members.length]));
  });
  const internal = arr(board.internal_nodes).map(obj);
  internal.slice(0, 12).forEach((n, i) => position.set(String(n.node_id), [120, 24 + (i + .5) * 72 / Math.min(internal.length, 12)]));
  const internalIds = new Set(internal.map(n => String(n.node_id)));
  const paths = arr(board.paths).map(obj).slice(0, 24);
  return <Frame title={title}>
    <rect x={30} y={16} width={180} height={88} rx={3} className="lg-board-outline" />
    {paths.map((path, i) => {
      const a = position.get(String(path.from_terminal)), b = position.get(String(path.to_terminal));
      if (!a || !b) return null;
      const component = path.via === "component";
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      return <g key={i}>
        <path d={`M${a[0]} ${a[1]} C ${mx} ${a[1]}, ${mx} ${b[1]}, ${b[0]} ${b[1]}`} className="lg-trace" fill="none" />
        {component && <rect x={mx - 7} y={my - 3.5} width={14} height={7} className="lg-component" />}
      </g>;
    })}
    {[...position.entries()].map(([id, [x, y]]) => internalIds.has(id) ? <circle key={id} cx={x} cy={y} r={1.5}><title>Internal graph node, not a pad</title></circle> : <rect key={id} x={x - 3.5} y={y - 3.5} width={7} height={7} className="lg-pad" />)}
    <text x={120} y={114} textAnchor="middle" className="lg-thumb-caption">outline not recorded</text>
  </Frame>;
}

const LAYER_WORD: Record<string, string> = { connector: "connector", shell: "shell", inline: "inline", board: "board", boot: "boot", heatshrink: "heat-shrink" };

/** End assembly as its stack of layers, mating face first, with the join count. */
function EndStackThumb({ content, title }: { content: Json; title: string }) {
  const stack = obj(obj(content.interface).stack);
  const layers = arr(stack.layers).map(obj).slice(0, 5);
  const joins = arr(stack.joins).length;
  if (!layers.length) return <Frame title={title}><Note>no layers recorded</Note></Frame>;
  const width = Math.min(200 / layers.length - 6, 64);
  return <Frame title={title}>
    {layers.map((layer, i) => {
      const x = 20 + i * (width + 6);
      const parts = arr(layer.parts).map(obj).map((part) => str(obj(part.component).reference) ?? str(part.label) ?? "part");
      return <g key={i} data-layer={String(layer.kind)}>
        <rect x={x} y={34} width={width} height={44} rx={4} className={`lg-layer lg-layer-${String(layer.kind)}`} />
        <text x={x + width / 2} y={54} textAnchor="middle" className="lg-layer-word">{LAYER_WORD[String(layer.kind)] ?? String(layer.kind)}</text>
        {parts.length > 0 && <text x={x + width / 2} y={68} textAnchor="middle" className="lg-thumb-caption">{parts.slice(0, 2).join(" ")}</text>}
        {i > 0 && <path d={`M${x - 6} 56 h6`} className="lg-join" />}
      </g>;
    })}
    <text x={120} y={100} textAnchor="middle" className="lg-thumb-caption">{`${layers.length} layer${layers.length === 1 ? "" : "s"} · ${joins} join${joins === 1 ? "" : "s"}`}</text>
  </Frame>;
}

/** Intent lines: from contacts on the left, to contacts on the right; open questions dashed. */
function IntentThumb({ content, title }: { content: Json; title: string }) {
  const rows = arr(obj(content.interface).rows).map(obj).slice(0, 12);
  if (!rows.length) return <Frame title={title}><Note>no rows recorded</Note></Frame>;
  const step = 96 / rows.length;
  const targets = [...new Set(rows.flatMap((row) => [...arr(row.to_contact_ids), ...arr(obj(row.question).options).map((o) => obj(o).contact_id)]).map(String))].slice(0, 16);
  const toY = (id: string) => 12 + ((targets.indexOf(id) + 0.5) * 96) / Math.max(targets.length, 1);
  return <Frame title={title}>
    <rect x={14} y={8} width={30} height={104} rx={4} className="lg-end-body" />
    <rect x={196} y={8} width={30} height={104} rx={4} className="lg-end-body" />
    {rows.map((row, i) => {
      const y = 12 + (i + 0.5) * step;
      const question = obj(row.question);
      const asks = Object.keys(question).length > 0;
      const to = (asks ? arr(question.options).map((o) => String(obj(o).contact_id)) : arr(row.to_contact_ids).map(String)).filter((id) => targets.includes(id));
      const kind = str(obj(row.conductor).kind) ?? "unknown";
      return <g key={String(row.row_id ?? i)} data-row={String(row.row_id ?? i)} data-question={asks || undefined}>
        <circle cx={44} cy={y} r={2.5} className="lg-pin lg-pin-plain" />
        {to.map((id) => <path key={id} d={`M44 ${y} C 120 ${y}, 120 ${toY(id)}, 196 ${toY(id)}`} fill="none"
          className={asks ? "lg-intent-question" : kind === "unknown" ? "lg-intent-unknown" : "lg-intent-line"} />)}
        {to.length === 0 && <path d={`M44 ${y} h22`} className="lg-intent-unknown" />}
      </g>;
    })}
    {targets.map((id) => <circle key={id} cx={196} cy={toY(id)} r={2.5} className="lg-pin lg-pin-plain" />)}
  </Frame>;
}

/** Signal set as chips; unknown levels are hatched, never shown as a value. */
function SignalChips({ content, title }: { content: Json; title: string }) {
  const signals = arr(obj(content.interface).signals).map(obj);
  if (!signals.length) return <Frame title={title}><Note>no signals recorded</Note></Frame>;
  return <div className="lg-chips" role="img" aria-label={title}>
    {signals.slice(0, 9).map((signal, i) => {
      const unknown = str(obj(signal.level).status) === "unknown";
      return <span key={String(signal.key ?? i)} className="lg-chip" data-unknown={unknown || undefined}>{str(signal.name) ?? String(signal.key)}</span>;
    })}
    {signals.length > 9 && <span className="lg-chip lg-chip-more">+{signals.length - 9}</span>}
  </div>;
}

const GLYPH: Record<string, string> = {
  part: "PART", assembly: "ASM", harness: "HAR", bom_plan: "BOM", material_plan: "MAT", option_set: "OPT", configuration: "CFG",
  workshop_profile: "PROF", preparation_profile: "PREP", end_preparation_profile: "END", cable_test_plan: "TEST", firmware: "FW",
  mechanical_source: "MECH", pcb_population: "POP", development_need: "NEED", conductor_convention: "CONV", passage_model: "PASS",
};

function Glyph({ kind, title }: { kind: string; title: string }) {
  return <Frame title={title}>
    <rect x={70} y={22} width={100} height={70} rx={4} className="lg-glyph" />
    <text x={120} y={64} textAnchor="middle" className="lg-glyph-word">{GLYPH[kind] ?? kind.slice(0, 4).toUpperCase()}</text>
  </Frame>;
}

/**
 * The drawn thumbnail of a library item, from its newest content (latest frozen revision, else
 * newest draft). Each kind uses the drawing that says most about it; anything not recorded is
 * said so in the drawing rather than filled with a default.
 */
export function ItemThumb({ kind, label, preview, recordId }: { kind: string; label: string; preview: LibraryPreview | null | undefined; recordId: string }) {
  const title = `${label} (${kind.replaceAll("_", " ")})`;
  if (preview === undefined) return <div className="lg-thumb-loading" aria-hidden="true" />;
  if (preview === null) return <Frame title={title}><Note>preview unavailable</Note></Frame>;
  if (preview.truncated) return <Frame title={title}><Note>too large to preview</Note></Frame>;
  const content = obj(preview.content);
  switch (kind) {
    case "wire_stock": return <StockThumb stock={content.stock} title={title} id={recordId} />;
    case "cable": return <CableThumb content={content} stock={preview.stock} title={title} />;
    case "board": return <BoardThumb content={content} title={title} />;
    case "end_assembly": return <EndStackThumb content={content} title={title} />;
    case "cable_intent": return <IntentThumb content={content} title={title} />;
    case "signal_set": return <SignalChips content={content} title={title} />;
    case "connector_body": case "pinout": case "port":
      return <ConnectorThumb kind={kind} content={content} body={preview.body ?? null} pinout={preview.pinout ?? null} signalTypes={preview.signal_types ?? {}} title={title} />;
    default: return <Glyph kind={kind} title={title} />;
  }
}
