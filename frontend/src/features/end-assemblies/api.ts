import { apiErrorMessage } from "../../lib/api-errors";
import type { InlineComponent } from "../boards/api";
import type { SignalType } from "../interfaces/api";
export { command, read, type Definition, type Identity } from "../identity/api";

/** Layers of one cable end, ordered from the wire outward (see docs/modules/WIRING.md). */
export type ConnectorLayer = { kind: "connector"; layer_id: string; body_revision_id: string; pinout_revision_id: string };
export type BoardLayer = { kind: "board"; layer_id: string; board_revision_id: string; carried_connector_id: string | null; carried_connector_layer_id?: string | null };
/** Exact catalog provenance for an authored two-lead use; package pinout stays unassessed. */
export type InlinePart = { local_id: string; label: string | null; component: InlineComponent; part_revision_id?: string | null };
export type InlinePartIdentity = { revision_id: string; definition_id: string; name: string; number: number; package_pinout: "not_evaluated"; declared_use: "two_lead_inline"; behavior_source: "separate_authored_component" };
export type InlineLayer = { kind: "inline"; layer_id: string; parts: InlinePart[] };
export type ShellLayer = { kind: "shell"; layer_id: string; part_revision_id: string | null; label: string | null };
export type StackLayer = ConnectorLayer | BoardLayer | InlineLayer | ShellLayer;
export type LayerKind = StackLayer["kind"];
export type StackTerminal = { layer_id: string; terminal_id: string };
export type JoinKind = "solder" | "crimp" | "mated" | "integrated" | "bond";
export type Join = { local_id: string; a: StackTerminal; b: StackTerminal; through?: StackTerminal | null; kind: JoinKind; basis: string };
export type EndStack = { graph_version?: "0.1" | "0.2"; layers: StackLayer[]; joins: Join[] };
export type EndAssembly = { kind: "end_assembly"; schema_version?: "0.1"; description: string | null; stack: EndStack; review: "unreviewed" | "reviewed"; review_basis: string | null };
export type EndAssemblyDraft = { definition_id: string; kind: string; draft_id: string; state: string; content: { interface?: EndAssembly } };

export type SignalRef = { key: string; name: string; type: SignalType; set_name: string; set_revision_number: number };
export type Reach = { layer_id?: string; contact_id: string; label: string; signal: SignalRef | null; status: "declared" | "unknown"; via: string[] };
export type ResolvedTerminal = {
  terminal_id: string; label: string; kind: string; group?: string | null; part?: string;
  signal?: SignalRef | null; signal_status?: "declared" | "conditional" | "unknown"; signal_note?: string | null; role?: string;
  reaches: Reach[];
};
export type ResolvedLayer = {
  layer_id: string; kind: LayerKind; name: string | null; terminals: ResolvedTerminal[];
  variant_label?: string | null; pinout_name?: string | null; carried_connector_id?: string | null; carried_status?: "reviewed" | "unknown" | null;
  parts?: { local_id: string; name: string; summary: string; part_identity?: InlinePartIdentity }[]; electrical?: string;
  internal_nodes?: { node_id: string; label: string; basis: string }[];
  paths?: { local_id: string; from_terminal: string; to_terminal: string; via: string; summary: string }[];
};
export type ResolvedJoin = {
  local_id: string; kind: JoinKind | "carried"; basis: string; origin: "declared" | "board_carried_connector"; status: "declared" | "reviewed" | "unknown";
  a: StackTerminal & { label: string }; b: StackTerminal & { label: string }; through?: StackTerminal & { label: string };
};
export type ResolvedStack = {
  end_assembly_revision_id?: string | null; name?: string | null;
  layers: ResolvedLayer[]; joins: ResolvedJoin[]; connector_layer_id: string | null;
  body_revision_id: string | null; pinout_revision_id: string | null;
  evaluation: { layer_id: string; status: "not_evaluated"; reason: string }[]; continuity: "not_evaluated";
};
export type EndAssemblyInspection = { revision_id: string; interface: EndAssembly; end_stack: ResolvedStack };

