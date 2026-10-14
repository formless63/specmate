import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { MiddleTruncate, shortenMiddle } from "./MiddleTruncate";

afterEach(cleanup);

test("long hashes and UUIDs are shortened in the middle with the full value on hover", () => {
  const sha = "5b4d".padEnd(60, "9") + "e99e";
  render(<p>Result <MiddleTruncate text={sha} /> and revision <MiddleTruncate text="123e4567-e89b-12d3-a456-426614174000" /> kept, rev-1 as is</p>);
  const short = screen.getByTitle(sha);
  expect(short.textContent).toBe(shortenMiddle(sha));
  expect(short.textContent!.length).toBeLessThan(15);
  expect(screen.getByTitle("123e4567-e89b-12d3-a456-426614174000").textContent).toBe("123e45…4000");
  expect(document.body.textContent).toContain("rev-1 as is");
});
