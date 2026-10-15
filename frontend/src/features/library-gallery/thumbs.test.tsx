import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { shieldedPair } from "../cable-views/fixtures";
import type { AttentionItem, LibraryPreview } from "./api";
import { cardStatus } from "./ItemCard";
import { countUnknown, ItemThumb } from "./thumbs";

afterEach(cleanup);

const preview = (kind: string, content: Record<string, unknown> | null, extra: Partial<LibraryPreview> = {}): LibraryPreview =>
  ({ record_id: "d1", kind, source: "revision", revision: 1, content, truncated: false, stock: null, ...extra });

function draw(kind: string, value: LibraryPreview | null | undefined) {
  return render(<MantineProvider><ItemThumb kind={kind} label="Synthetic item" preview={value} recordId="d1" /></MantineProvider>).container;
}

test("wire stock draws its recorded cross-section without callouts", () => {
  const box = draw("wire_stock", preview("wire_stock", { stock: shieldedPair() }));
  expect(box.querySelectorAll("[data-element]").length).toBeGreaterThan(3);
  expect(box.querySelector("[data-callout]")).toBeNull();
  expect(screen.getByRole("img", { name: "Synthetic item (wire stock)" })).toBeTruthy();
});

test("stock without a construction or dimensions says so instead of drawing a default", () => {
  draw("wire_stock", preview("wire_stock", { gauge: "unknown" }, { source: "draft", revision: null }));
  expect(screen.getByText("construction not recorded")).toBeTruthy();
  const stock = shieldedPair();
  const strip = (element: Record<string, unknown>): Record<string, unknown> => ({ ...element, outer_diameter_mm: null, inner_diameter_mm: null,
    ...(Array.isArray(element.children) ? { children: element.children.map((child) => strip(child as Record<string, unknown>)) } : {}) });
  draw("wire_stock", preview("wire_stock", { stock: { ...stock, structure: strip(stock.structure as unknown as Record<string, unknown>) } }));
  expect(screen.getByText(/elements, dimensions not recorded/)).toBeTruthy();
});

test("a cable sketch fans out its stock's conductors in their recorded colors", () => {
  const stock = shieldedPair();
  const box = draw("cable", preview("cable", { cable: { endpoints: [{ local_id: "a", label: "Console" }, { local_id: "b", label: null }] } }, { stock: stock as never }));
  const wires = [...box.querySelectorAll("path.lg-wire")];
  expect(wires.length).toBe(4);
  expect(screen.getByText("Console")).toBeTruthy();
  expect(screen.getByText("End B")).toBeTruthy();
  expect(screen.queryByText("stock not chosen")).toBeNull();
});

test("a cable without chosen stock is drawn as unknown, never with a default jacket", () => {
  const box = draw("cable", preview("cable", { cable: { endpoints: [] } }));
  expect(screen.getByText("stock not chosen")).toBeTruthy();
  expect(box.querySelector("path.lg-jacket")).toBeNull();
  expect(screen.getAllByText("end unknown")).toHaveLength(2);
});

test("a board shows its terminal groups and declared paths; the outline is not invented", () => {
  const terminals = ["a", "b"].flatMap((group) => [1, 2].map((n) => ({ terminal_id: `${group}${n}`, group })));
  const box = draw("board", preview("board", { interface: { terminals, paths: [
    { from_terminal: "a1", to_terminal: "b1", via: "copper" }, { from_terminal: "a2", to_terminal: "b2", via: "component" }] } }));
  expect(box.querySelectorAll("rect.lg-pad")).toHaveLength(4);
  expect(box.querySelectorAll("path.lg-trace")).toHaveLength(2);
  expect(box.querySelectorAll("rect.lg-component")).toHaveLength(1);
  expect(screen.getByText("outline not recorded")).toBeTruthy();
});

test("an end assembly is drawn as its layer stack with the join count", () => {
  const box = draw("end_assembly", preview("end_assembly", { interface: { stack: { layers: [
    { kind: "inline", parts: [{ component: { reference: "R1" } }] }, { kind: "connector" }, { kind: "shell" }], joins: [{}, {}] } } }));
  expect([...box.querySelectorAll("[data-layer]")].map((g) => g.getAttribute("data-layer"))).toEqual(["inline", "connector", "shell"]);
  expect(screen.getByText("R1")).toBeTruthy();
  expect(screen.getByText("3 layers · 2 joins")).toBeTruthy();
});

