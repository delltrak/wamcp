import { describe, expect, it } from "vitest";
import { messageTimestampToMilliseconds } from "../src/channels/baileys/message-timestamp.js";

describe("messageTimestampToMilliseconds", () => {
  it("converts seconds from number, bigint, string, and Long-like values", () => {
    expect(messageTimestampToMilliseconds(50, -1)).toBe(50_000);
    expect(messageTimestampToMilliseconds(50n, -1)).toBe(50_000);
    expect(messageTimestampToMilliseconds(" 50 ", -1)).toBe(50_000);
    expect(messageTimestampToMilliseconds({ toNumber: () => 50 }, -1)).toBe(50_000);
    expect(messageTimestampToMilliseconds({ toString: () => "50" }, -1)).toBe(50_000);
  });

  it("preserves millisecond timestamps and returns the fallback for invalid values", () => {
    expect(messageTimestampToMilliseconds(1_700_000_000_000, -1)).toBe(1_700_000_000_000);
    expect(messageTimestampToMilliseconds("1700000000000", -1)).toBe(1_700_000_000_000);
    expect(messageTimestampToMilliseconds(undefined, 123_000)).toBe(123_000);
  });
});
