import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useEditHistory } from "../../components/editor";
import { CableWorkbench } from "./CableWorkbench";
import { boardEnd, cable, inlineEnd, stock } from "./fixtures";
import { layoutDrawing } from "./model";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("PointerEvent", class extends MouseEvent { pointerId: number; constructor(type: string, options: PointerEventInit = {}) { super(type, options); this.pointerId = options.pointerId ?? 1; } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const stacks = [boardEnd(), inlineEnd()];
function Session() {
  const history = useEditHistory(cable());
  const landing = history.value.assignments.find(a => a.endpoint_id === "b" && a.element_path === "stock.core-1.center");
  return <><button onClick={history.undo} disabled={!history.past.length}>Undo gesture</button><output aria-label="Saved landing">{landing?.terminal_id}</output>
    <CableWorkbench mode="draft" name="Synthetic" cable={history.value} onChange={history.edit} stock={stock()} stacks={stacks} revision={{ value: "draft", sub: "working" }} editor={{ dirty: !!history.past.length, notes: null }} /></>;
}
function mount() { render(<MantineProvider><QueryClientProvider client={new QueryClient()}><Session /></QueryClientProvider></MantineProvider>); }
const handle = () => screen.getByRole("button", { name: "Move Coax 1 center (red) landing at Sink end" });
const svg = () => screen.getByRole("group", { name: /^Cable drawing of Synthetic:/ });
const target = layoutDrawing({ cable: cable(), stock: stock(), stacks }).terminals.get("t:b/inline/r2.1")!;
const pointer = (x: number, y: number) => ({ pointerId: 1, clientX: x, clientY: y, button: 0 });

test("pointer landing is one undoable edit; Escape, cancelled capture and outside drops leave the cable unchanged", () => {
  mount();
  fireEvent.pointerDown(handle(), pointer(0, 0)); fireEvent.pointerMove(svg(), pointer(target.x, target.y));
  expect(document.querySelector(".cwb-drag-preview")).toBeTruthy();
  fireEvent.pointerUp(svg(), pointer(target.x, target.y));
  expect(screen.getByLabelText("Saved landing").textContent).toBe("r2.1");
  fireEvent.click(screen.getByRole("button", { name: "Undo gesture" }));
  expect(screen.getByLabelText("Saved landing").textContent).toBe("1");
  expect((screen.getByRole("button", { name: "Undo gesture" }) as HTMLButtonElement).disabled).toBe(true);
  for (const cancel of [() => fireEvent.keyDown(window, { key: "Escape" }), () => fireEvent.pointerCancel(svg(), pointer(0, 0)), () => fireEvent.lostPointerCapture(svg(), pointer(0, 0))]) {
    fireEvent.pointerDown(handle(), pointer(0, 0)); cancel(); fireEvent.pointerUp(svg(), pointer(target.x, target.y));
    expect(screen.getByLabelText("Saved landing").textContent).toBe("1");
  }
  fireEvent.pointerDown(handle(), pointer(0, 0)); fireEvent.pointerUp(svg(), pointer(-500, -500));
  expect(screen.getByLabelText("Saved landing").textContent).toBe("1");
});

test("keyboard landing handle opens the same searchable target choices and Enter selects an undoable landing", () => {
  mount(); handle().focus(); fireEvent.keyDown(handle(), { key: "Enter" });
  const selector = screen.getByRole("combobox", { name: "End B stock.core-1.center target" });
  fireEvent.focus(selector); fireEvent.change(selector, { target: { value: "R2 · 1" } }); fireEvent.keyDown(selector, { key: "ArrowDown" });
  const list = screen.getByRole("listbox", { name: "End B stock.core-1.center target" });
  expect(within(list).getByRole("option", { name: /R2 · 1/ })).toBeTruthy();
  fireEvent.keyDown(selector, { key: "Enter" });
  expect(screen.getByLabelText("Saved landing").textContent).toBe("r2.1");
  fireEvent.click(screen.getByRole("button", { name: "Undo gesture" }));
  expect(screen.getByLabelText("Saved landing").textContent).toBe("1");
});
