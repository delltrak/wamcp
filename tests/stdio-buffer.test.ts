import { describe, it, expect } from "vitest";
import { ReadBuffer, STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { MAX_BASE64_MEDIA_BYTES, STDIO_MAX_BUFFER_BYTES } from "../src/constants.js";

// MCP SDK 1.30.0 added a 10 MB default read-buffer ceiling to StdioServerTransport.
// Overflowing it makes the transport close(), dropping the whole MCP session rather
// than failing one request — so the ceiling must cover the largest payload the tools
// are willing to accept.
describe("stdio read-buffer ceiling", () => {
  it("the SDK default is smaller than our largest accepted media payload", () => {
    // Guards the premise: if the SDK ever raises its default past our needs, this
    // test failing is the signal to drop our override.
    expect(STDIO_DEFAULT_MAX_BUFFER_SIZE).toBeLessThan(MAX_BASE64_MEDIA_BYTES);
  });

  it("covers a max-size media payload once base64 inflation is applied", () => {
    const base64Chars = Math.ceil((MAX_BASE64_MEDIA_BYTES * 4) / 3);
    expect(STDIO_MAX_BUFFER_BYTES).toBeGreaterThan(base64Chars);
  });

  it("a payload that would kill the default buffer is accepted at our ceiling", () => {
    const oversized = Buffer.alloc(STDIO_DEFAULT_MAX_BUFFER_SIZE + 1, "a");

    expect(() => new ReadBuffer().append(oversized)).toThrow(/exceeded maximum size/);
    expect(() =>
      new ReadBuffer({ maxBufferSize: STDIO_MAX_BUFFER_BYTES }).append(oversized),
    ).not.toThrow();
  });
});
