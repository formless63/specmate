import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useLatestRevisionDefault } from "./useLatestRevisionDefault";

const def = (id: string, numbers: number[]) => ({
  definition_id: id,
  revisions: numbers.map((n) => ({ revision_id: `${id}-r${n}`, number: n })),
});

describe("useLatestRevisionDefault", () => {
  it("selects the latest revision of a newly chosen definition, replacing a leftover revision", () => {
    const onChange = vi.fn();
    const { rerender } = renderHook(
      ({ id, data, value }) => useLatestRevisionDefault(id, data, true, value, onChange),
      { initialProps: { id: "a", data: def("a", [1, 2]), value: "" } },
    );
    expect(onChange).toHaveBeenLastCalledWith("a-r2");
    rerender({ id: "b", data: def("b", [1, 2, 3]), value: "a-r2" });
    expect(onChange).toHaveBeenLastCalledWith("b-r3");
  });

  it("keeps a revision the user already chose for the same definition", () => {
    const onChange = vi.fn();
    renderHook(() => useLatestRevisionDefault("a", def("a", [1, 2]), true, "a-r1", onChange));
    expect(onChange).not.toHaveBeenCalled();
  });
});
