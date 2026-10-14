import { describe, expect, it } from "vitest";
import { apiErrorMessage, fieldErrorMap } from "./api-errors";

const body = { error: { code: "validation_failed", message: "Invalid payload.", details: { errors: [
  { loc: ["cable", "stock_revision_id"], type: "missing", msg: "Field required" },
  { loc: ["cable", "endpoints", 1, "body_revision_id"], type: "string_too_short", msg: "String should have at least 1 character" },
] } } };

describe("api errors", () => {
  it("lists field issues after the backend message", () => {
    expect(apiErrorMessage(body, "x")).toBe("Invalid payload. stock revision: Field required; endpoints #2 body revision: String should have at least 1 character");
  });
  it("maps issues by dotted path", () => {
    expect(fieldErrorMap(body)["cable.endpoints.1.body_revision_id"]).toMatch(/at least 1/);
  });
  it("falls back without details", () => {
    expect(apiErrorMessage({}, "Failed (500)")).toBe("Failed (500)");
    expect(apiErrorMessage({ error: { message: "Denied." } }, "x")).toBe("Denied.");
  });
});
