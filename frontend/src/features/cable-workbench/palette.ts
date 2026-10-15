import type { SignalType } from "../interfaces/api";
import type { Status } from "../intent-check/api";

/** Signal-type families of the data palette (theme tokens `--sb-signal-*`). */
export type SignalFamily = "video" | "sync" | "audio" | "power" | "ground" | "control" | "data" | "unknown";

/** What a signal type is drawn as. Families are a data palette: they never say pass or fail. */
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

/** The theme color of a family; unknown is the tertiary ink and is drawn hatched by callers. */
export function familyColor(family: SignalFamily): string {
  return family === "unknown" ? "var(--sb-text-tertiary)" : `var(--sb-signal-${family})`;
}

export const FAMILY_LABELS: Record<SignalFamily, string> = {
  video: "video", sync: "sync", audio: "audio", power: "power", ground: "ground", control: "control", data: "data", unknown: "unknown",
};

/** Outcome precedence: one failing row makes an element fail; unknown outranks a pass. */
const RANK: Record<Status, number> = { fail: 5, unknown: 4, flagged: 3, not_evaluated: 2, pass: 1 };
export function worst(statuses: Iterable<Status>): Status | null {
  let found: Status | null = null;
  for (const status of statuses) if (!found || RANK[status] > RANK[found]) found = status;
  return found;
}

export const STATUS_WORDS: Record<Status, string> = { pass: "pass", fail: "fail", unknown: "unknown", not_evaluated: "not evaluated", flagged: "flagged" };
