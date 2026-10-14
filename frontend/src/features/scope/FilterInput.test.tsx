import { MantineProvider } from "@mantine/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { FilterInput } from "./LibraryView";

afterEach(() => { cleanup(); vi.useRealTimers(); });

test("typing in the library filter reports one debounced query, not one per keystroke", () => {
  vi.useFakeTimers();
  const onQuery = vi.fn();
  render(<MantineProvider><FilterInput onQuery={onQuery} delay={250} /></MantineProvider>);
  const input = screen.getByLabelText("Filter records") as HTMLInputElement;
  onQuery.mockClear();
  for (const value of ["p", "pa", "pat", " pat "]) { fireEvent.change(input, { target: { value } }); act(() => { vi.advanceTimersByTime(50); }); }
  expect(input.value).toBe(" pat ");
  expect(onQuery).not.toHaveBeenCalledWith("pat");
  act(() => { vi.advanceTimersByTime(300); });
  expect(onQuery.mock.calls.map((call) => call[0])).toEqual(["pat"]);
});
