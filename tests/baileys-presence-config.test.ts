import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  makeWASocket: vi.fn(),
  makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
  useSqliteAuthState: vi.fn(async () => ({
    state: { creds: {}, keys: {} },
    saveCreds: vi.fn(async () => {}),
  })),
  getWaVersion: vi.fn(async () => ({ version: [2, 3000, 0] as [number, number, number] })),
}));

vi.mock("@whiskeysockets/baileys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@whiskeysockets/baileys")>();
  return {
    ...actual,
    default: mocks.makeWASocket,
    makeCacheableSignalKeyStore: mocks.makeCacheableSignalKeyStore,
  };
});

vi.mock("../src/channels/baileys/baileys.auth.js", () => ({
  useSqliteAuthState: mocks.useSqliteAuthState,
  clearAuthState: vi.fn(),
}));

vi.mock("../src/channels/baileys/baileys.version.js", () => ({
  getWaVersion: mocks.getWaVersion,
}));

import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";

describe("Baileys markOnlineOnConnect configuration", () => {
  let socket: {
    ev: { on: ReturnType<typeof vi.fn>; process: ReturnType<typeof vi.fn> };
    end: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    socket = {
      ev: { on: vi.fn(), process: vi.fn() },
      end: vi.fn(),
    };
    mocks.makeWASocket.mockReturnValue(socket);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to false when unset", async () => {
    vi.stubEnv("WA_MARK_ONLINE_ON_CONNECT", undefined);
    const adapter = new BaileysAdapter("test_instance");

    await adapter.connect();

    expect(mocks.makeWASocket).toHaveBeenCalledWith(
      expect.objectContaining({ markOnlineOnConnect: false }),
    );
    await adapter.disconnect();
  });

  it("passes true to makeWASocket when enabled", async () => {
    vi.stubEnv("WA_MARK_ONLINE_ON_CONNECT", "true");
    const adapter = new BaileysAdapter("test_instance");

    await adapter.connect();

    expect(mocks.makeWASocket).toHaveBeenCalledWith(
      expect.objectContaining({ markOnlineOnConnect: true }),
    );
    await adapter.disconnect();
  });

  it("rejects invalid boolean values", () => {
    vi.stubEnv("WA_MARK_ONLINE_ON_CONNECT", "sometimes");

    expect(() => new BaileysAdapter("test_instance")).toThrow(
      "Invalid WA_MARK_ONLINE_ON_CONNECT; expected true or false",
    );
  });
});
