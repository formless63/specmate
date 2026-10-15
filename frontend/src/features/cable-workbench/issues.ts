import { evaluateFit, type StockSpecification } from "../../../../packages/section-layout/src";
import { STOCK_KEY } from "./model";
import type { Cable } from "../cables/api";
import { cableProblems } from "../cables/api";
import type { IntentCheck } from "../intent-check/api";
import { declaredLength } from "../cables/CableSummary";
import type { Drawing } from "./model";
export type CableIssue = { key: string; text: string; state: "fail" | "unknown" | "not_evaluated"; selection?: string };
/** Local completeness is not an engineering pass. Only an applicable completed check can clear it. */
export function cableIssues(cable: Cable, drawing: Drawing, check: IntentCheck | null, dirty: boolean, unavailable: boolean, stock?: StockSpecification): CableIssue[] {
  const issues: CableIssue[] = cableProblems(cable).map((text, index) => ({ key: `missing:${index}`, text, state: "unknown" }));
  if (!declaredLength(cable)) issues.push({ key: "length", text: "Cable length is not declared.", state: "unknown", selection: STOCK_KEY });
  for (const end of cable.endpoints) if (end.stock_end === "unknown") issues.push({ key: `stock-end:${end.local_id}`, text: `${end.label || `End ${end.local_id.toUpperCase()}`}: stock end is unknown.`, state: "unknown", selection: `e:${end.local_id}` });
  for (const wire of drawing.wires) if (!wire.aTerminal || !wire.bTerminal) issues.push({ key: `open:${wire.key}`, text: `${wire.display}: at least one end is not landed.`, state: "unknown", selection: wire.key });
  if (!stock) issues.push({ key: "stock-fit", text: "Stock geometry is unavailable; fit is not evaluated.", state: "not_evaluated", selection: STOCK_KEY });
  else {
    try {
      const fit = evaluateFit(stock);
      for (const [index, finding] of fit.findings.entries()) if (finding.status !== "note") issues.push({ key: `fit:${index}`, text: `Stock fit: ${finding.message}`, state: finding.status, selection: STOCK_KEY });
      if (!fit.checks) issues.push({ key: "stock-fit", text: "Stock fit has no applicable geometry checks.", state: "not_evaluated", selection: STOCK_KEY });
    } catch { issues.push({ key: "stock-fit", text: "Stock geometry could not be evaluated.", state: "not_evaluated", selection: STOCK_KEY }); }
  }
  if (dirty) issues.push({ key: "unsaved", text: "Working changes are not checked. Save to evaluate this state.", state: "not_evaluated" });
  else if (!cable.intent_revision_id) issues.push({ key: "no-intent", text: "No intent is pinned; engineering checks are not evaluated.", state: "not_evaluated" });
  else if (!check) issues.push({ key: "no-check", text: unavailable ? "The saved-state check is unavailable." : "The applicable engineering check has not completed.", state: "not_evaluated" });
  if (!dirty && check) {
    for (const row of check.rows) if (row.outcome !== "pass") issues.push({ key: `row:${row.row_id}`, text: `${row.signal?.name ?? row.row_id}: ${row.outcome.replaceAll("_", " ")}.`, state: row.outcome === "fail" ? "fail" : row.outcome === "unknown" ? "unknown" : "not_evaluated", selection: `r:${row.row_id}` });
    for (const row of check.rows) for (const [name, dimension] of Object.entries(row.dimensions)) if (dimension.status !== "pass") issues.push({ key: `dimension:${row.row_id}:${name}`, text: `${row.signal?.name ?? row.row_id} · ${name}: ${dimension.reason}`, state: dimension.status === "fail" ? "fail" : dimension.status === "unknown" ? "unknown" : "not_evaluated", selection: `r:${row.row_id}` });
    for (const [end, details] of Object.entries(check.ends)) if (details.mating.status !== "pass") issues.push({ key: `mating:${end}`, text: `${details.label} mating: ${details.mating.reason}`, state: details.mating.status === "fail" ? "fail" : details.mating.status === "unknown" ? "unknown" : "not_evaluated", selection: `e:${details.endpoint_id}` });
    for (const [name, dimension] of Object.entries(check.cable)) if (dimension.status !== "pass") issues.push({ key: `cable:${name}`, text: `${name}: ${dimension.reason}`, state: dimension.status === "fail" ? "fail" : dimension.status === "unknown" ? "unknown" : "not_evaluated" });
    if (!check.rows.length) issues.push({ key: "empty-check", text: "The intent has no evaluated signal rows.", state: "not_evaluated" });
  }
  return issues;
}
