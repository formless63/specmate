import { MantineProvider, Select } from "@mantine/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { schematicBench } from "./schematicBench";

afterEach(cleanup);

function Field({ clearable }: { clearable?: boolean }) {
  const [value, setValue] = useState<string | null>("a");
  return <Select label="Pick" clearable={clearable} value={value} onChange={setValue} data={[{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }]} />;
}

test("re-choosing the selected option keeps it selected", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  render(<MantineProvider theme={schematicBench}><Field /></MantineProvider>);
  const input = screen.getByRole("combobox", { name: "Pick" }) as HTMLInputElement;
  expect(input.value).toBe("Alpha");
  fireEvent.click(input);
  fireEvent.click(await within(screen.getByRole("listbox", { hidden: true })).findByText("Alpha"));
  expect(input.value).toBe("Alpha");
});
