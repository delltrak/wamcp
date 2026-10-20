import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_REPLY_DEFAULT_COOLDOWN_HOURS,
  AUTO_REPLY_DEFAULT_RATE_PER_MINUTE,
  AUTO_REPLY_MAX_CHARS,
  AUTO_REPLY_MAX_COOLDOWN_HOURS,
  AUTO_REPLY_MAX_RATE_PER_MINUTE,
  AUTO_REPLY_MIN_COOLDOWN_HOURS,
  AUTO_REPLY_MIN_RATE_PER_MINUTE,
  AutoReplyService,
  jidMatchesIgnoreList,
  loadAutoReplyConfig,
  parseAutoReplyIgnoreJids,
  startAutoReply,
  type AutoReplyConfig,
} from "../src/services/auto-reply.js";
import type { NormalizedMessageEvent } from "../src/types/channel.types.js";

const REPLY = "Thanks, I will reply soon.";
const DIRECT = "5511999999999@s.whatsapp.net";
const OTHER = "5511888888888@s.whatsapp.net";
const GROUP = "120363000000000000@g.us";
const HOUR_MS = 60 * 60 * 1000;

const AUTO_REPLY_ENV_KEYS = [
  "WA_AUTO_REPLY_ENABLED",
  "WA_AUTO_REPLY_TEXT",
  "WA_AUTO_REPLY_COOLDOWN_HOURS",
  "WA_AUTO_REPLY_IGNORE_JIDS",
  "WA_AUTO_REPLY_GROUPS",
  "WA_AUTO_REPLY_RATE_PER_MINUTE",
] as const;

function incoming(
  overrides: Partial<NormalizedMessageEvent> & {
    message?: Partial<NormalizedMessageEvent["message"]>;
  } = {},
): NormalizedMessageEvent {
  const { message, ...rest } = overrides;
  return {
    instanceId: "inst_auto",
    chatId: DIRECT,
    ...rest,
    message: {
      id: "m1",
      sender: OTHER,
      timestamp: 1,
      type: "text",
      content: "hello",
      mediaUrl: null,
      quotedMessageId: null,
      isFromMe: false,
      ...message,
    },
  };
}

function enabledConfig(overrides: Partial<AutoReplyConfig> = {}): AutoReplyConfig {
  return {
    enabled: true,
    message: REPLY,
    groups: false,
    cooldownMs: AUTO_REPLY_DEFAULT_COOLDOWN_HOURS * HOUR_MS,
    ratePerMinute: AUTO_REPLY_DEFAULT_RATE_PER_MINUTE,
    ignoreJids: [],
    ...overrides,
  };
}

