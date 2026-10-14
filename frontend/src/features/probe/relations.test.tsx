import { cleanup, render, screen } from "@testing-library/react";
import { useMemo } from "react";
import { afterEach, expect, test } from "vitest";
import type { ProbeTarget } from "../navigation/url";
import { ProbeProvider, useProbeMark, useRelationContributor } from "./ProbeProvider";
import { RelationRegistry, type RelationContributor } from "./relations";

afterEach(cleanup);

const t = (object: string, rev: number | null = null, path: string[] = []): ProbeTarget => ({ object, rev, path });

test("built-in containment relates a path to its ancestors and an exact revision to its item", () => {
  const registry = new RelationRegistry();
  expect(registry.related(t("board", 2, ["J1", "3"])).map((item) => [item.path.join("/"), item.rev, item.relation])).toEqual([
    ["J1", 2, "contains"], ["", 2, "contains"], ["", null, "same item"],
  ]);
  expect(registry.related(t("board"))).toEqual([]);
});

test("contributors are keyed: re-registering replaces, removal is idempotent and the probe itself is never related", () => {
  const registry = new RelationRegistry([]);
  const first: RelationContributor = { id: "pcb", related: () => [{ ...t("population"), relation: "populates" }] };
  const second: RelationContributor = { id: "pcb", related: (probe) => [{ ...t("firmware"), relation: "runs on" }, { ...probe, relation: "self" }] };
  const removeFirst = registry.register(first);
  expect(registry.related(t("board")).map((item) => item.object)).toEqual(["population"]);
  const removeSecond = registry.register(second);
  removeFirst();
  expect(registry.related(t("board")).map((item) => item.object)).toEqual(["firmware"]);
  const version = registry.getVersion();
  removeSecond();
  expect(registry.getVersion()).toBe(version + 1);
  expect(registry.related(t("board"))).toEqual([]);
});

function Contributor() {
  const contributor = useMemo<RelationContributor>(() => ({ id: "test-board", related: (probe) => probe.object === "board" ? [{ ...t("population"), relation: "populates" }] : [] }), []);
  useRelationContributor(contributor);
  return null;
}

function Mark({ target, match = "exact" }: { target: ProbeTarget; match?: "exact" | "object" }) {
  return <span data-testid={target.object}>{useProbeMark(target, match) ?? "none"}</span>;
}

test("views mark the probe as selected and contributed relations as related while the contributor is mounted", () => {
  const view = (withContributor: boolean) => <ProbeProvider probe={t("board", 1)} onProbe={() => {}}>
    {withContributor && <Contributor />}
    <Mark target={t("board")} match="object" /><Mark target={t("population")} /><Mark target={t("other")} />
  </ProbeProvider>;
  const { rerender } = render(view(true));
  expect(screen.getByTestId("board").textContent).toBe("selected");
  expect(screen.getByTestId("population").textContent).toBe("related");
  expect(screen.getByTestId("other").textContent).toBe("none");
  rerender(view(false));
  expect(screen.getByTestId("population").textContent).toBe("none");
});
