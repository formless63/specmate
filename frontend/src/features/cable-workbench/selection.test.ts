import { expect, test } from "vitest";
import { cableSelection, withCableSelection } from "./selection";

test("shared cable selection preserves exact revisions, occurrence paths and unknown feature segments", () => {
  const root = { object: "cable", rev: 7, path: ["second", "unknown-feature"] };
  const wire = withCableSelection(root, "w:stock.core-1.center");
  expect(wire).toEqual({ ...root, path: [...root.path, "#w:stock.core-1.center"] });
  expect(cableSelection(wire)).toBe("w:stock.core-1.center");
  expect(withCableSelection(wire, "t:b/connector/2")).toEqual({ ...root, path: [...root.path, "#t:b/connector/2"] });
  expect(withCableSelection(wire, null)).toEqual(root);
  const unknown = { ...root, path: ["#future-kind:stable-id"] };
  expect(cableSelection(unknown)).toBeNull();
  expect(withCableSelection(unknown, null)).toEqual(unknown);
  expect(withCableSelection(unknown, "w:new").path).toEqual(["#future-kind:stable-id", "#w:new"]);
});