describe("auto-reply configuration", () => {
  const previous = new Map(AUTO_REPLY_ENV_KEYS.map((key) => [key, process.env[key]]));

  afterEach(() => {
    for (const key of AUTO_REPLY_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("stays disabled unless WA_AUTO_REPLY_ENABLED=true", () => {
    for (const key of AUTO_REPLY_ENV_KEYS) delete process.env[key];

    expect(loadAutoReplyConfig()).toEqual({
      enabled: false,
      message: "",
      groups: false,
      cooldownMs: AUTO_REPLY_DEFAULT_COOLDOWN_HOURS * HOUR_MS,
      ratePerMinute: AUTO_REPLY_DEFAULT_RATE_PER_MINUTE,
      ignoreJids: [],
    });

    process.env.WA_AUTO_REPLY_TEXT = REPLY;
    expect(loadAutoReplyConfig().enabled).toBe(false);

    process.env.WA_AUTO_REPLY_ENABLED = "true";
    expect(loadAutoReplyConfig()).toMatchObject({ enabled: true, message: REPLY });
  });

  it("rejects invalid flags, cooldown, rate, text, and ignore entries", () => {
    process.env.WA_AUTO_REPLY_ENABLED = "yes";
    expect(() => loadAutoReplyConfig()).toThrow(
      "Invalid WA_AUTO_REPLY_ENABLED; expected true or false",
    );

    process.env.WA_AUTO_REPLY_ENABLED = "true";
    delete process.env.WA_AUTO_REPLY_TEXT;
    expect(() => loadAutoReplyConfig()).toThrow(
      "Invalid WA_AUTO_REPLY_TEXT; expected a non-blank text when WA_AUTO_REPLY_ENABLED=true",
    );

    process.env.WA_AUTO_REPLY_TEXT = "x".repeat(AUTO_REPLY_MAX_CHARS + 1);
    expect(() => loadAutoReplyConfig()).toThrow(
      `Invalid WA_AUTO_REPLY_TEXT; expected at most ${AUTO_REPLY_MAX_CHARS} characters`,
    );

    process.env.WA_AUTO_REPLY_TEXT = REPLY;
    process.env.WA_AUTO_REPLY_COOLDOWN_HOURS = "0";
    expect(() => loadAutoReplyConfig()).toThrow(
      `Invalid WA_AUTO_REPLY_COOLDOWN_HOURS; expected an integer from ${AUTO_REPLY_MIN_COOLDOWN_HOURS} to ${AUTO_REPLY_MAX_COOLDOWN_HOURS}`,
    );

    process.env.WA_AUTO_REPLY_COOLDOWN_HOURS = String(AUTO_REPLY_DEFAULT_COOLDOWN_HOURS);
    process.env.WA_AUTO_REPLY_RATE_PER_MINUTE = "0";
    expect(() => loadAutoReplyConfig()).toThrow(
      `Invalid WA_AUTO_REPLY_RATE_PER_MINUTE; expected an integer from ${AUTO_REPLY_MIN_RATE_PER_MINUTE} to ${AUTO_REPLY_MAX_RATE_PER_MINUTE}`,
    );

    delete process.env.WA_AUTO_REPLY_RATE_PER_MINUTE;
    process.env.WA_AUTO_REPLY_GROUPS = "yes";
    expect(() => loadAutoReplyConfig()).toThrow(
      "Invalid WA_AUTO_REPLY_GROUPS; expected true or false",
    );

    process.env.WA_AUTO_REPLY_GROUPS = "false";
    process.env.WA_AUTO_REPLY_IGNORE_JIDS = "bad jid";
    expect(() => loadAutoReplyConfig()).toThrow(/Invalid WA_AUTO_REPLY_IGNORE_JIDS/);
  });

  it("parses exact JIDs, phone numbers, suffixes, and prefix wildcards", () => {
    expect(parseAutoReplyIgnoreJids("  , 5511999999999@s.whatsapp.net, @lid , 5577*@s.whatsapp.net ")).toEqual([
      "5511999999999@s.whatsapp.net",
      "@lid",
      "5577*@s.whatsapp.net",
    ]);

    const patterns = ["5511999999999@s.whatsapp.net", "@lid", "5577*@s.whatsapp.net", "5511888888888"];
    expect(jidMatchesIgnoreList(DIRECT, patterns)).toBe(true);
    expect(jidMatchesIgnoreList("1999991111@lid", patterns)).toBe(true);
    expect(jidMatchesIgnoreList("5577911112222@s.whatsapp.net", patterns)).toBe(true);
    expect(jidMatchesIgnoreList("5511888888888@s.whatsapp.net", patterns)).toBe(true);
    expect(jidMatchesIgnoreList("5511777777777@s.whatsapp.net", patterns)).toBe(false);
    expect(jidMatchesIgnoreList("5577@lid", ["5577*@s.whatsapp.net"])).toBe(false);
  });

  it("does not subscribe while disabled", () => {
    const onAnyEvent = vi.fn();
    const stop = startAutoReply(
      { onAnyEvent, getInstanceChannel: () => "baileys" },
      { enqueueMessage: vi.fn() },
      loadAutoReplyConfig({}),
    );

    expect(onAnyEvent).not.toHaveBeenCalled();
    stop.stop();
  });
});

describe("auto-reply decisions", () => {
  function harness(config: AutoReplyConfig = enabledConfig()) {
    let now = 1_000_000;
    const send = vi.fn(async () => undefined);
    const service = new AutoReplyService(config, send, () => now);
    return {
      send,
      service,
      advance(ms: number) {
        now += ms;
      },
    };
  }

  it("queues the fixed text for a new private chat and waits out the cooldown", () => {
    const { service, send, advance } = harness(enabledConfig({ cooldownMs: HOUR_MS }));

    service.handle("inst_auto", incoming());
    service.handle("inst_auto", incoming({ message: { id: "again" } }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("inst_auto", DIRECT, REPLY);

    advance(HOUR_MS);
    service.handle("inst_auto", incoming({ message: { id: "after-cooldown" } }));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("never replies to itself, broadcasts, newsletters, groups, or its own echo", () => {
    const { service, send } = harness();

    service.handle("inst_auto", incoming({ message: { id: "me", isFromMe: true } }));
    service.handle(
      "inst_auto",
      incoming({ chatId: "status@broadcast", message: { id: "status" } }),
    );
    service.handle("inst_auto", incoming({ chatId: "12345@broadcast", message: { id: "list" } }));
    service.handle(
      "inst_auto",
      incoming({ chatId: "12345@newsletter", message: { id: "channel" } }),
    );
    service.handle("inst_auto", incoming({ message: { id: "echo", content: `  ${REPLY}  ` } }));
    service.handle("inst_auto", incoming({ chatId: GROUP, message: { id: "group" } }));
    service.handle(
      "inst_auto",
      incoming({ message: { id: "audio", type: "audio", content: null } }),
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("inst_auto", DIRECT, REPLY);
  });

  it("replies in a group only when groups are enabled, and still skips status there", () => {
    const disabled = harness();
    disabled.service.handle("inst_auto", incoming({ chatId: GROUP, isGroup: true }));
    expect(disabled.send).not.toHaveBeenCalled();

    const enabled = harness(enabledConfig({ groups: true }));
    enabled.service.handle(
      "inst_auto",
      incoming({ chatId: GROUP, isGroup: true, message: { id: "group-ok" } }),
    );
    enabled.service.handle(
      "inst_auto",
      incoming({ chatId: "status@broadcast", message: { id: "status-group-mode" } }),
    );

    expect(enabled.send).toHaveBeenCalledTimes(1);
    expect(enabled.send).toHaveBeenCalledWith("inst_auto", GROUP, REPLY);
  });

  it("skips ignored chats and senders, including suffix and prefix wildcards", () => {
    const { service, send } = harness(
      enabledConfig({
        ignoreJids: ["@lid", "5577*@s.whatsapp.net", DIRECT],
      }),
    );

    service.handle("inst_auto", incoming({ message: { id: "exact" } }));
    service.handle(
      "inst_auto",
      incoming({
        chatId: "5511777777777@s.whatsapp.net",
        message: { id: "sender", sender: "5577000000000@s.whatsapp.net" },
      }),
    );
    service.handle(
      "inst_auto",
      incoming({ chatId: "1999991111@lid", message: { id: "lid" } }),
    );
    service.handle(
      "inst_auto",
      incoming({ chatId: "5511666666666@s.whatsapp.net", message: { id: "allowed" } }),
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("inst_auto", "5511666666666@s.whatsapp.net", REPLY);
  });

  it("answers a direct lid chat and ignores an unsupported server", () => {
    const { service, send } = harness();

    service.handle(
      "inst_auto",
      incoming({ chatId: "1999991111@lid", message: { id: "lid" } }),
    );
    service.handle(
      "inst_auto",
      incoming({ chatId: "13135550002@c.us", message: { id: "legacy" } }),
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("inst_auto", "1999991111@lid", REPLY);
  });

  it("does not reply twice to the same message id", () => {
    const { service, send, advance } = harness(enabledConfig({ cooldownMs: HOUR_MS }));
    const first = incoming({ message: { id: "same" } });

    service.handle("inst_auto", first);
    advance(HOUR_MS);
    service.handle("inst_auto", first);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps one chat cooldown from blocking another chat inside the rate limit", () => {
    const { service, send } = harness(enabledConfig({ cooldownMs: HOUR_MS, ratePerMinute: 2 }));

    service.handle("inst_auto", incoming({ message: { id: "a" } }));
    service.handle(
      "inst_auto",
      incoming({ chatId: "5511777777777@s.whatsapp.net", message: { id: "b" } }),
    );
    service.handle("inst_auto", incoming({ message: { id: "a2" } }));

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("stops after the per-instance rate limit without consuming that chat cooldown", () => {
    const { service, send, advance } = harness(
      enabledConfig({ ratePerMinute: 1, cooldownMs: HOUR_MS }),
    );

    service.handle("inst_auto", incoming({ chatId: DIRECT, message: { id: "r1" } }));
    service.handle(
      "inst_auto",
      incoming({ chatId: "5511222222222@s.whatsapp.net", message: { id: "r2" } }),
    );
    expect(send).toHaveBeenCalledTimes(1);

    advance(60_000);
    service.handle(
      "inst_auto",
      incoming({ chatId: "5511222222222@s.whatsapp.net", message: { id: "r3" } }),
    );
    service.handle("inst_auto", incoming({ chatId: DIRECT, message: { id: "r4" } }));

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith("inst_auto", "5511222222222@s.whatsapp.net", REPLY);
  });

  it("logs a failed send without throwing", async () => {
    const send = vi.fn(async () => {
      throw new Error("redis down");
    });
    const service = new AutoReplyService(enabledConfig(), send);

    expect(() => service.handle("inst_auto", incoming())).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("enqueues only message.received through the outbound queue", async () => {
    const handlers: Array<
      (event: string, instanceId: string, payload: NormalizedMessageEvent) => void
    > = [];
    const enqueueMessage = vi.fn(async () => ({ status: "queued" as const, jobId: "job-1" }));
    const subscription = startAutoReply(
      {
        onAnyEvent: (handler) => {
          handlers.push(handler);
          return () => undefined;
        },
        getInstanceChannel: () => "cloud",
      },
      { enqueueMessage },
      enabledConfig(),
    );

    handlers[0]?.("message.sent", "inst_auto", incoming({ message: { id: "sent" } }));
    handlers[0]?.("message.received", "inst_auto", incoming());
    await Promise.resolve();

    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    expect(enqueueMessage).toHaveBeenCalledWith(
      "inst_auto",
      DIRECT,
      { type: "text", text: REPLY },
      "cloud",
    );
    subscription.stop();
  });
});
