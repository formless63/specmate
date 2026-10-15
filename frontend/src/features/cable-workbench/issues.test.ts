import { expect, test } from "vitest";
import { cableIssues } from "./issues";
import { boardEnd, cable, check, inlineEnd, row, stock } from "./fixtures";
import { layoutDrawing } from "./model";
const drawing = () => layoutDrawing({ cable: cable(), stock: stock(), stacks: [boardEnd(), inlineEnd()] });

test("unchecked and dirty designs keep explicit not-evaluated issues", () => {
  const value = cable();
  expect(cableIssues(value, drawing(), null, false, false).some(issue => issue.key === "no-intent")).toBe(true);
  expect(cableIssues(value, drawing(), check([]), true, false).some(issue => issue.key === "unsaved")).toBe(true);
  expect(cableIssues(value, drawing(), null, false, false).some(issue => issue.key === "stock-fit" && issue.state === "not_evaluated")).toBe(true);
});

test("row aggregate pass cannot erase unknown dimensions, stock fit conflicts, or unlanded wires", () => {
  const value = { ...cable(), intent_revision_id: "intent" };
  const result = check([row("video", "pass", [])]);
  const small = stock(); const jacket = small.structure.children.find(child => child.kind === "jacket")!;
  if (jacket.kind === "jacket") { jacket.outer_diameter_mm = 1; jacket.inner_diameter_mm = 0.8; }
  const issues = cableIssues(value, drawing(), result, false, false, small);
  expect(issues.some(issue => issue.key === "dimension:video:level" && issue.state === "not_evaluated")).toBe(true);
  expect(issues.some(issue => issue.key.startsWith("fit:") && issue.state === "fail")).toBe(true);
  expect(issues.some(issue => issue.key.startsWith("open:") && issue.state === "unknown")).toBe(true);
});
