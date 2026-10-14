import { afterEach, expect, test, vi } from "vitest";
import { forgetLastProject, readLastProject, writeLastProject } from "./lastProject";

afterEach(() => { vi.restoreAllMocks(); window.localStorage.clear(); });

test("the remembered project is keyed by user id and never shared between users", () => {
  writeLastProject("7", "project-a");
  writeLastProject("8", "project-b");
  expect(readLastProject("7")).toBe("project-a");
  expect(readLastProject("8")).toBe("project-b");
  expect(readLastProject("9")).toBeNull();
  forgetLastProject("7");
  expect(readLastProject("7")).toBeNull();
  expect(readLastProject("8")).toBe("project-b");
});

test("blocked or throwing storage is tolerated and reads as not remembered", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("blocked"); });
  expect(() => writeLastProject("7", "project-a")).not.toThrow();
  expect(() => forgetLastProject("7")).not.toThrow();
  expect(readLastProject("7")).toBeNull();
});

test("an implausibly long stored value is ignored", () => {
  window.localStorage.setItem("specmate.lastProject.7", "x".repeat(500));
  expect(readLastProject("7")).toBeNull();
});
