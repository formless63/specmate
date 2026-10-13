export { command, read, type Definition, type Identity } from "../identity/api";
export type Orientation = { viewing_side: "mating" | "termination" | "unknown"; rotation_degrees: number | null; datum: string | null };
export type Contact = { contact_id: string; physical_role: "contact" | "shell" | "key"; label: string; position_mm: [number, number] | null };
export type Electrical = { signal: string | null; role: string; direction: string; voltage_min_v: number | null; voltage_max_v: number | null; current_max_a: number | null; protocol: string | null; condition: string | null; basis: string | null };
export type Body = { kind: "connector_body"; schema_version?: "0.1"; family: string | null; mating_role: string; contacts: Contact[]; drawing_orientation: Orientation };
export type Pinout = { kind: "pinout"; schema_version?: "0.1"; body_revision_id: string; assignments: { contact_id: string; electrical: Electrical }[]; review: "unreviewed" | "reviewed"; review_basis: string | null; orientation: Orientation };
export type Passage = { local_id: string; external_contact_id: string; kind: "declared_passage"; internal: { path: string[]; revision_id: string; feature_id: string }; condition: string | null; basis: string };
export type Mapping = { kind: "interface_map"; schema_version?: "0.1"; assembly_revision_id: string; external_pinout_revision_id: string; passages: Passage[] };
export type Interface = Body | Pinout | Mapping;
export type Draft = { definition_id: string; draft_id: string; state: string; content: { interface: Interface } };
export type Inspection = { revision_id: string; interface: Interface; compatibility: "not_evaluated"; contacts?: (Contact & { electrical: Electrical | null })[] };
export type Trace = { external_contact_id: string; status: string; continuity: string; compatibility: string; targets: { passage_id: string; assembly_revision_id: string; snapshot_id: string; path: string[]; revision_id: string; feature_id: string; condition: string | null; basis: string; feature_status: string }[] };
export const unknownOrientation = (): Orientation => ({ viewing_side: "unknown", rotation_degrees: null, datum: null });
export const unknownElectrical = (): Electrical => ({ signal: null, role: "unknown", direction: "unknown", voltage_min_v: null, voltage_max_v: null, current_max_a: null, protocol: null, condition: null, basis: null });
export function initialInterface(kind: Interface["kind"]): Interface {
  if (kind === "connector_body") return { kind, family: null, mating_role: "unknown", contacts: [], drawing_orientation: unknownOrientation() };
  if (kind === "pinout") return { kind, body_revision_id: "", assignments: [], review: "unreviewed", review_basis: null, orientation: unknownOrientation() };
  return { kind, assembly_revision_id: "", external_pinout_revision_id: "", passages: [] };
}
