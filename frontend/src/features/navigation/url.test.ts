import { expect, test } from "vitest";
import { formatLocation, HOME, parseLocation, sameTarget, targetKey } from "./url";

test("the root is the Project area at Library scope and formats back to /", () => {
  expect(parseLocation("/", "")).toEqual(HOME);
  expect(formatLocation(HOME)).toBe("/");
});

test("items are addressed in the workspace with an optional revision, path and project context", () => {
  const location = parseLocation("/design/b1@3/~/J1/pin%203", "?lens=pcb&project=p1");
  expect(location).toEqual({ area: "design", lens: "pcb", project: "p1", malformed: false,
    probe: { object: "b1", rev: 3, path: ["J1", "pin 3"] } });
  expect(formatLocation(location)).toBe("/design/b1@3/~/J1/pin%203?lens=pcb&project=p1");
  expect(parseLocation("/library/d1", "").probe).toEqual({ object: "d1", rev: null, path: [] });
  expect(formatLocation({ ...HOME, area: "library", lens: "library-home", probe: { object: "d1", rev: null, path: [] } })).toBe("/library/d1");
  expect(formatLocation({ ...HOME, area: "library", lens: "identity", probe: { object: "d1", rev: null, path: [] } })).toBe("/library/d1?lens=identity");
});

test("the area default lens is left out and a lens from another area selects its own area", () => {
  expect(formatLocation({ ...HOME, area: "design", lens: "assemblies" })).toBe("/design");
  expect(parseLocation("/library", "?lens=pcb")).toMatchObject({ area: "design", lens: "pcb" });
  expect(parseLocation("/nowhere", "?lens=unknown")).toMatchObject({ area: "project", lens: "overview", malformed: false });
});

test("selections that are not workspace addresses are malformed, never guessed", () => {
  for (const path of ["/design/b1@0", "/design/b1@x", "/design/b1/J1", "/design/%E0%A4%A", "/design/../etc"]) {
    const location = parseLocation(path, "");
    expect(location.probe, path).toBeNull();
    expect(location.malformed, path).toBe(true);
  }
  expect(parseLocation("/", "?project=%3Cscript%3E")).toMatchObject({ project: null, malformed: true });
});

test("targets compare by object, revision and path", () => {
  const a = { object: "x", rev: 1, path: ["J1"] };
  expect(sameTarget(a, { ...a, path: ["J1"] })).toBe(true);
  expect(sameTarget(a, { ...a, rev: null })).toBe(false);
  expect(sameTarget(null, null)).toBe(true);
  expect(targetKey(a)).not.toBe(targetKey({ ...a, path: ["J", "1"] }));
});
