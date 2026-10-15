import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RecordPage, RecordSections } from "./RecordPage";
beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("record drawing is primary and secondary inspector work is lazy", async () => {
  const details = vi.fn(() => <input aria-label="Retained detail" defaultValue="buffer" />);
  render(<MantineProvider env="test"><RecordPage active identity={{ name: "Synthetic stock", kind: "wire_stock" }} state={{ kind: "revision", id: "r1", number: 1 }} view="model" onView={vi.fn()} views={[{ id: "model", label: "3D", content: <div role="img" aria-label="Stock model" /> }]} inspector={[{ id: "construction", label: "Construction", content: () => <p>Construction properties</p> }, { id: "record", label: "Record", content: details }]} /></MantineProvider>);
  expect(screen.getByRole("img", { name: "Stock model" })).toBeTruthy();
  expect(screen.getByText("Frozen r1")).toBeTruthy();
  expect(details).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("tab", { name: /^Record$/ }));
  const input = await screen.findByRole("textbox", { name: "Retained detail" });
  fireEvent.change(input, { target: { value: "Local retained" } });
  fireEvent.click(screen.getByRole("tab", { name: /^Construction$/ }));
  fireEvent.click(screen.getByRole("tab", { name: /^Record$/ }));
  expect((screen.getByRole("textbox", { name: "Retained detail" }) as HTMLInputElement).value).toBe("Local retained");
});

test("record sections disclose independently without mounting all records", async () => {
  const source = vi.fn(() => <p>Exact source record</p>);
  render(<RecordSections sections={[{ id: "source", label: "Sources", content: source }]} />);
  expect(source).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Sources"));
  expect(await screen.findByText("Exact source record")).toBeTruthy();
});

test("compact inspector portals close while a retained record is inactive", async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('max-width'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  const tree = (active: boolean) => <MantineProvider env="test"><RecordPage active={active} identity={{ name: "Phone stock", kind: "wire_stock" }} state={{ kind: "new" }} views={[{ id: "section", label: "Section", content: <p>Central drawing</p> }]} view="section" onView={vi.fn()} inspector={[{ id: "facts", label: "Facts", content: () => <p>Phone facts</p> }]} /></MantineProvider>;
  const view = render(tree(true)); const trigger = await screen.findByRole('button', { name: 'Inspector · Facts' }); expect(trigger.closest('.record-head')).not.toBeNull(); fireEvent.click(trigger); expect(await screen.findByRole('dialog')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Close record inspector' })); expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(trigger); expect(await screen.findByRole('dialog')).toBeTruthy();
  view.rerender(tree(false)); expect(screen.queryByRole('dialog')).toBeNull();
  const overlay = document.querySelector('.mantine-Drawer-overlay'); if (overlay) expect(getComputedStyle(overlay).display).toBe('none');
});
