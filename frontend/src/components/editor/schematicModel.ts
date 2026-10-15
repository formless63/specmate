import { layoutDrawing, type DrawingInput } from "../../features/cable-workbench/model";

export type SchematicLanding = {
  key: string | null; end: string; target: string; basis: string;
  state: "declared" | "unassigned" | "unresolved";
};
export type SchematicRow = {
  key: string; path: string; label: string; kind: string; color: string | null;
  stock: "declared" | "missing" | "unknown"; ends: SchematicLanding[];
};

/** Same declared termination meaning as coordinated schematic documents, over a live cable.
 * A stock element is an identity, never evidence that its two terminations conduct. */
export function schematicRows(input: DrawingInput): SchematicRow[] {
  const drawing = layoutDrawing(input);
  const stockKnown = !!input.stock || input.conductors !== undefined;
  return drawing.wires.map(wire => ({
    key: wire.key, path: wire.path, label: stockKnown ? wire.display : wire.path,
    kind: stockKnown && wire.inStock ? wire.kind : "kind unknown",
    color: stockKnown && wire.inStock && ["recorded", "conventional-name"].includes(wire.look?.fillSource ?? "") ? wire.look?.base ?? null : null,
    stock: stockKnown ? wire.inStock ? "declared" : "missing" : "unknown",
    ends: [0, 1].map(index => {
      const endpoint = input.cable.endpoints[index];
      const end = endpoint?.label || `End ${String.fromCharCode(65 + index)}`;
      const assignment = endpoint && input.cable.assignments.find(row => row.endpoint_id === endpoint.local_id && row.element_path === wire.path);
      if (!assignment) return { key: null, end, target: endpoint ? "Unassigned" : "End not declared", basis: "", state: "unassigned" };
      const terminal = drawing.terminals.get(index === 0 ? wire.aTerminal ?? "" : wire.bTerminal ?? "");
      const layer = input.stacks[index]?.layers.find(item => item.layer_id === assignment.layer_id);
      const resolved = terminal && terminal.layerKind !== "unknown";
      return {
        key: terminal?.key ?? null, end, target: resolved ? `${layer?.name || assignment.layer_id} · ${terminal.label}` : `${assignment.layer_id} · ${assignment.terminal_id} (unresolved)`,
        basis: assignment.basis, state: resolved ? "declared" : "unresolved",
      };
    }),
  }));
}
