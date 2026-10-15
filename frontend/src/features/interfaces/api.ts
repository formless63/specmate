import type { Evidence } from "./assessment-api";
export { command, read, type Definition, type Identity } from "../identity/api";
export type Orientation = { viewing_side: "mating" | "termination" | "unknown"; rotation_degrees: number | null; datum: string | null };
export type Temperature = { minimum_c: number | null; maximum_c: number | null };
export type ConditionalRating = { local_id: string; dimension: "voltage" | "current"; minimum: number | null; maximum: number | null; scope: { temperature: Temperature | null; mode: string | null }; basis: string; evidence: Evidence };
export type ContactView = { source_orientation: Orientation; selected_orientation: Orientation; mirrored: boolean | null; convention: string; limitations: string[]; contacts: { contact_id: string; number: string | null; label: string; physical_role: string; source_position_mm: [number, number] | null; display_position_mm: [number, number] | null; reason: string | null }[] };
export type Contact = { number?: string | null; contact_id: string; physical_role: "contact" | "shell" | "key"; label: string; position_mm: [number, number] | null };
export type SignalRef = { signal_set_revision_id: string; key: string };
export type Electrical = { signal_ref?: SignalRef | null; polarity?: "unknown" | "positive" | "negative" | "reference" | "nonpolarized"; polarity_basis?: string | null; conditional_ratings?: ConditionalRating[]; signal: string | null; role: string; direction: string; voltage_min_v: number | null; voltage_max_v: number | null; current_max_a: number | null; protocol: string | null; condition: string | null; basis: string | null };
export type MatesWith = { body_revision_id: string; correspondence: "same_contact_id" | "explicit"; pairs: { this: string; other: string }[]; review: "unreviewed" | "reviewed"; basis: string | null };
export type Body = { kind: "connector_body"; schema_version?: "0.1"; family: string | null; mating_role: string; contacts: Contact[]; drawing_orientation: Orientation; mates_with?: MatesWith[] };
export type PinoutRole = "source" | "sink" | "bidirectional" | "unknown";
export type PinoutCondition = { key: string; name: string; choices: { key: string; name: string }[] };
export type ConditionalSignal = { condition_key: string; choice: string; signal_ref: SignalRef | null; signal: string | null; role: string; basis: string };
export type Assignment = { contact_id: string; electrical: Electrical; alternatives?: ConditionalSignal[] };
export type Pinout = { kind: "pinout"; schema_version?: "0.1"; body_revision_id: string; variant_label?: string | null; role?: PinoutRole; standard?: string | null; conditions?: PinoutCondition[]; assignments: Assignment[]; review: "unreviewed" | "reviewed"; review_basis: string | null; orientation: Orientation };
export const SIGNAL_TYPES = ["analog_video", "sync", "analog_audio", "digital_audio", "power", "ground_return", "shield", "chassis", "data", "control", "other", "unknown"] as const;
export type SignalType = typeof SIGNAL_TYPES[number];
/** A declared value with its basis; unknown carries no numbers and is never shown as zero. */
export type DeclaredQuantity = { status: "known" | "unknown"; nominal: number | null; minimum: number | null; maximum: number | null; basis: string | null; unit?: string };
export type Signal = { key: string; name: string; type: SignalType; return_for: string[]; differential_with: string | null; level: DeclaredQuantity; impedance: DeclaredQuantity; notes: string | null; basis: string | null };
export type SignalSet = { kind: "signal_set"; schema_version?: "0.1"; description: string | null; signals: Signal[] };
/** A typed pin signal resolved against its exact set revision. */
export type ResolvedSignal = SignalRef & { name: string; type: SignalType; set_name: string; set_revision_number: number };
export type PinSignal = { status: "declared" | "conditional" | "unknown"; signal: ResolvedSignal | null; alternatives: { condition_key: string; choice: string; role: string; signal: string | null; signal_ref: ResolvedSignal | null }[] };
export type PinoutVariant = { definition_id: string; name: string; revision_id: string; number: number; variant_label: string | null; role: PinoutRole; standard: string | null; body_revision_id: string; same_body_revision: boolean };
export type Passage = { local_id: string; external_contact_id: string; kind: "declared_passage"; internal: { path: string[]; revision_id: string; feature_id: string }; condition: string | null; basis: string };
export type Mapping = { kind: "interface_map"; schema_version?: "0.1"; assembly_revision_id: string; external_pinout_revision_id: string; passages: Passage[] };
export const CONDITIONING = ["series_resistor", "series_capacitor", "shunt_resistor", "attenuator", "other"] as const;
export type CableNeed = { conditioning: typeof CONDITIONING[number]; value: string | null; basis: string };
export type PortPin = {
  contact_id: string; behaviour: "drives" | "accepts" | "passes" | "none" | "unknown"; level: DeclaredQuantity; impedance: DeclaredQuantity;
  coupling: "ac" | "dc" | "unknown"; termination: "source_terminated" | "load_terminated" | "none" | "unknown";
  needs_in_cable: CableNeed[]; must_not_connect: boolean; must_not_connect_reason: string | null; basis: string | null;
};
export type Port = { kind: "port"; schema_version?: "0.1"; device_label: string; pinout_revision_id: string; role: PinoutRole; selected_conditions: Record<string, string>; pins: PortPin[]; review: "unreviewed" | "reviewed"; review_basis: string | null };
export type Interface = Body | Pinout | Mapping | SignalSet | Port;
/** One contact of a cable end (a device port or a bare pinout variant). */
export type EndRow = {
  contact_id: string; number: string | null; label: string; physical_role: string; status: "declared" | "unknown"; reason?: string;
  role?: string; signal?: ResolvedSignal | null; note?: string | null; condition_key?: string; hazards?: string[];
  alternatives?: { choice: string; role: string; signal: string | null; signal_ref: ResolvedSignal | null }[]; device: PortPin | null;
};
export type CableEnd = { kind: "port" | "pinout"; revision_id: string; device_label: string | null; role: PinoutRole; variant_label: string | null; standard: string | null; pinout_revision_id: string; body_revision_id: string; selected_conditions: Record<string, string>; compatibility: "not_evaluated"; rows: EndRow[] };
export type MatingRow = MatesWith & { name: string; number: number; mating_role: string; status: "reviewed" | "unknown" };
export type MatedBy = { body_revision_id: string; name: string; number: number; declares_revision_id: string; correspondence: string; review: string; status: "reviewed" | "unknown" };
export type Draft = { definition_id: string; kind: Interface["kind"]; draft_id: string; state: string; content: { interface?: Interface } };
export type Inspection = { revision_id: string; interface: Interface; compatibility: "not_evaluated"; contact_view?: ContactView; contact_views?: Record<"mating" | "termination", ContactView>; rating_evidence?: Record<string, Record<string, Evidence>>; contacts?: (Contact & { electrical: Electrical | null })[]; signals?: Record<string, PinSignal>; pinout_variants?: PinoutVariant[]; mates_with?: MatingRow[]; mated_by?: MatedBy[]; end?: CableEnd };
export type Trace = { external_contact_id: string; status: string; continuity: string; compatibility: string; targets: { passage_id: string; assembly_revision_id: string; snapshot_id: string; path: string[]; revision_id: string; feature_id: string; condition: string | null; basis: string; feature_status: string }[] };
export const unknownOrientation = (): Orientation => ({ viewing_side: "unknown", rotation_degrees: null, datum: null });
export const unknownElectrical = (): Electrical => ({ polarity: "unknown", polarity_basis: null, conditional_ratings: [], signal: null, role: "unknown", direction: "unknown", voltage_min_v: null, voltage_max_v: null, current_max_a: null, protocol: null, condition: null, basis: null });
export function initialInterface(kind: Interface["kind"]): Interface {
  if (kind === "connector_body") return { kind, family: null, mating_role: "unknown", contacts: [], drawing_orientation: unknownOrientation() };
  if (kind === "pinout") return { kind, body_revision_id: "", variant_label: null, role: "unknown", standard: null, conditions: [], assignments: [], review: "unreviewed", review_basis: null, orientation: unknownOrientation() };
  if (kind === "signal_set") return { kind, description: null, signals: [] };
  if (kind === "port") return { kind, device_label: "", pinout_revision_id: "", role: "unknown", selected_conditions: {}, pins: [], review: "unreviewed", review_basis: null };
  return { kind, assembly_revision_id: "", external_pinout_revision_id: "", passages: [] };
}
export const unknownQuantity = (): DeclaredQuantity => ({ status: "unknown", nominal: null, minimum: null, maximum: null, basis: null });
export const newSignal = (key: string, name: string): Signal => ({ key, name, type: "unknown", return_for: [], differential_with: null, level: { ...unknownQuantity(), unit: "unknown" }, impedance: { ...unknownQuantity(), unit: "ohm" }, notes: null, basis: null });
/** Plain words for a signal type. */
export const SIGNAL_TYPE_LABELS: Record<SignalType, string> = {
  analog_video: "Analog video", sync: "Sync", analog_audio: "Analog audio", digital_audio: "Digital audio", power: "Power",
  ground_return: "Ground / return", shield: "Screen", chassis: "Chassis", data: "Data", control: "Control", other: "Other", unknown: "Type unknown",
};
export const unknownPortPin = (contactId: string): PortPin => ({
  contact_id: contactId, behaviour: "unknown", level: { ...unknownQuantity(), unit: "unknown" }, impedance: { ...unknownQuantity(), unit: "ohm" },
  coupling: "unknown", termination: "unknown", needs_in_cable: [], must_not_connect: false, must_not_connect_reason: null, basis: null,
});
