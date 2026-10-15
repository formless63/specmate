import type { SignalType } from "../interfaces/api";

/** Signal-type families of the data palette (theme tokens `--sb-signal-*`). */
export type SignalFamily = "video" | "sync" | "audio" | "power" | "ground" | "control" | "data" | "other";

export const FAMILIES: readonly SignalFamily[] = ["video", "sync", "audio", "power", "ground", "control", "data", "other"];

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
    default: return "other";
  }
}

/** The theme color of a family; "other" is the secondary ink. */
export function familyColor(family: SignalFamily): string {
  return family === "other" ? "var(--sb-text-secondary)" : `var(--sb-signal-${family})`;
}

export const FAMILY_LABELS: Record<SignalFamily, string> = {
  video: "Video", sync: "Sync", audio: "Audio", power: "Power", ground: "Ground", control: "Control", data: "Data", other: "Other",
};
