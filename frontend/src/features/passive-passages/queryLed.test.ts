import { expect, test } from "vitest";
import { queryLed } from "./PathExplanation";

test("each passive query state has its own LED and none is a generic OK", () => {
  expect(queryLed("unknown")).toBe("review");
  expect(queryLed("not_evaluated")).toBe("not-evaluated");
  expect(queryLed("modeled_blocked")).toBe("failed");
  expect(queryLed("invalid_query")).toBe("failed");
  expect(queryLed("modeled_dc_path")).toBe("active");
  expect(queryLed("modeled_series_resistance")).toBe("active");
  expect(queryLed("something_new")).toBe("review");
});
