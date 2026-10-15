import { expect, test } from "vitest";
import { newestFirst } from "./revision-labels";

test("revision pickers list the newest revision first without reordering the source", () => {
  const source = [{ number: 1 }, { number: 3 }, { number: 2 }];
  expect(newestFirst(source).map(r => r.number)).toEqual([3, 2, 1]);
  expect(source.map(r => r.number)).toEqual([1, 3, 2]);
  expect(newestFirst(undefined)).toEqual([]);
});
