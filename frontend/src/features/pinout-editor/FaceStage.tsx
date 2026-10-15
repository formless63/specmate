import { SegmentedControl } from "@mantine/core";
import { useState, type ReactNode } from "react";
import { ConnectorFace, type ConnectorFacePin, type ConnectorGeometry } from "../../../../packages/connector-art/src";
import "./pinout-editor.css";

export type StripPin = { id: string; name: string; text: string; fill?: string; unknown?: boolean; marks?: string[] };

/**
 * The big connector face with a mating/solder toggle, a strip of pin buttons (the keyboard and
 * screen-reader path to every pin) and a legend. Presentation only: the drawing never
 * establishes fit, mating or contact identity.
 */
export function FaceStage({ geometry, pins, strip, selected, onSelect, caption, legend, banner }: {
  geometry: ConnectorGeometry; pins: ConnectorFacePin[]; strip: StripPin[]; selected: string | null; onSelect: (id: string | null) => void;
  caption: ReactNode; legend?: ReactNode; banner?: ReactNode;
}) {
  const [view, setView] = useState<"mating" | "solder">("mating");
  return <div className="pwb-stage">
    <div className="pwb-stage-bar">
      <span className="sb-silk">{caption}</span>
      <SegmentedControl size="xs" aria-label="Face view" value={view} onChange={(v) => setView(v as "mating" | "solder")} data={[{ value: "mating", label: "Mating face" }, { value: "solder", label: "Solder side" }]} />
    </div>
    {banner}
    <div className="pwb-face">
      <ConnectorFace geometry={geometry} view={view} pins={pins} selectedPinId={selected} onPinClick={(id) => onSelect(id === selected ? null : id)} size={460} />
    </div>
    <p className="pwb-face-note">{geometry.label}{geometry.gender === "ungendered" ? "" : geometry.gender === "male" ? " plug" : " socket"} · {view === "solder" ? "solder side (mirrored)" : "mating face"} · {geometry.numbering}</p>
    <PinStrip pins={strip} selected={selected} onSelect={onSelect} />
    {legend && <div className="pwb-legend">{legend}</div>}
  </div>;
}

/** One button per pin: number, short meaning and family color. */
export function PinStrip({ pins, selected, onSelect }: { pins: StripPin[]; selected: string | null; onSelect: (id: string | null) => void }) {
  return <div className="pwb-strip" role="group" aria-label="Pins">
    {pins.map((p) => <button type="button" key={p.id} className="pwb-strip-pin" aria-pressed={selected === p.id} data-unknown={p.unknown || undefined}
      style={p.fill ? { borderLeftColor: p.fill } : undefined} onClick={() => onSelect(selected === p.id ? null : p.id)} aria-label={`Pin ${p.name}: ${p.text}${p.marks?.length ? `, ${p.marks.join(", ")}` : ""}`}>
      <span className="pwb-strip-n">{p.name}</span><span className="pwb-strip-t">{p.text}</span>
      {p.marks?.map((m) => <span key={m} className="pwb-strip-mark" data-mark={m} aria-hidden="true" />)}
    </button>)}
  </div>;
}

/** Legend entries for the marks a face uses. */
export function FaceLegend({ marks }: { marks: ("must-not-connect" | "hazard" | "differs" | "unknown" | "conditional")[] }) {
  const words = { "must-not-connect": "must not connect", hazard: "hazard (may be power)", differs: "differs from compared variant", unknown: "unknown", conditional: "conditional (split)" };
  return <>{marks.map((m) => <span key={m}><span className="pwb-key" data-mark={m} aria-hidden="true" />{words[m]}</span>)}</>;
}
