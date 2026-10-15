import { expect, test } from "vitest";
import { canonicalJson, editHistory } from "./history";

test("reordered JSONB objects are no-op edits while array order remains meaningful", () => {
  const value = { endpoints: [{ label: "A", pin: { revision: "exact", unknown: null } }], review: "unreviewed" };
  const history = { value, past: [], future: [] };
  const reordered = { review: "unreviewed", endpoints: [{ pin: { unknown: null, revision: "exact" }, label: "A" }] };
  expect(editHistory(history, { type: "edit", value: reordered })).toBe(history);
  expect(canonicalJson(["a", "b"])).not.toBe(canonicalJson(["b", "a"]));
});
