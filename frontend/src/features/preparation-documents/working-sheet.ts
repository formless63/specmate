import type { Sheet } from "../../../../packages/docs/src/model";
import type { DrawingInput } from "../cable-workbench/model";
import { schematicRows } from "../../components/editor/schematicModel";

/** Working buffer only: backend-derived practices, test pairs and quantities are never reused. */
export function workingSheet(name: string, definitionId: string, input: DrawingInput, dirty: boolean): Sheet {
  const wires = schematicRows(input);
  const landings = wires.flatMap(wire => wire.ends.map((end, index) => {
    const endpoint = input.cable.endpoints[index];
    const assignment = input.cable.assignments.find(row => row.element_path === wire.path && row.endpoint_id === endpoint?.local_id);
    return [0, "standalone", end.end, endpoint?.local_id ?? null, endpoint?.stock_end ?? null,
      wire.label, wire.path, assignment?.layer_id ?? null, end.target, null, null, assignment?.basis ?? null, end.state];
  })).map((row, index) => [index + 1, ...row.slice(1)]);
  const cut = input.cable.lengths?.stock_cut.declaration;
  return {
    name, state: dirty ? "UNRELEASED · working draft · unsaved changes" : "UNRELEASED · saved draft",
    unreleased: true, identity: definitionId, labels: [],
    tables: [
      { name: "Landings", headers: ["No.", "Context", "End", "End ID", "Stock end", "Conductor", "Element path", "Layer ID", "Target", "Signal", "Parts", "Basis", "Status"], rows: landings },
      { name: "Cuts", headers: ["Context", "Section", "Row kind", "Conductor", "Declared mm", "Suggested mm", "Design pieces", "Workshop pieces", "Design total mm", "Workshop total mm", "Basis"], rows: [["standalone", null, "declared physical piece", null, cut?.amount_mm ?? null, null, null, null, null, null, cut?.explanation ?? null]] },
      { name: "End preparation", headers: ["Instructions"], rows: [] },
      { name: "Continuity expectations", headers: ["Authored pair"], rows: [] },
      { name: "BOM", headers: ["Item", "Quantity"], rows: [] },
      { name: "Labels", headers: ["Text"], rows: [] },
    ],
    notices: ["Local working declarations; no reviewed document set or physical qualification.",
      "Unassigned and unresolved targets remain explicit. Practices, procurement quantities and test expectations require exact frozen inputs.",
      "Physical continuity, fit and physical tests are not evaluated."],
  };
}
