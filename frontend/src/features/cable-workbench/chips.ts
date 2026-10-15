/**
 * Path chips in workshop language: "Coax 1 (red) center", "Board pad R", "R1 470 Ω",
 * "Pin 15 · Red video". The recorded label and any raw element path stay in the title.
 */
import type { Chip } from "../intent-check/api";
import { termKey, wireKey, type Drawing } from "./model";

export type WorkshopChip = { text: string; title: string; kind: string; unknown: boolean; key: string | null };
type Ref = { endpoint_id?: string; layer_id?: string; terminal_id?: string; element_path?: string };

/** "470R" → "470 Ω", "4k7R"-style values are left as written; a trailing "resistor" word is dropped. */
export function ohms(text: string): string {
  return text.replace(/\b(\d+(?:\.\d+)?)\s?([kKM]?)R\b/g, (_m, value: string, prefix: string) => `${value} ${prefix ? prefix.replace("K", "k") : ""}Ω`)
    .replace(/\s+resistor$/i, "");
}

const STEP_WORDS: Record<string, string> = { termination: "landed", landing: "carried", mated: "mated" };

/** One terminal in workshop words ("Pin 15 · Red video", "Board pad R", "R2 lead 1"), else the fallback. */
export function terminalWords(drawing: Drawing, endpointId: string, layerId: string, terminalId: string, fallback: string): string {
  const t = drawing.terminals.get(termKey(endpointId, layerId, terminalId));
  const label = t?.label ?? terminalId;
  return t?.layerKind === "connector" ? `Pin ${label.split(" ")[0]}${t.signal ? ` · ${t.signal.name}` : ""}`
    : t?.layerKind === "board" ? `Board pad ${label}`
    : t?.layerKind === "inline" ? label.replace(/ · (\d+)$/, " lead $1")
    : t?.layerKind === "shell" ? "Shell body"
    : fallback;
}

/** A proposed or declared landing in workshop words: "Coax 3 (blue) center → Board pad B". */
export function landingWords(drawing: Drawing, a: { endpoint_id: string; element_path: string; layer_id: string; terminal_id: string; terminal_label?: string }): string {
  const wire = drawing.wires.find((w) => w.path === a.element_path)?.display ?? a.element_path;
  return `${wire} → ${terminalWords(drawing, a.endpoint_id, a.layer_id, a.terminal_id, a.terminal_label ?? a.terminal_id)}`;
}

export function workshopChips(path: Chip[], drawing: Drawing): WorkshopChip[] {
  const out: WorkshopChip[] = [];
  for (const chip of path) {
    const ref = (chip as Chip & { ref?: Ref }).ref;
    const unknown = chip.status === "unknown";
    if (ref?.element_path) {
      // A conductor reads once however many ends and steps name it.
      const key = wireKey(ref.element_path);
      if (out.at(-1)?.key === key) continue;
      const wire = drawing.wires.find((w) => w.key === key);
      out.push({ text: wire?.display ?? chip.label, title: ref.element_path, kind: "conductor", unknown, key });
      continue;
    }
    if (ref?.endpoint_id && ref.layer_id && ref.terminal_id) {
      const key = termKey(ref.endpoint_id, ref.layer_id, ref.terminal_id);
      const text = terminalWords(drawing, ref.endpoint_id, ref.layer_id, ref.terminal_id, chip.label);
      out.push({ text, title: `${chip.label} (end ${ref.endpoint_id.toUpperCase()}, ${ref.layer_id} ${ref.terminal_id})`, kind: chip.kind, unknown, key });
      continue;
    }
    const text = chip.kind === "board_path" || chip.kind === "inline_part" ? ohms(chip.label) : STEP_WORDS[chip.kind] ?? chip.label;
    out.push({ text, title: chip.label, kind: chip.kind, unknown, key: null });
  }
  return out;
}
