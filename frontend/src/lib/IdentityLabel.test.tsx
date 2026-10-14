import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ExactId, IdentityLabel, RevisionLabel } from "./IdentityLabel";
import { revisionOptionLabel, useRevisionTexts } from "./revision-labels";

const ID_A = "0383e70d-2c33-425b-a920-13a09fe4b4b1";
const ID_B = "df977887-0000-4000-8000-000000000002";
const ID_C = "aaaaaaaa-0000-4000-8000-000000000003";
const SRC = "bbbbbbbb-0000-4000-8000-000000000004";

let calls: string[] = [];
beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    const params = new URL(url, "http://x").searchParams;
    return new Response(JSON.stringify({
      labels: params.getAll("revision_ids").map(id => id === ID_A
        ? { revision_id: id, readable: true, definition_id: "d", name: "Shielded 4-core", kind: "wire_stock", number: 2 }
        : { revision_id: id, readable: false }),
      source_labels: params.getAll("source_revision_ids").map(id => ({ revision_id: id, readable: true, bundle_id: "b", name: "Board export", kind: "original", number: 1 })),
    }), { status: 200 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("name, kind and revision number lead; exact IDs stay in a collapsed disclosure", async () => {
  render(<RevisionLabel id={ID_A} role="Stock" sha256={"f".repeat(64)} />);
  expect(await screen.findByText("Shielded 4-core")).toBeTruthy();
  expect(screen.getByText("wire_stock")).toBeTruthy();
  expect(screen.getByText("r2")).toBeTruthy();
  const toggle = screen.getByRole("button", { name: /exact pins/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  // Present for assistive technology and acceptance checks, hidden until expanded.
  expect(screen.getByText(ID_A, { selector: "code" }).closest("[hidden]")).not.toBeNull();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText(ID_A, { selector: "code" }).closest("[hidden]")).toBeNull();
  expect(screen.getByText("f".repeat(64), { selector: "code" })).toBeTruthy();
});

test("a revision the reader cannot read shows no name and keeps the supplied ID evidence", async () => {
  render(<RevisionLabel id={ID_B} />);
  expect(await screen.findByText("Not readable by you")).toBeTruthy();
  expect(screen.queryByText(/r\d/)).toBeNull();
  expect(screen.getByText(ID_B, { selector: "code" })).toBeTruthy();
});

test("labels requested in one render share a single bounded request and resolve source revisions separately", async () => {
  render(<><RevisionLabel id={ID_A} /><RevisionLabel id={ID_B} /><RevisionLabel id={ID_C} /><RevisionLabel id={SRC} kind="source" /></>);
  await screen.findByText("Board export");
  await waitFor(() => expect(screen.getAllByText("Not readable by you")).toHaveLength(2));
  expect(calls).toHaveLength(1);
  const params = new URL(calls[0]!, "http://x").searchParams;
  expect(params.getAll("revision_ids")).toEqual(expect.arrayContaining([ID_A, ID_B, ID_C]));
  expect(params.getAll("source_revision_ids")).toEqual([SRC]);
});

test("a failed lookup is reported as an unavailable name, never as a guessed one", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 })));
  render(<RevisionLabel id={ID_A} />);
  expect(await screen.findByText("Name unavailable")).toBeTruthy();
  expect(screen.getByText(ID_A, { selector: "code" })).toBeTruthy();
});

test("a malformed response is treated as unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ unexpected: true }]), { status: 200 })));
  render(<RevisionLabel id={ID_A} />);
  expect(await screen.findByText("Name unavailable")).toBeTruthy();
});

test("known identity skips the lookup and a missing ID is explicit", () => {
  render(<><RevisionLabel id={ID_A} known={{ name: "Known name", kind: "part", number: 3 }} /><RevisionLabel id={null} role="Stock" /></>);
  expect(screen.getByText("Known name")).toBeTruthy();
  expect(screen.getByText("Not recorded")).toBeTruthy();
  expect(calls).toHaveLength(0);
});

test("copy writes the exact value to the clipboard", () => {
  const writeText = vi.fn();
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<ExactId label="Revision ID" value={ID_A} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy Revision ID" }));
  expect(writeText).toHaveBeenCalledWith(ID_A);
});

test("identity label without a revision shows state words instead of blanks", () => {
  render(<IdentityLabel state="resolving" />);
  expect(screen.getByText("Resolving name…")).toBeTruthy();
});

test("plain-text hook and option label put the name first", async () => {
  function Probe() { const texts = useRevisionTexts([ID_A, ID_B]); return <p>{texts[ID_A]}|{texts[ID_B]}</p>; }
  render(<Probe />);
  expect(await screen.findByText("Shielded 4-core r2|Not readable by you")).toBeTruthy();
  expect(revisionOptionLabel("Shielded 4-core", 2)).toBe("Shielded 4-core · r2");
  expect(revisionOptionLabel(undefined, 2)).toBe("Revision 2");
});
