import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WAMessage } from "@whiskeysockets/baileys";
import { HttpsProxyAgent } from "https-proxy-agent";
import pino from "pino";
import { SocksProxyAgent } from "socks-proxy-agent";
import { ProxyAgent } from "undici";
import { sqlite } from "../src/db/client.js";
import {
  closeBaileysProxyAgents,
  createBaileysProxyAgents,
  mediaDownloadOptions,
  parseBaileysProxyUrl,
  proxyDispatcherUrl,
} from "../src/channels/baileys/proxy.js";
import { logger } from "../src/utils/logger.js";
import { redactError, redactProxyCredentials, redactProxyUrl } from "../src/utils/proxy-redact.js";
import { toolError } from "../src/types/mcp.types.js";

const SECRET = "supersecret";
const CHAT = "5500000000000@s.whatsapp.net";

const mocks = vi.hoisted(() => ({
  makeWASocket: vi.fn(),
  downloadMediaMessage: vi.fn(),
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
    downloadMediaMessage: mocks.downloadMediaMessage,
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

function proxyUrl(scheme: string, port: number): string {
  return `${scheme}://user:${SECRET}@127.0.0.1:${port}`;
}

function expectNoSecret(value: string): void {
  expect(value).not.toContain(SECRET);
  expect(value).not.toContain(`user:${SECRET}`);
}

describe("Baileys proxy URL validation", () => {
  it("treats unset, empty, and whitespace-only values as a direct connection", () => {
    expect(parseBaileysProxyUrl(undefined)).toBeUndefined();
    expect(parseBaileysProxyUrl("")).toBeUndefined();
    expect(parseBaileysProxyUrl("   ")).toBeUndefined();
  });

  it.each([
    ["socks5://127.0.0.1:1080", "socks5://127.0.0.1:1080"],
    ["socks5h://user:p%40ss@proxy.example:1080", "socks5h://user:p%40ss@proxy.example:1080"],
    ["http://user@proxy.example:8080", "http://user@proxy.example:8080"],
    ["https://proxy.example:8443", "https://proxy.example:8443"],
    ["socks5://[::1]:1080", "socks5://[::1]:1080"],
    ["HTTP://Proxy.Example:8080/", "http://proxy.example:8080"],
    ["socks5://user:@proxy.example:1080", "socks5://user:@proxy.example:1080"],
  ])("accepts %s", (input, expected) => {
    expect(parseBaileysProxyUrl(input)).toBe(expected);
  });

  it.each([
    ["socks4://127.0.0.1:1080", /absolute/],
    ["socks://127.0.0.1:1080", /absolute/],
    ["ftp://127.0.0.1:1080", /absolute/],
    ["file:///tmp/proxy", /absolute/],
    ["http://proxy.example", /port/],
    ["https://proxy.example:8443/proxy", /path/],
    ["http://proxy.example:8080?mode=1", /query/],
    ["http://proxy.example:8080#frag", /fragment/],
    [" http://proxy.example:8080", /whitespace/],
    ["http://proxy.example:8080 ", /whitespace/],
    ["http://:secret@proxy.example:8080", /username is required/],
    ["http://user:pass@evil@proxy.example:8080", /absolute/],
    ["http://proxy.example:8080\\path", /backslash/],
    ["http://proxy.example:0", /port/],
    ["http://proxy.example:65536", /port/],
    ["http://user:p%zz@proxy.example:8080", /percent-encoding/],
  ])("rejects %s", (input, pattern) => {
    expect(() => parseBaileysProxyUrl(input)).toThrow(pattern);
  });

  it("rejects control characters without echoing the value", () => {
    expect(() => parseBaileysProxyUrl("http://proxy.example:8080/\nnext")).toThrow(
      /control characters/,
    );
  });

  it("does not echo credentials when validation fails", () => {
    const input = `http://user:${SECRET}@proxy.example:8080/hidden`;
    expect(() => parseBaileysProxyUrl(input)).toThrow(Error);
    try {
      parseBaileysProxyUrl(input);
    } catch (error) {
      const err = error as Error;
      expectNoSecret(`${err.name} ${err.message} ${err.stack ?? ""}`);
      expect(err.message).toMatch(/path is not allowed/);
    }
  });
});

describe("proxy credential redaction", () => {
  const configured = proxyUrl("socks5", 1080);

  it("keeps the proxy host and removes userinfo", () => {
    expect(redactProxyUrl(configured)).toBe("socks5://***:***@127.0.0.1:1080");
    expect(redactProxyUrl("not a url")).toBe("<unparseable-proxy-url>");
    expect(redactProxyUrl("http://proxy.example:8080")).toBe("http://proxy.example:8080");
    expectNoSecret(redactProxyUrl(configured));
  });

  it("redacts proxy URLs in text without damaging a host that contains the same word", () => {
    const text = `via socks5://user:${SECRET}@${SECRET}.example:1080`;
    expect(redactProxyCredentials(text)).toBe(`via socks5://***:***@${SECRET}.example:1080`);
  });

  it("redacts a credential pair that leaked outside a URL", () => {
    const text = `authentication failed for user:${SECRET}`;
    expectNoSecret(redactProxyCredentials(text, configured));
    expect(redactProxyCredentials("https://mmg.whatsapp.net/file", configured)).toBe(
      "https://mmg.whatsapp.net/file",
    );
  });

  it("redacts the trailing-slash form stored by an HTTP proxy agent", () => {
    const line = JSON.stringify({
      proxy: `http://user:${SECRET}@127.0.0.1:8080/`,
    });
    expectNoSecret(redactProxyCredentials(line));
    expect(redactProxyCredentials(line)).toContain("127.0.0.1:8080");
  });

  it("redacts credentials in error stacks", () => {
    const error = new Error(`connect failed via ${configured}`);
    const redacted = redactError(error, configured);
    expectNoSecret(`${redacted.message}\n${redacted.stack ?? ""}`);
    expect(redacted.name).toBe("Error");
  });

  it("redacts credentials in the application log hook and tool errors", () => {
    const hooks = logger[pino.symbols.hooksSym] as { streamWrite?: (line: string) => string };
    expect(typeof hooks.streamWrite).toBe("function");
    vi.stubEnv("WA_BAILEYS_PROXY", configured);
    const logged = hooks.streamWrite!(
      JSON.stringify({ msg: `dial ${configured}`, proxyUrl: configured }),
    );
    expectNoSecret(logged);
    expect(logged).toContain("127.0.0.1:1080");

    const response = toolError(`Instance failed: ${configured}`);
    expectNoSecret(JSON.stringify(response));
    vi.unstubAllEnvs();
  });
});

describe("Baileys proxy agents", () => {
  it("maps socks5h to the socks5 dispatcher URL without rewriting credentials", () => {
    expect(proxyDispatcherUrl(proxyUrl("socks5h", 1080))).toBe(proxyUrl("socks5", 1080));
    expect(proxyDispatcherUrl(proxyUrl("http", 8080))).toBe(proxyUrl("http", 8080));
  });

  it("builds separate websocket and upload agents plus a download dispatcher", async () => {
    const socks = createBaileysProxyAgents(proxyUrl("socks5", 1080));
    const http = createBaileysProxyAgents(proxyUrl("http", 8080));
    const secure = createBaileysProxyAgents(proxyUrl("https", 8443));
    const remoteDns = createBaileysProxyAgents(proxyUrl("socks5h", 1080));
    try {
      expect(socks.agent).toBeInstanceOf(SocksProxyAgent);
      expect(socks.fetchAgent).toBeInstanceOf(SocksProxyAgent);
      expect(socks.agent).not.toBe(socks.fetchAgent);
      expect(socks.dispatcher).toBeInstanceOf(ProxyAgent);
      expect((socks.agent as SocksProxyAgent).proxyUrl.startsWith("socks5:")).toBe(true);
      expect(http.agent).toBeInstanceOf(HttpsProxyAgent);
      expect(http.fetchAgent).toBeInstanceOf(HttpsProxyAgent);
      expect(secure.agent).toBeInstanceOf(HttpsProxyAgent);
      expect(remoteDns.agent).toBeInstanceOf(SocksProxyAgent);
      expect((remoteDns.agent as SocksProxyAgent).proxyUrl.startsWith("socks5h:")).toBe(true);
      expect(remoteDns.dispatcher).toBeInstanceOf(ProxyAgent);
      expectNoSecret(socks.redactedUrl);
      expectNoSecret(remoteDns.redactedUrl);
    } finally {
      await closeBaileysProxyAgents(socks);
      await closeBaileysProxyAgents(http);
      await closeBaileysProxyAgents(secure);
      await closeBaileysProxyAgents(remoteDns);
    }
  });

  it("returns the same download options as a direct connection when no proxy is set", () => {
    expect(mediaDownloadOptions(undefined, undefined)).toEqual({});
    const withTimeout = mediaDownloadOptions(1000, undefined);
    expect(withTimeout.options?.signal).toBeInstanceOf(AbortSignal);
    expect(withTimeout.options).not.toHaveProperty("dispatcher");
  });
});

describe("BaileysAdapter proxy wiring", () => {
  let socket: {
    ev: { on: ReturnType<typeof vi.fn>; process: ReturnType<typeof vi.fn> };
    end: ReturnType<typeof vi.fn>;
    updateMediaMessage: ReturnType<typeof vi.fn>;
  };
  let activeAdapter: BaileysAdapter | undefined;
  let activeInstanceId: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    socket = {
      ev: { on: vi.fn(), process: vi.fn() },
      end: vi.fn(),
      updateMediaMessage: vi.fn(),
    };
    mocks.makeWASocket.mockReturnValue(socket);
    mocks.downloadMediaMessage.mockResolvedValue(Readable.from([Buffer.from("media")]));
  });

  afterEach(async () => {
    if (activeAdapter) {
      await activeAdapter.disconnect();
      activeAdapter = undefined;
    }
    vi.unstubAllEnvs();
    if (activeInstanceId) {
      sqlite.prepare("DELETE FROM instances WHERE id = ?").run(activeInstanceId);
      activeInstanceId = undefined;
    }
  });

  async function connectAdapter(instanceId = `proxy-${randomUUID()}`): Promise<BaileysAdapter> {
    const adapter = new BaileysAdapter(instanceId);
    activeAdapter = adapter;
    await adapter.connect();
    return adapter;
  }

  function socketOptions(): Record<string, unknown> {
    return mocks.makeWASocket.mock.calls.at(-1)?.[0] as Record<string, unknown>;
  }

  it("omits agent and fetchAgent when no proxy is configured", async () => {
    vi.stubEnv("WA_BAILEYS_PROXY", "");
    await connectAdapter();
    const options = socketOptions();
    expect(options).not.toHaveProperty("agent");
    expect(options).not.toHaveProperty("fetchAgent");
    expect(options.version).toEqual([2, 3000, 0]);
  });

  it("passes SOCKS and HTTP agents to the socket", async () => {
    vi.stubEnv("WA_BAILEYS_PROXY", proxyUrl("socks5", 1080));
    await connectAdapter();
    const socks = socketOptions();
    expect(socks.agent).toBeInstanceOf(SocksProxyAgent);
    expect(socks.fetchAgent).toBeInstanceOf(SocksProxyAgent);
    expect(socks.agent).not.toBe(socks.fetchAgent);
    await activeAdapter?.disconnect();
    activeAdapter = undefined;

    vi.stubEnv("WA_BAILEYS_PROXY", proxyUrl("http", 8080));
    await connectAdapter();
    const http = socketOptions();
    expect(http.agent).toBeInstanceOf(HttpsProxyAgent);
    expect(http.fetchAgent).toBeInstanceOf(HttpsProxyAgent);
  });

  it("refuses an invalid proxy before opening a socket", () => {
    vi.stubEnv("WA_BAILEYS_PROXY", `socks5://user:${SECRET}@127.0.0.1:1080/extra`);
    expect(() => new BaileysAdapter("invalid-proxy")).toThrow(/path is not allowed/);
    try {
      new BaileysAdapter("invalid-proxy");
    } catch (error) {
      expectNoSecret(`${(error as Error).message} ${(error as Error).stack ?? ""}`);
    }
    expect(mocks.makeWASocket).not.toHaveBeenCalled();
  });

  it("downloads media through the proxy dispatcher and leaves direct downloads unchanged", async () => {
    const instanceId = `proxy-download-${randomUUID()}`;
    activeInstanceId = instanceId;
    sqlite
      .prepare(
        "INSERT INTO instances (id, name, channel, status, created_at, updated_at) VALUES (?, ?, 'baileys', 'disconnected', 1700000000, 1700000000)",
      )
      .run(instanceId, "Proxy fixture");
    const messageId = `PROXY-MEDIA-${randomUUID()}`;
    const source = {
      key: { id: messageId, remoteJid: CHAT, fromMe: false },
      message: {
        imageMessage: { url: "https://mmg.whatsapp.net/image.jpg", mimetype: "image/jpeg" },
      },
      messageTimestamp: 1_700_000_000,
    } as WAMessage;
    sqlite
      .prepare(
        `INSERT INTO messages (
          id, instance_id, chat_id, sender_id, type, content, media_url, media_mimetype,
          is_from_me, status, timestamp, raw_data
        ) VALUES (?, ?, ?, ?, 'image', NULL, ?, 'image/jpeg', 0, 'received', 1700000000, ?)`,
      )
      .run(
        messageId,
        instanceId,
        CHAT,
        CHAT,
        "https://mmg.whatsapp.net/image.jpg",
        JSON.stringify(source),
      );

    const audioId = `PROXY-AUDIO-${randomUUID()}`;
    const audio = {
      key: { id: audioId, remoteJid: CHAT, fromMe: false },
      message: {
        audioMessage: { url: "https://mmg.whatsapp.net/audio.ogg", mimetype: "audio/ogg" },
      },
      messageTimestamp: 1_700_000_000,
    } as WAMessage;
    sqlite
      .prepare(
        `INSERT INTO messages (
          id, instance_id, chat_id, sender_id, type, content, media_url, media_mimetype,
          is_from_me, status, timestamp, raw_data
        ) VALUES (?, ?, ?, ?, 'audio', NULL, ?, 'audio/ogg', 0, 'received', 1700000000, ?)`,
      )
      .run(audioId, instanceId, CHAT, CHAT, "https://mmg.whatsapp.net/audio.ogg", JSON.stringify(audio));

    vi.stubEnv("WA_BAILEYS_PROXY", proxyUrl("socks5", 1080));
    const adapter = await connectAdapter(instanceId);
    Object.assign(adapter, { status: "connected" });
    await adapter.downloadMessageMedia(messageId, CHAT);
    await adapter.downloadMessageAudio(audioId);
    for (const call of mocks.downloadMediaMessage.mock.calls) {
      const proxied = call[2] as { options?: { dispatcher?: unknown; signal?: AbortSignal } };
      expect(proxied.options?.dispatcher).toBeInstanceOf(ProxyAgent);
      expect(proxied.options).not.toHaveProperty("signal");
    }
    expect(mocks.downloadMediaMessage).toHaveBeenCalledTimes(2);

    await adapter.disconnect();
    activeAdapter = undefined;
    mocks.downloadMediaMessage.mockClear();

    vi.stubEnv("WA_BAILEYS_PROXY", "");
    const direct = await connectAdapter(instanceId);
    Object.assign(direct, { status: "connected" });
    await direct.downloadMessageMedia(messageId, CHAT, undefined, 1500);
    const directOptions = mocks.downloadMediaMessage.mock.calls[0]?.[2] as {
      options?: { dispatcher?: unknown; signal?: AbortSignal };
    };
    expect(directOptions.options?.signal).toBeInstanceOf(AbortSignal);
    expect(directOptions.options).not.toHaveProperty("dispatcher");
  });
});

describe("proxy documentation", () => {
  it("documents the opt-in variable without enabling it", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    expect(readme).toContain("WA_BAILEYS_PROXY");
    expect(readme).toContain("fetchAgent");
    expect(example).toContain("# WA_BAILEYS_PROXY=socks5://user:pass@proxy.example:1080");
    expect(example).not.toContain(SECRET);
  });
});
