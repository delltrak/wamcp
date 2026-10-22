import type { IncomingMessage, ServerResponse } from "node:http";
import { createHttpRequestHandler } from "../src/server/http-listener.js";
import { describe, expect, it } from "vitest";
import { isDatabaseError } from "../src/server/health.js";

describe("isDatabaseError", () => {
  it("treats Postgres read and connect timeouts as database failures", () => {
    expect(isDatabaseError(new Error("Query read timeout"))).toBe(true);
    expect(isDatabaseError(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(isDatabaseError(new Error("syntax error at or near select"))).toBe(false);
  });
});

it("propagates an async health database failure to the HTTP error handler", async () => {
  const error = new Error("Query read timeout");
  const handle = createHttpRequestHandler({
    routes: { health: "/health", mcp: "/mcp", webhook: "/cloud-webhook" },
    oauth: null,
    authorize: () => true,
    health: async () => { await Promise.resolve(); throw error; },
    mcp: async () => undefined,
    webhook: async () => undefined,
  });
  await expect(handle({ url: "/health", method: "GET" } as IncomingMessage, {} as ServerResponse)).rejects.toBe(error);
});
