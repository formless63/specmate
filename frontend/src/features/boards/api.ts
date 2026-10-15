export { command, read, type Definition, type Identity } from "../identity/api";

export const TERMINAL_KINDS = ["solder_pad", "through_hole", "connector_contact", "test_point", "unknown"] as const;
export const SIDES = ["top", "bottom", "both", "unknown"] as const;
export const COMPONENT_KINDS = ["resistor", "capacitor", "diode", "inductor", "transformer", "active", "unknown"] as const;
export const VIAS = ["copper", "component", "switch", "unknown"] as const;

export type BoardTerminal = {
  terminal_id: string; label: string; group: string | null; kind: typeof TERMINAL_KINDS[number]; side: typeof SIDES[number];
  native_pad_ids: string[]; note: string | null;
};
/** A part on a signal path; exact parameters are decimal strings, blank is unknown. Shared with inline cable parts. */
export type InlineComponent = { kind: typeof COMPONENT_KINDS[number]; value: string | null; reference: string | null; resistance_ohm: string | null; capacitance_f: string | null };
export type CarriedConnector = { local_id: string; body_revision_id: string; correspondence: { terminal_id: string; contact_id: string }[]; review: "unreviewed" | "reviewed"; basis: string | null };
export type BoardCondition = { key: string; name: string; choices: { key: string; name: string }[] };
export type BoardPath = {
  local_id: string; from_terminal: string; to_terminal: string; via: typeof VIAS[number];
  component: InlineComponent | null; switch: { condition_key: string; closed_when: string } | null;
  provenance: "declared" | "reported_net_membership" | "native_component_passage"; basis: string;
};
export type KicadOrigin = { population_revision_id: string; interpretation_id: string; interpretation_sha256: string };
export type Board = {
  kind: "board"; schema_version?: "0.1"; origin: "black_box" | "kicad_derived"; derived_from: KicadOrigin | null;
  terminals: BoardTerminal[]; carried_connectors: CarriedConnector[]; conditions: BoardCondition[]; paths: BoardPath[];
  review: "unreviewed" | "reviewed"; review_basis: string | null;
};
export type BoardDraft = { definition_id: string; kind: string; draft_id: string; state: string; content: { interface?: Board } };

export type Landing = { connector_id: string; body_name: string; contact_id: string; number: string | null; label: string; status: "reviewed" | "unknown" };
export type BoardView = {
  origin: Board["origin"]; derived_from: KicadOrigin | null; review: Board["review"];
  terminals: (BoardTerminal & { landings: Landing[]; path_ids: string[]; connection: "declared" | "unknown" })[];
  connectors: (CarriedConnector & { body_name: string; body_revision_number: number; mating_role: string; status: "reviewed" | "unknown"; contacts_without_terminal: string[] })[];
  paths: (BoardPath & { from_label: string; to_label: string; summary: string; evidence: string })[];
  continuity: "not_evaluated";
};
export type BoardInspection = { revision_id: string; interface: Board; board: BoardView };
export type BoardTrace = {
  status: string; reason: string; series_resistance_ohm: string | null; limited: boolean;
  paths: { terminal_ids: string[]; terminal_labels: string[]; status: string; reasons: string[]; steps: { kind: string; status: string }[] }[];
};
export type ProposalComponent = { component_id: string; reference: string; value: string; footprint: string; pad_count: number; port_association: boolean; selected: boolean };
export type BoardProposal = {
  status: "proposed"; review: "required"; population_revision_id: string; population_name: string; population_revision_number: number;
  board: Board; components: ProposalComponent[]; unmapped_passages: { reference: string | null; reason: string }[]; limitations: string[];
};

export const emptyBoard = (): Board => ({ kind: "board", origin: "black_box", derived_from: null, terminals: [], carried_connectors: [], conditions: [], paths: [], review: "unreviewed", review_basis: null });
export const emptyComponent = (): InlineComponent => ({ kind: "unknown", value: null, reference: null, resistance_ohm: null, capacitance_f: null });

/** A stable terminal ID from a label, unique among `taken`; IDs never change when a label is edited later. */
export function terminalId(label: string, taken: string[]): string {
  const base = label.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[-_.]+|[-.]+$/g, "").slice(0, 56) || "pad";
  let key = base, n = 2;
  while (taken.includes(key)) key = `${base}-${n++}`;
  return key;
}

/** Plain words for a path, e.g. "R1 470R resistor" or "Straight copper". */
export function pathSummary(path: BoardPath, conditions: BoardCondition[]): string {
  if (path.via === "copper") return path.provenance === "declared" ? "Straight copper" : "Same native net";
  if (path.via === "component" && path.component) {
    const c = path.component;
    return [c.reference, c.value, c.kind !== "unknown" ? c.kind : null].filter(Boolean).join(" ") || "component, unknown";
  }
  if (path.via === "switch" && path.switch) {
    const condition = conditions.find((c) => c.key === path.switch!.condition_key);
    const choice = condition?.choices.find((x) => x.key === path.switch!.closed_when);
    return `${condition?.name ?? path.switch.condition_key}: closed in ${choice?.name ?? path.switch.closed_when}`;
  }
  return "Unknown";
}

export function proposalPath(populationRevisionId: string, componentIds: string[] | null): string {
  const query = new URLSearchParams({ population_revision_id: populationRevisionId });
  for (const id of componentIds ?? []) query.append("component_id", id);
  return `interfaces/boards/propose?${query.toString()}`;
}
