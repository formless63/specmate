import type { CableEnd, EndRow, ResolvedSignal, SignalRef } from "../interfaces/api";
export { command, read, type Definition, type Identity } from "../identity/api";

export type Conditioning = "series_resistor" | "series_capacitor" | "shunt_resistor" | "attenuator" | "other";
export type ConductorRequirement = { kind: "coax" | "pair" | "single" | "any" | "unknown"; impedance_ohm: number | null; basis: string | null };
export type RequiredPart = { conditioning: Conditioning; value: string | null; where: "anywhere" | "from_end" | "to_end"; basis: string };
export type Question = { kind: "several_destinations" | "name_and_type_only" | "conditional_pin"; text: string; options: { contact_id: string; label: string }[] };
export type Requirement = "required" | "optional" | "must_not_connect";
export type ReturnPolicy = "dedicated_screen" | "shared_ground" | "any" | "not_applicable" | "unknown";
export type IntentRow = {
  row_id: string; requirement: Requirement; from_contact_id: string | null; to_contact_ids: string[]; signal_ref: SignalRef | null;
  pairing: "same_signal" | "answered" | "declared" | "unpaired"; return_policy: ReturnPolicy; conductor: ConductorRequirement;
  isolation?: "no_unlisted_connections" | "unlisted_allowed" | "unknown" | null;
  required_parts: RequiredPart[]; question: Question | null; basis: string | null;
};
export type ShieldPolicy = { policy: "bond_from" | "bond_to" | "bond_both" | "isolated" | "unknown"; basis: string | null };
export type CableIntent = {
  kind: "cable_intent"; schema_version?: "0.1"; from_revision_id: string; to_revision_id: string; description: string | null;
  rows: IntentRow[]; isolation: "no_unlisted_connections" | "unlisted_allowed" | "unknown"; shield: ShieldPolicy;
  review: "unreviewed" | "reviewed"; review_basis: string | null;
};
export type IntentDraft = { definition_id: string; kind: string; draft_id: string; state: string; content: { interface?: CableIntent } };
export type EndSummary = Omit<CableEnd, "rows"> & { name: string; revision_number: number };
export type Proposal = { from: CableEnd & { name: string }; to: CableEnd & { name: string }; rows: IntentRow[]; open_questions: number; unassigned_from_contacts: { contact_id: string; label: string }[]; status: "proposed"; review: "required" };
export type IntentView = {
  from: EndSummary; to: EndSummary; open_questions: number;
  rows: (IntentRow & { from_label: string | null; to_labels: string[]; signal: ResolvedSignal | null; open: boolean })[];
  check: { status: "not_evaluated"; reason: string }; proposal: { status: "not_evaluated"; reason: string };
};
export type IntentInspection = { revision_id: string; interface: CableIntent; intent: IntentView };

export const emptyIntent = (): CableIntent => ({ kind: "cable_intent", from_revision_id: "", to_revision_id: "", description: null, rows: [], isolation: "unknown", shield: { policy: "unknown", basis: null }, review: "unreviewed", review_basis: null });

export const REQUIREMENT_LABELS: Record<Requirement, string> = { required: "Required", optional: "Optional", must_not_connect: "Must not connect" };
export const RETURN_LABELS: Record<ReturnPolicy, string> = { dedicated_screen: "Own screen", shared_ground: "Shared ground", any: "Any return", not_applicable: "Is a return", unknown: "unknown" };
export const CONDITIONING_LABELS: Record<Conditioning, string> = { series_resistor: "Series resistor", series_capacitor: "Series capacitor", shunt_resistor: "Shunt resistor", attenuator: "Attenuator", other: "Other part" };

/** "3 · Video ground": a contact by its number and declared signal. */
export function contactText(row: EndRow | undefined, contactId: string): string {
  if (!row) return contactId;
  const number = row.number ?? row.contact_id;
  return row.signal ? `${number} · ${row.signal.name}` : number;
}

export function conductorText(c: ConductorRequirement): string | null {
  if (c.kind === "unknown") return null;
  return `${c.kind}${c.impedance_ohm !== null ? ` ${c.impedance_ohm} Ω` : ""}`;
}

export const proposalPath = (from: string, to: string) => `interfaces/intents/propose?from_revision_id=${encodeURIComponent(from)}&to_revision_id=${encodeURIComponent(to)}`;

export function rowIsolationText(row: IntentRow): string { return row.isolation == null ? "Strict (legacy)" : row.isolation === "unknown" ? "Unknown" : row.isolation === "unlisted_allowed" ? "Other contacts allowed" : "Only listed contacts"; }
