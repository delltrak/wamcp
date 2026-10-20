import { describe, expect, it } from "vitest";
import { isDatabaseError } from "../src/server/health.js";

describe("isDatabaseError", () => {
  it("treats Postgres read and connect timeouts as database failures", () => {
    expect(isDatabaseError(new Error("Query read timeout"))).toBe(true);
    expect(isDatabaseError(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(isDatabaseError(new Error("syntax error at or near select"))).toBe(false);
  });
});
