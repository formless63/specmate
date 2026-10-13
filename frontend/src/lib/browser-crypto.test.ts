import { createHash, webcrypto } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { randomUUID } from "./random-id";
import { sha256Hex } from "./sha256";

afterEach(() => vi.unstubAllGlobals());

test("HTTP-origin UUID fallback uses cryptographic entropy with UUID v4 identity bits", () => {
  const getRandomValues = vi.fn((bytes: Uint8Array) => {
    bytes.set(Array.from({ length: 16 }, (_, index) => index));
    return bytes;
  });
  vi.stubGlobal("crypto", { getRandomValues });
  expect(randomUUID()).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  expect(getRandomValues).toHaveBeenCalledTimes(1);
});

test("native UUID generation is retained when available", () => {
  const native = vi.fn(() => "b0f0a481-6525-43e0-85f0-28bd32c50586");
  vi.stubGlobal("crypto", { randomUUID: native });
  expect(randomUUID()).toBe("b0f0a481-6525-43e0-85f0-28bd32c50586");
  expect(native).toHaveBeenCalledTimes(1);
});

test("missing cryptographic entropy fails explicitly instead of using weak random values", () => {
  vi.stubGlobal("crypto", {});
  expect(() => randomUUID()).toThrow("Cryptographic randomness is unavailable");
});

test.each([0, 3, 55, 56, 63, 64, 65, 1024])("HTTP-origin SHA-256 matches an independent oracle for %i bytes", async (length) => {
  const content = Uint8Array.from({ length }, (_, index) => index % 251);
  vi.stubGlobal("crypto", { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
  expect(await sha256Hex(content.buffer)).toBe(createHash("sha256").update(content).digest("hex"));
});

test("native and HTTP-origin source checksums agree on non-ASCII bytes", async () => {
  const content = new TextEncoder().encode("Original synthetic source: Ω\n");
  vi.stubGlobal("crypto", webcrypto);
  const native = await sha256Hex(content.buffer);
  vi.stubGlobal("crypto", { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
  expect(await sha256Hex(content.buffer)).toBe(native);
  expect(native).toBe(createHash("sha256").update(content).digest("hex"));
});
