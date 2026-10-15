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

test("stock without a construction says so instead of drawing a default", () => {
  draw("wire_stock", preview("wire_stock", { gauge: "unknown" }, { source: "draft", revision: null }));
  expect(screen.getByText("construction not recorded")).toBeTruthy();
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

test("connector kinds use the placeholder face with recorded contacts only", () => {
  const box = draw("port", preview("port", { interface: { device_label: "Monitor input", pins: [
    { contact_id: "8", must_not_connect: true }, { contact_id: "20", level: { status: "unknown" } }, { contact_id: "7", level: { status: "known" } }] } }));
  expect([...box.querySelectorAll("[data-contact]")].map((g) => [g.getAttribute("data-contact"), g.getAttribute("data-mark")]))
    .toEqual([["8", "must-not-connect"], ["20", "unknown"], ["7", "signal"]]);
  draw("connector_body", preview("connector_body", { interface: { contacts: [] } }));
  expect(screen.getByText("no contacts recorded")).toBeTruthy();
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
