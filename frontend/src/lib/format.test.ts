import { describe, expect, it } from "vitest";
import { formatCoordinates, formatNumber } from "./format";

describe("display number formatting", () => {
  it("rounds float noise and normalizes negative zero", () => {
    expect(formatCoordinates([1.0000000000000002, -1.22e-16])).toBe("1, 0");
    expect(formatNumber(-0.0000001)).toBe("0");
  });
  it("keeps declared precision and reports unknown for missing values", () => {
    expect(formatCoordinates([2.54, -1.27])).toBe("2.54, -1.27");
    expect(formatCoordinates(null)).toBe("unknown");
  });
});
