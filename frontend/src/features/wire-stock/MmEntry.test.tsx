import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test } from "vitest";
import { MmEntry } from "./WireStockPanel";

function Harness({ initial = null }: { initial?: number | null }) {
  const [value, setValue] = useState<number | null>(initial);
  return <><MmEntry label="Width mm" value={value} onChange={setValue} /><output data-testid="draft">{value === null ? "null" : String(value)}</output></>;
}
afterEach(cleanup);
const input = () => screen.getByLabelText("Width mm") as HTMLInputElement;
const draft = () => screen.getByTestId("draft").textContent;

test("a trailing decimal point survives typing and a valid value reaches the draft", () => {
  render(<Harness />);
  fireEvent.change(input(), { target: { value: "1." } });
  expect(input().value).toBe("1.");
  expect(draft()).toBe("1");
  fireEvent.change(input(), { target: { value: "1.5" } });
  expect(input().value).toBe("1.5");
  expect(draft()).toBe("1.5");
});

test("an empty field is unknown, never zero", () => {
  render(<Harness initial={2} />);
  fireEvent.change(input(), { target: { value: "" } });
  expect(draft()).toBe("null");
  expect(input().value).toBe("");
  expect(screen.getByText("Unknown")).toBeTruthy();
});

test("negative and non-numeric entries are shown invalid and do not reach the draft", () => {
  render(<Harness initial={2} />);
  fireEvent.change(input(), { target: { value: "-3" } });
  expect(input().getAttribute("aria-invalid")).toBe("true");
  expect(input().value).toBe("-3");
  expect(draft()).toBe("2");
  fireEvent.change(input(), { target: { value: "abc" } });
  expect(input().getAttribute("aria-invalid")).toBe("true");
  expect(draft()).toBe("2");
  fireEvent.change(input(), { target: { value: "4" } });
  expect(input().getAttribute("aria-invalid")).toBeNull();
  expect(draft()).toBe("4");
});
