import { expect, test } from "vitest";
import { AREAS } from "../shell/areas";
import { formatLocation, HOME, parseLocation, sameTarget, targetKey } from "./url";

test("the root redirects to Designs", () => {
  expect(parseLocation("/", "")).toEqual(HOME);
  expect(formatLocation(HOME)).toBe("/designs");
});

test("old exact links keep revision, path and project context under their new home", () => {
  const location = parseLocation("/design/b1@3/~/J1/pin%203", "?lens=pcb&project=p1");
  expect(location).toEqual({ area: "library", lens: "pcb", project: "p1", malformed: false,
    probe: { object: "b1", rev: 3, path: ["J1", "pin 3"] } });
  expect(formatLocation(location)).toBe("/library/boards/b1@3/~/J1/pin%203?project=p1");
  expect(parseLocation("/library/parts/d1@2/~/x", "").probe).toEqual({ object: "d1", rev: 2, path: ["x"] });
});

const redirects: [string, string, string][] = [
  ["project", "overview", "/projects"], ["project", "knowledge", "/projects/notes"],
  ["project", "access", "/settings/people"], ["project", "integrations", "/extensions/integrations"],
  ["project", "preferences", "/settings/preferences"], ["project", "agent-capabilities", "/extensions/agents"],
  ["project", "agent-runs", "/jobs/agent-runs"], ["project", "diagnostics", "/settings/system"],
  ["library", "identity", "/library/parts"], ["library", "wire-stock", "/library/wire-stocks"],
  ["library", "catalog-packs", "/extensions/packs"], ["library", "signals", "/library/vocabulary"],
  ["library", "conventions", "/library/vocabulary/conventions"], ["library", "workshop-profiles", "/library/vocabulary/workshop-profiles"],
  ["library", "ports", "/library/connectors?tool=ports"], ["library", "intents", "/designs/new?kind=cable&start=ports"],
  ["design", "cables", "/designs"], ["design", "harnesses", "/designs"],
  ["design", "assemblies", "/designs"], ["design", "interfaces", "/library/connectors"],
  ["design", "pcb", "/library/boards"], ["sources", "builds", "/jobs/builds"],
  ["sources", "agent-runs", "/jobs/agent-runs"], ["sources", "runner", "/jobs/runner"],
  ["make", "bom", "/make/procurement"], ["make", "material-accounting", "/make/material"],
  ["make", "printing", "/make/printing"], ["inventory", "inventory", "/make/inventory"],
  ["inventory", "physical-units", "/make/units"], ["evidence", "evidence-kinds", "/library/vocabulary/evidence-kinds"],
  ["evidence", "releases", "/products/releases"],
];
test.each(redirects)("/%s?lens=%s redirects to %s", (area, lens, expected) => {
  expect(formatLocation(parseLocation(`/${area}`, `?lens=${lens}`))).toBe(expected);
});

test("every existing tool has a stable reachable canonical home", () => {
  for (const area of AREAS) for (const tool of area.tools) {
    const location = { ...HOME, area: area.id, lens: tool.id };
    const expected = ["copper", "passive-passages", "pcb-disagreement"].includes(tool.id) ? "pcb"
      : ["cables", "preparation-documents", "cable-test-intent", "selected-packages", "export-packages"].includes(tool.id) ? "designs" : tool.id;
    const [path, query] = formatLocation(location).split("?");
    expect(parseLocation(path!, query ? `?${query}` : "").lens, tool.id).toBe(expected);
  }
});

test("design record URLs are kind-neutral; exact pins and facets round trip", () => {
  const location = parseLocation("/designs/c1@2/~/ends/A", "?project=p1&q=bench&kind=cable&status=unknown&from=port-a&to=port-b&stock=s1&board=b1&layout=gallery&view=documents");
  expect(location.probe).toEqual({ object: "c1", rev: 2, path: ["ends", "A"] });
  expect(location.filters).toMatchObject({ q: "bench", kind: "cable", status: "unknown", layout: "gallery", view: "documents" });
  const href = formatLocation(location);
  expect(parseLocation(href.split("?")[0]!, `?${href.split("?")[1]}`)).toEqual(location);
});

test("project pages and notes preserve context separately from record selection", () => {
  expect(formatLocation(parseLocation("/project", "?lens=overview&project=p1"))).toBe("/projects/p1");
  expect(formatLocation(parseLocation("/project", "?lens=knowledge&project=p1"))).toBe("/projects/p1/notes");
  expect(parseLocation("/projects/p1/notes", "")).toMatchObject({ lens: "knowledge", project: "p1", probe: null });
});