test("intent rows with open questions are drawn dashed to every offered contact", () => {
  const box = draw("cable_intent", preview("cable_intent", { interface: { rows: [
    { row_id: "r1", to_contact_ids: ["7"], conductor: { kind: "coax" }, question: null },
    { row_id: "r2", to_contact_ids: [], conductor: { kind: "unknown" }, question: { options: [{ contact_id: "5" }, { contact_id: "17" }] } }] } }));
  expect(box.querySelectorAll("path.lg-intent-line")).toHaveLength(1);
  expect(box.querySelectorAll("[data-question] path.lg-intent-question")).toHaveLength(2);
});

test("signal chips hatch unknown levels", () => {
  draw("signal_set", preview("signal_set", { interface: { signals: [
    { key: "red", name: "Red video", level: { status: "known" } }, { key: "sync", name: "Sync", level: { status: "unknown" } }] } }));
  expect(screen.getByText("Sync").getAttribute("data-unknown")).toBe("true");
  expect(screen.getByText("Red video").getAttribute("data-unknown")).toBeNull();
});

test("connector bodies, pinouts and ports draw their real face; pins colored by signal type", () => {
  const contacts = [1, 2, 3, 4, 5].map((n) => ({ contact_id: String(n), label: String(n), physical_role: "contact" }));
  const body = { kind: "connector_body", family: "5-pin DIN 180", geometry_key: "din-5-180", mating_role: "receptacle", contacts };
  let box = draw("connector_body", preview("connector_body", { interface: body }));
  expect(box.querySelector("svg[data-geometry]")?.getAttribute("data-geometry")).toBe("din-5-180-female");
  cleanup();
  const ref = (key: string) => ({ electrical: { signal_ref: { key, signal_set_revision_id: "s1" } } });
  const pinout = { kind: "pinout", body_revision_id: "b1", assignments: [{ contact_id: "1", ...ref("red") }, { contact_id: "2", ...ref("gnd") }] };
  box = draw("pinout", preview("pinout", { interface: pinout }, { body, signal_types: { "s1/red": "analog_video", "s1/gnd": "ground_return" } }));
  const state = (id: string) => box.querySelector(`[data-pin="${id}"]`)?.getAttribute("data-state");
  expect(state("1")).toBe("none");
  expect(state("3")).toBe("unknown");
  expect(box.querySelector('[data-pin="1"] title')?.textContent).toContain("analog video");
  cleanup();
  box = draw("port", preview("port", { interface: { kind: "port", pins: [{ contact_id: "4", must_not_connect: true }] } },
    { body, pinout, signal_types: { "s1/red": "analog_video" } }));
  expect(box.querySelector('[data-pin="4"]')?.getAttribute("data-state")).toBe("hazard");
  cleanup();
  draw("pinout", preview("pinout", { interface: pinout }));
  expect(screen.getByText("body face unknown")).toBeTruthy();
});

test("oversized and unreadable previews say so", () => {
  draw("cable", preview("cable", null, { truncated: true }));
  expect(screen.getByText("too large to preview")).toBeTruthy();
  draw("cable", null);
  expect(screen.getByText("preview unavailable")).toBeTruthy();
});

test("card status: recorded attention first, then content; never a generic OK", () => {
  const failing: AttentionItem = { record_id: "d1", kind: "cable", label: "x", created_at: "", latest_revision: 1, latest_revision_id: "r", changed_at: null,
    status: "fail", reasons: [{ kind: "failing_check", count: 2, detail: "2 rows fail" }, { kind: "unknown_check", count: 3, detail: "3 rows unknown" }] };
  expect(cardStatus(undefined, failing)).toEqual({ led: "failed", words: "2 rows fail · 3 rows unknown" });
  expect(cardStatus(undefined)).toEqual({ led: "off", words: "reading" });
  expect(cardStatus(preview("cable_intent", { interface: { rows: [{ question: {} }, { question: null }] } }))).toEqual({ led: "review", words: "1 open question" });
  expect(cardStatus(preview("port", { interface: { review: "reviewed", pins: [{ level: { status: "unknown" } }] } }))).toEqual({ led: "unknown", words: "1 unknown" });
  expect(cardStatus(preview("cable", { cable: { review: "reviewed" } }))).toEqual({ led: "info", words: "reviewed" });
  expect(cardStatus(preview("part", {}))).toEqual({ led: "not-evaluated", words: "no review recorded" });
  expect(countUnknown({ a: [{ status: "unknown" }, { b: { status: "unknown" } }], status: "known" })).toBe(2);
});
