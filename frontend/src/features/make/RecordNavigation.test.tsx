import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { RecordNavigation } from "./RecordNavigation";

afterEach(cleanup);
test("version navigation collapses around the selected identity and retains its controls", () => {
  const { rerender } = render(<MantineProvider><RecordNavigation name="BOM plan" selected={null}><input aria-label="Exact version" defaultValue="r1" /></RecordNavigation></MantineProvider>);
  expect(document.querySelector("details")?.open).toBe(true);
  rerender(<MantineProvider><RecordNavigation name="Workshop plan" selected="plan"><input aria-label="Exact version" defaultValue="r1" /></RecordNavigation></MantineProvider>);
  expect(document.querySelector("details")?.open).toBe(false);
  expect(screen.getByText("Workshop plan", { exact: true })).toBeTruthy();
  const summary = screen.getByText("Choose record or version · Workshop plan");
  fireEvent.click(summary);
  expect(document.querySelector("details")?.open).toBe(true);
  fireEvent.change(screen.getByLabelText("Exact version"), { target: { value: "r3" } });
  fireEvent.click(summary); fireEvent.click(summary);
  expect((screen.getByLabelText("Exact version") as HTMLInputElement).value).toBe("r3");
});