test("retired cable picker links return to Designs while exact record links remain", () => {
  expect(formatLocation(parseLocation("/designs", "?tool=cables"))).toBe("/designs");
  expect(parseLocation("/designs/c1@2", "?tool=cables")).toMatchObject({ lens: "cables", probe: { object: "c1", rev: 2, path: [] } });
});

test("selections that are not workspace addresses are malformed, never guessed", () => {
  for (const path of ["/design/b1@0", "/design/b1@x", "/design/b1/J1", "/design/%E0%A4%A", "/design/../etc"]) {
    expect(parseLocation(path, "").malformed, path).toBe(true);
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


test.each([
  ["inventory", "inventory", "/make/inventory"],
  ["inventory", "physical-units", "/make/units"],
  ["make", "material-accounting", "/make/material"],
  ["make", "bom", "/make/procurement"],
  ["make", "printing", "/make/printing"],
])("old Make /%s lens %s preserves exact target under %s", (area, lens, home) => {
  const location = parseLocation(`/${area}/record-a@2/~/left/end%20A`, `?lens=${lens}`);
  expect(location.probe).toEqual({ object: "record-a", rev: 2, path: ["left", "end A"] });
  expect(formatLocation(location)).toBe(`${home}/record-a@2/~/left/end%20A`);
});

test.each([
  ["settings-documents", "/settings/documents"], ["settings-engineering", "/settings/engineering"],
  ["part-numbering", "/settings/numbering"], ["validation-rules", "/settings/rules"], ["webhooks", "/settings/webhooks"],
])("Settings %s has canonical home %s", (lens, home) => {
  expect(formatLocation({ ...HOME, area: "settings", lens })).toBe(home);
  expect(parseLocation(home, "").lens).toBe(lens);
});

test.each(["preparation-documents", "cable-test-intent", "selected-packages", "export-packages"])("retired %s picker routes to Designs while exact historical identity remains kind-aware", tool => {
  expect(formatLocation(parseLocation("/make", `?lens=${tool}`))).toBe("/designs");
  expect(parseLocation("/make/record@2/~/opaque/end%20A", `?lens=${tool}&project=p1`)).toMatchObject({ lens: tool, project: "p1", probe: { object: "record", rev: 2, path: ["opaque", "end A"] } });
});


test("History source, actor, dates and kind survive a canonical URL reload", () => {
  const url = "/history?kind=pinout&actor=7&from=2026-01-01&to=2026-01-31&history_source=current_drafts";
  const parsed = parseLocation("/history", url.slice(url.indexOf("?")));
  expect(parsed.filters).toEqual({ kind: "pinout", actor: "7", from: "2026-01-01", to: "2026-01-31", history_source: "current_drafts" });
  const canonical = formatLocation(parsed); expect(parseLocation("/history", canonical.slice(canonical.indexOf("?")))).toEqual(parsed);
});


test.each([['copper', 'more'], ['passive-passages', 'more'], ['pcb-disagreement', 'source-review']])('retired %s picker opens Boards while exact unknown-context IDs stay typed', (tool, section) => {
  expect(formatLocation(parseLocation('/design', `?lens=${tool}`))).toBe(`/library/boards?section=${section}`);
  expect(parseLocation('/design/opaque@2/~/J1/3', `?lens=${tool}`)).toMatchObject({ lens: tool, probe: { object: 'opaque', rev: 2, path: ['J1', '3'] } });
});
test('board inspector section and exact intake survive canonical reload', () => {
  expect(formatLocation(parseLocation('/library/boards/b1@2', '?section=more'))).toBe('/library/boards/b1@2?section=more');
  expect(formatLocation(parseLocation('/library/boards', '?view=intake&intake=source-intake'))).toBe('/library/boards?view=intake&intake=source-intake');
});

test("new chooser is internal and exact Recipe record links keep their pins and paths", () => {
  expect(parseLocation("/designs/new", "").lens).toBe("new-design");
  expect(formatLocation({ ...HOME, lens: "new-design" })).toBe("/designs/new");
  expect(AREAS.flatMap(area => area.tools).map(tool => tool.id)).not.toContain("new-design");
  expect(AREAS.flatMap(area => area.tools).map(tool => tool.id)).not.toContain("intents");
  const legacy = parseLocation("/design/i1@4/~/end_a/contacts/1", "?lens=intents");
  expect(legacy.probe).toEqual({ object: "i1", rev: 4, path: ["end_a", "contacts", "1"] });
  expect(formatLocation(legacy)).toBe("/designs/recipes/i1@4/~/end_a/contacts/1");
  expect(parseLocation("/designs/recipes/i1@4/~/end_a/contacts/1", "")).toEqual(legacy);
  expect(parseLocation("/designs/new", "?kind=cable&start=ports").filters).toEqual({kind: "cable", start: "ports"});
});
