import { describe, expect, it } from "vitest";
import { isNumericText, markNumericCells } from "./numericCells";

describe("numeric cell marking", () => {
  it("accepts numbers with short units and rejects words", () => {
    for (const ok of ["12", "-1.5", "1,200", "3.3 V", "40 mm", "12%", "1e-3"]) expect(isNumericText(ok)).toBe(true);
    for (const no of ["unknown", "", "n/a", "R1", "1, 0", "12 apples"]) expect(isNumericText(no)).toBe(false);
  });

  it("marks numeric columns and headers but not mixed or unknown cells", () => {
    document.body.innerHTML = `<table><thead><tr><th>Qty</th><th>Len</th></tr></thead><tbody>
      <tr><td>2</td><td>40 mm</td></tr><tr><td>10</td><td>unknown</td></tr></tbody></table>`;
    markNumericCells(document.body);
    const cells = Array.from(document.querySelectorAll("td")).map((c) => c.hasAttribute("data-numeric"));
    expect(cells).toEqual([true, true, true, false]);
    const heads = Array.from(document.querySelectorAll("th")).map((c) => c.hasAttribute("data-numeric"));
    expect(heads).toEqual([true, false]);
  });
});