export const LAYER_ORDER: LayerKind[] = ["board", "inline", "connector", "shell"];
export const LAYER_LABELS: Record<LayerKind, string> = { board: "Board", inline: "Inline parts", connector: "Connector", shell: "Shell" };
export const JOIN_KINDS: JoinKind[] = ["solder", "crimp", "mated", "integrated", "bond"];

export function newLayer(kind: LayerKind): StackLayer {
  if (kind === "connector") return { kind, layer_id: "connector", body_revision_id: "", pinout_revision_id: "" };
  if (kind === "board") return { kind, layer_id: "board", board_revision_id: "", carried_connector_id: null };
  if (kind === "inline") return { kind, layer_id: "inline", parts: [{ local_id: "r1", label: null, component: { kind: "resistor", value: null, reference: "R1", resistance_ohm: null, capacitance_f: null } }] };
  return { kind, layer_id: "shell", part_revision_id: null, label: null };
}
/** Adds a layer at its place in the wire-outward order: board, inline parts, connector, shell. */
export function addLayer(stack: EndStack, kind: LayerKind): EndStack {
  const layer = newLayer(kind);
  let n = 2;
  while (stack.layers.some((l) => l.layer_id === layer.layer_id)) layer.layer_id = `${kind}-${n++}`;
  const layers = [...stack.layers, layer];
  layers.sort((a, b) => LAYER_ORDER.indexOf(a.kind) - LAYER_ORDER.indexOf(b.kind));
  return { ...stack, ...(stack.layers.some((l) => l.kind === kind) ? { graph_version: "0.2" as const } : {}), layers };
}
export function removeLayer(stack: EndStack, layerId: string): EndStack {
  return { ...stack, layers: stack.layers.filter((l) => l.layer_id !== layerId).map((l) => l.kind === "board" && l.carried_connector_layer_id === layerId ? { ...l, carried_connector_id: null, carried_connector_layer_id: null } : l), joins: stack.joins.filter((j) => j.a.layer_id !== layerId && j.b.layer_id !== layerId && j.through?.layer_id !== layerId) };
}
export const connectorStack = (): EndStack => ({ layers: [newLayer("connector")], joins: [] });
export const emptyEndAssembly = (): EndAssembly => ({ kind: "end_assembly", description: null, stack: connectorStack(), review: "unreviewed", review_basis: null });

/** Whether every pinned reference is filled in, so the server can resolve the stack. */
export function stackComplete(stack: EndStack): boolean {
  return stack.layers.length > 0 && stack.layers.every((l) =>
    l.kind === "connector" ? !!l.body_revision_id && !!l.pinout_revision_id : l.kind === "board" ? !!l.board_revision_id : true);
}

export const terminalKey = (t: StackTerminal) => `${t.layer_id}/${t.terminal_id}`;
export function splitKey(key: string): StackTerminal {
  const at = key.indexOf("/");
  return { layer_id: key.slice(0, at), terminal_id: key.slice(at + 1) };
}

export class ResolveError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
/** Access denial (as opposed to an invalid stack): retained content must be withdrawn. */
export const resolveDenied = (error: unknown) => error instanceof ResolveError && [401, 403, 404].includes(error.status);

/** Resolve a stack or a frozen end assembly: layers, labeled terminals, joins (read-only). */
export async function resolveEnd(body: { stack: EndStack } | { end_assembly_revision_id: string }): Promise<ResolvedStack> {
  const csrf = document.cookie.split("; ").find((cookie) => cookie.startsWith("csrftoken="))?.split("=")[1];
  const response = await fetch("/api/v0/interfaces/end-stacks/resolve", {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRFToken": decodeURIComponent(csrf ?? "") },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new ResolveError(apiErrorMessage(result, `Request failed (${response.status})`), response.status);
  return result as ResolvedStack;
}

/** A terminal's display text with what it is declared to reach: "R → 4 · Red video". */
export function terminalText(t: ResolvedTerminal): string {
  if (t.signal) return `${t.label} · ${t.signal.name}`;
  const reach = t.reaches[0];
  if (reach) return `${t.label} → ${reach.layer_id ? `${reach.layer_id} / ` : ""}${reach.label}${reach.signal ? ` · ${reach.signal.name}` : ""}${reach.status === "unknown" ? " (unknown)" : ""}`;
  return t.label;
}
