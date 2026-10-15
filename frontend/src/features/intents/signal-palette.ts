import type { SignalType } from "../interfaces/api";

/** Signal-type families of the data palette: what a pin or line carries, never whether it passed. */
export type SignalFamily = "video" | "sync" | "audio" | "power" | "ground" | "control" | "data" | "unknown";

export function signalFamily(type: SignalType | null | undefined): SignalFamily {
  switch (type) {
    case "analog_video": return "video";
    case "sync": return "sync";
    case "analog_audio": case "digital_audio": return "audio";
    case "power": return "power";
    case "ground_return": case "shield": case "chassis": return "ground";
    case "control": return "control";
    case "data": return "data";
    default: return "unknown";
  }
}

/** Fallbacks keep the drawing themed where the `--sb-signal-*` palette is not defined yet. */
const FALLBACK: Record<Exclude<SignalFamily, "unknown">, string> = {
  video: "var(--sb-info)", sync: "var(--sb-compare)", audio: "var(--sb-pass)", power: "var(--sb-invalid)",
  ground: "var(--sb-text-tertiary)", control: "var(--sb-review)", data: "var(--sb-focus)",
};

/** The theme color of a family; unknown is the tertiary ink and callers draw it dashed or hatched. */
export function familyColor(family: SignalFamily): string {
  return family === "unknown" ? "var(--sb-text-tertiary)" : `var(--sb-signal-${family}, ${FALLBACK[family]})`;
}
