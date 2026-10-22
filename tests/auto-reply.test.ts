import { afterEach, describe, expect, it, vi } from "vitest";
import type { WAMessage } from "@whiskeysockets/baileys";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  messageIdentityFields,
  normalizeMessagesUpsert,
} from "../src/channels/baileys/baileys.events.js";
import { db } from "../src/db/client.js";
import {
  AUTO_REPLY_COOLDOWN_SELECT_SQL,
  AUTO_REPLY_COOLDOWNS_TABLE_SQL,
} from "../src/db/auto-reply-cooldown-sql.js";
import { cooldownTimestamp, sqliteAutoReplyCooldownStore } from "../src/db/auto-reply-cooldown.js";
import { instances } from "../src/db/schema.js";
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
  memoryAutoReplyCooldownStore,
  parseAutoReplyIgnoreJids,
  resolveAutoReplyContact,
  startAutoReply,
  type AutoReplyConfig,
  type AutoReplyContact,
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
  "WA_AUTO_REPLY_MAX_AGE_SECONDS",
  "WA_AUTO_REPLY_INSTANCES",
] as const;

function incoming(
  overrides: Partial<NormalizedMessageEvent> & {
    message?: Partial<NormalizedMessageEvent["message"]>;
  } = {},
  nowMs = Date.now(),
): NormalizedMessageEvent {
  const { message, ...rest } = overrides;
  return {
    instanceId: "inst_auto",
    chatId: DIRECT,
    ...rest,
    message: {
      id: "m1",
      sender: OTHER,
      timestamp: Math.floor(nowMs / 1000),
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
    maxAgeSeconds: 180,
    ignoreJids: [],
    instances: [],
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
      maxAgeSeconds: 180,
      ignoreJids: [],
      instances: [],
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

    process.env.WA_AUTO_REPLY_IGNORE_JIDS = "s.whatsapp.net";
    expect(() => loadAutoReplyConfig()).toThrow(
      'Invalid WA_AUTO_REPLY_IGNORE_JIDS; entry "s.whatsapp.net" cannot match a chat',
    );

    process.env.WA_AUTO_REPLY_IGNORE_JIDS = "abc@xyz";
    expect(() => loadAutoReplyConfig()).toThrow(
      'Invalid WA_AUTO_REPLY_IGNORE_JIDS; entry "abc@xyz" cannot match a chat',
    );

    process.env.WA_AUTO_REPLY_IGNORE_JIDS = "";
    process.env.WA_AUTO_REPLY_MAX_AGE_SECONDS = "29";
    expect(() => loadAutoReplyConfig()).toThrow(
      "Invalid WA_AUTO_REPLY_MAX_AGE_SECONDS; expected an integer from 30 to 3600",
    );

    process.env.WA_AUTO_REPLY_MAX_AGE_SECONDS = "180";
    process.env.WA_AUTO_REPLY_INSTANCES = "inst_auto, inst_other";
    expect(loadAutoReplyConfig().instances).toEqual(["inst_auto", "inst_other"]);
  });

  it("ignores invalid auto-reply settings while the feature is off", () => {
    for (const key of AUTO_REPLY_ENV_KEYS) delete process.env[key];
    process.env.WA_AUTO_REPLY_ENABLED = "false";
    process.env.WA_AUTO_REPLY_TEXT = "x".repeat(AUTO_REPLY_MAX_CHARS + 1);
    process.env.WA_AUTO_REPLY_COOLDOWN_HOURS = "nope";
    process.env.WA_AUTO_REPLY_MAX_AGE_SECONDS = "1";
    process.env.WA_AUTO_REPLY_IGNORE_JIDS = "s.whatsapp.net";
    process.env.WA_AUTO_REPLY_INSTANCES = "bad id";
    process.env.WA_AUTO_REPLY_RATE_PER_MINUTE = "0";

    expect(loadAutoReplyConfig()).toMatchObject({ enabled: false, instances: [], ignoreJids: [] });
  });

  it("parses exact JIDs, phone numbers, suffixes, and prefix wildcards", () => {
    expect(
      parseAutoReplyIgnoreJids("  , 5511999999999@s.whatsapp.net, @lid , 5577*@s.whatsapp.net "),
    ).toEqual(["5511999999999@s.whatsapp.net", "@lid", "5577*@s.whatsapp.net"]);

    const patterns = [
      "5511999999999@s.whatsapp.net",
      "@lid",
      "5577*@s.whatsapp.net",
      "5511888888888",
    ];
    expect(jidMatchesIgnoreList(DIRECT, patterns)).toBe(true);
    expect(jidMatchesIgnoreList("1999991111@lid", patterns)).toBe(true);
    expect(jidMatchesIgnoreList("5577911112222@s.whatsapp.net", patterns)).toBe(true);
    expect(jidMatchesIgnoreList("5511888888888@s.whatsapp.net", patterns)).toBe(true);
    expect(jidMatchesIgnoreList("5511777777777@s.whatsapp.net", patterns)).toBe(false);
    expect(jidMatchesIgnoreList("5577@lid", ["5577*@s.whatsapp.net"])).toBe(false);
    expect(jidMatchesIgnoreList("5511888888888@lid", ["5511888888888"])).toBe(false);
  });

  it("matches ignore entries by user and domain, including device suffixes", () => {
    const cases: Array<{ jid: string; patterns: string[]; match: boolean }> = [
      {
        jid: "5511999999999:12@s.whatsapp.net",
        patterns: ["5511999999999@s.whatsapp.net"],
        match: true,
      },
      {
        jid: "5577911112222:4@s.whatsapp.net",
        patterns: ["5577*"],
        match: true,
      },
      { jid: "5577911112222@lid", patterns: ["5577*"], match: false },
      { jid: "5577911112222@g.us", patterns: ["5577*"], match: false },
      {
        jid: "5577911112222:4@s.whatsapp.net",
        patterns: ["5577*@s.whatsapp.net"],
        match: true,
      },
      { jid: "5577911112222@lid", patterns: ["5577*@s.whatsapp.net"], match: false },
      { jid: "1999991111:1@lid", patterns: ["@lid"], match: true },
      { jid: "1999991111@s.whatsapp.net", patterns: ["*@lid"], match: false },
      { jid: "1999991111@lid", patterns: ["*@lid"], match: true },
      { jid: "s.whatsapp.net", patterns: ["5511*"], match: false },
      {
        jid: "5511999999999:12@s.whatsapp.net",
        patterns: ["5511*:12@s.whatsapp.net"],
        match: true,
      },
    ];

    for (const entry of cases) {
      expect(jidMatchesIgnoreList(entry.jid, entry.patterns), entry.jid).toBe(entry.match);
    }
    expect(() => parseAutoReplyIgnoreJids("s.whatsapp.net")).toThrow(/cannot match a chat/);
    expect(() => parseAutoReplyIgnoreJids("abc@xyz")).toThrow(/cannot match a chat/);
    expect(parseAutoReplyIgnoreJids("@hosted.lid, *@newsletter, 5511*@g.us")).toEqual([
      "@hosted.lid",
      "*@newsletter",
      "5511*@g.us",
    ]);
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
    let now = 1_700_000_000_000;
    const send = vi.fn(async () => undefined);
    const service = new AutoReplyService(config, send, () => now);
    return {
      send,
      service,
      now: () => now,
      event(
        overrides: Partial<NormalizedMessageEvent> & {
          message?: Partial<NormalizedMessageEvent["message"]>;
        } = {},
      ) {
        return incoming(overrides, now);
      },
      advance(ms: number) {
        now += ms;
      },
    };
  }

  it("queues the fixed text for a new private chat and waits out the cooldown", async () => {
    const { service, send, advance, event } = harness(enabledConfig({ cooldownMs: HOUR_MS }));

    service.handle("inst_auto", event());
    service.handle("inst_auto", event({ message: { id: "again" } }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("inst_auto", DIRECT, REPLY);

    await Promise.resolve();
    advance(HOUR_MS);
    service.handle("inst_auto", event({ message: { id: "after-cooldown" } }));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("never replies to itself, broadcasts, newsletters, groups, or its own echo", () => {
    const { service, send, event } = harness();

    service.handle("inst_auto", event({ message: { id: "me", isFromMe: true } }));
    service.handle("inst_auto", event({ chatId: "status@broadcast", message: { id: "status" } }));
    service.handle("inst_auto", event({ chatId: "12345@broadcast", message: { id: "list" } }));
    service.handle("inst_auto", event({ chatId: "12345@newsletter", message: { id: "channel" } }));
    service.handle("inst_auto", event({ message: { id: "echo", content: `  ${REPLY}  ` } }));
    service.handle("inst_auto", event({ chatId: GROUP, message: { id: "group" } }));
    service.handle("inst_auto", event({ message: { id: "audio", type: "audio", content: null } }));

    expect(send).not.toHaveBeenCalled();
  });

  it("replies in a group only when groups are enabled, and still skips status there", () => {
    const disabled = harness();
    disabled.service.handle("inst_auto", disabled.event({ chatId: GROUP, isGroup: true }));
    expect(disabled.send).not.toHaveBeenCalled();

    const enabled = harness(enabledConfig({ groups: true }));
    enabled.service.handle(
      "inst_auto",
      enabled.event({ chatId: GROUP, isGroup: true, message: { id: "group-ok" } }),
    );
    enabled.service.handle(
      "inst_auto",
      enabled.event({ chatId: "status@broadcast", message: { id: "status-group-mode" } }),
    );

    expect(enabled.send).toHaveBeenCalledTimes(1);
    expect(enabled.send).toHaveBeenCalledWith("inst_auto", GROUP, REPLY);
  });

  it("skips ignored chats and senders, including suffix and prefix wildcards", () => {
    const { service, send, event } = harness(
      enabledConfig({
        ignoreJids: ["@lid", "5577*@s.whatsapp.net", DIRECT],
      }),
    );

    service.handle("inst_auto", event({ message: { id: "exact" } }));
    service.handle(
      "inst_auto",
      event({
        chatId: "5511777777777@s.whatsapp.net",
        message: { id: "sender", sender: "5577000000000@s.whatsapp.net" },
      }),
    );
    service.handle("inst_auto", event({ chatId: "1999991111@lid", message: { id: "lid" } }));
    service.handle(
      "inst_auto",
      event({ chatId: "5511666666666@s.whatsapp.net", message: { id: "allowed" } }),
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("inst_auto", "5511666666666@s.whatsapp.net", REPLY);
  });

  it("answers a direct lid chat and ignores hosted and legacy servers", () => {
    const { service, send, event } = harness();

    service.handle("inst_auto", event({ chatId: "1999991111@lid", message: { id: "lid" } }));
    service.handle("inst_auto", event({ chatId: "13135550002@c.us", message: { id: "legacy" } }));
    service.handle("inst_auto", event({ chatId: "123@hosted", message: { id: "hosted" } }));
    service.handle("inst_auto", event({ chatId: "123@hosted.lid", message: { id: "hosted-lid" } }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("inst_auto", "1999991111@lid", REPLY);
  });

  it("does not reply twice to the same message id", () => {
    const { service, send, advance, event } = harness(enabledConfig({ cooldownMs: HOUR_MS }));
    const first = event({ message: { id: "same" } });

    service.handle("inst_auto", first);
    advance(HOUR_MS);
    service.handle("inst_auto", first);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps one chat cooldown from blocking another chat inside the rate limit", () => {
    const { service, send, event } = harness(
      enabledConfig({ cooldownMs: HOUR_MS, ratePerMinute: 2 }),
    );

    service.handle("inst_auto", event({ message: { id: "a" } }));
    service.handle(
      "inst_auto",
      event({ chatId: "5511777777777@s.whatsapp.net", message: { id: "b" } }),
    );
    service.handle("inst_auto", event({ message: { id: "a2" } }));

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("stops after the per-instance rate limit without consuming that chat cooldown", () => {
    const { service, send, advance, event } = harness(
      enabledConfig({ ratePerMinute: 1, cooldownMs: HOUR_MS }),
    );

    service.handle("inst_auto", event({ chatId: DIRECT, message: { id: "r1" } }));
    service.handle(
      "inst_auto",
      event({ chatId: "5511222222222@s.whatsapp.net", message: { id: "r2" } }),
    );
    expect(send).toHaveBeenCalledTimes(1);

    advance(60_000);
    service.handle(
      "inst_auto",
      event({ chatId: "5511222222222@s.whatsapp.net", message: { id: "r3" } }),
    );
    service.handle("inst_auto", event({ chatId: DIRECT, message: { id: "r4" } }));

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith("inst_auto", "5511222222222@s.whatsapp.net", REPLY);
  });

  it("replies only to real user content and skips old messages", () => {
    const { service, send, event, now } = harness();
    const fresh = Math.floor(now() / 1000);

    service.handle("inst_auto", event({ message: { id: "text", content: "hello" } }));
    service.handle(
      "inst_auto",
      event({
        chatId: "5511777777777@s.whatsapp.net",
        message: {
          id: "image",
          type: "image",
          content: null,
          mediaUrl: "https://cdn.example/a.jpg",
        },
      }),
    );
    service.handle(
      "inst_auto",
      event({
        chatId: "5511666666666@s.whatsapp.net",
        message: { id: "empty-audio", type: "audio", content: null, mediaUrl: null },
      }),
    );
    service.handle(
      "inst_auto",
      event({
        chatId: "5511555555555@s.whatsapp.net",
        message: { id: "reaction", type: "reaction", content: "👍" },
      }),
    );
    service.handle(
      "inst_auto",
      event({
        chatId: "5511444444444@s.whatsapp.net",
        message: { id: "protocol", type: "text", content: "edit", rawType: "protocolMessage" },
      }),
    );
    service.handle(
      "inst_auto",
      event({
        chatId: "5511333333333@s.whatsapp.net",
        message: { id: "stub", type: "text", content: "joined", rawType: "messageStub" },
      }),
    );
    service.handle(
      "inst_auto",
      event({
        chatId: "5511222222222@s.whatsapp.net",
        message: { id: "revoke", type: "text", content: "revoked", rawType: "revoke" },
      }),
    );
    service.handle(
      "inst_auto",
      event({
        chatId: "5511111111111@s.whatsapp.net",
        message: { id: "zero", content: "old", timestamp: 0 },
      }),
    );
    service.handle(
      "inst_auto",
      event({
        chatId: "5511000000000@s.whatsapp.net",
        message: { id: "aged", content: "old", timestamp: fresh - 181 },
      }),
    );

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("skips the account's own phone and lid even when the message is not fromMe", () => {
    const { service, send, event } = harness();
    const own: AutoReplyContact = {
      contactKey: OTHER,
      aliases: [DIRECT, OTHER],
      ownJids: [OTHER, "1999991111@lid"],
    };

    service.handle("inst_auto", event({ message: { id: "own-sender" } }), own);
    service.handle(
      "inst_auto",
      event({ chatId: "1999991111:3@lid", message: { id: "own-lid", sender: OTHER } }),
      { ...own, contactKey: "1999991111@lid" },
    );

    expect(send).not.toHaveBeenCalled();
  });

  it("applies one cooldown and one ignore list across PN and LID aliases", () => {
    const { service, send, event } = harness(
      enabledConfig({
        cooldownMs: HOUR_MS,
        ignoreJids: ["5577*"],
      }),
    );
    const person: AutoReplyContact = {
      contactKey: DIRECT,
      aliases: [DIRECT, "1999991111@lid"],
      ownJids: [],
    };

    service.handle(
      "inst_auto",
      event({ chatId: "1999991111@lid", message: { id: "lid" } }),
      person,
    );
    service.handle("inst_auto", event({ chatId: DIRECT, message: { id: "pn" } }), person);
    service.handle(
      "inst_auto",
      event({ chatId: "5577000000000@lid", message: { id: "ignored-lid" } }),
      {
        contactKey: "5577000000000@s.whatsapp.net",
        aliases: ["5577000000000@s.whatsapp.net", "5577000000000@lid"],
        ownJids: [],
      },
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("inst_auto", "1999991111@lid", REPLY);
  });

  it("applies a domain suffix to the chat or group sender, and exact entries to aliases", () => {
    const domain = harness(enabledConfig({ ignoreJids: ["@lid"] }));
    domain.service.handle(
      "inst_auto",
      domain.event({
        chatId: DIRECT,
        chatLid: "1999991111@lid",
        message: { id: "pn-with-lid", sender: DIRECT, senderLid: "1999991111@lid" },
      }),
    );
    domain.service.handle(
      "inst_auto",
      domain.event({ chatId: "1999991111@lid", message: { id: "lid-chat" } }),
    );
    expect(domain.send).toHaveBeenCalledTimes(1);
    expect(domain.send).toHaveBeenCalledWith("inst_auto", DIRECT, REPLY);

    const groups = harness(enabledConfig({ groups: true, ignoreJids: ["@lid"] }));
    groups.service.handle(
      "inst_auto",
      groups.event({
        chatId: GROUP,
        isGroup: true,
        message: { id: "sender-pn", sender: DIRECT, senderLid: "1999991111@lid" },
      }),
    );
    groups.service.handle(
      "inst_auto",
      groups.event({
        chatId: "120363000000000002@g.us",
        isGroup: true,
        message: { id: "sender-lid", sender: "1999991111@lid" },
      }),
    );
    expect(groups.send).toHaveBeenCalledTimes(1);
    expect(groups.send).toHaveBeenCalledWith("inst_auto", GROUP, REPLY);

    const exact = harness(enabledConfig({ ignoreJids: [DIRECT] }));
    exact.service.handle(
      "inst_auto",
      exact.event({
        chatId: "5511666666666@s.whatsapp.net",
        message: { id: "exact-alias" },
      }),
      {
        contactKey: "5511666666666@s.whatsapp.net",
        aliases: ["5511666666666@s.whatsapp.net", DIRECT],
        ownJids: [],
      },
    );
    expect(exact.send).not.toHaveBeenCalled();
  });

  it("skips every group when ignore is @g.us and still replies in a private chat", () => {
    const { service, send, event } = harness(
      enabledConfig({ groups: true, ignoreJids: ["@g.us"] }),
    );

    service.handle(
      "inst_auto",
      event({
        chatId: GROUP,
        isGroup: true,
        message: { id: "group", sender: OTHER },
      }),
    );
    service.handle("inst_auto", event({ message: { id: "direct" } }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("inst_auto", DIRECT, REPLY);
  });

  it("skips every group when ignore is *@g.us and still replies in a private chat", () => {
    const { service, send, event } = harness(
      enabledConfig({ groups: true, ignoreJids: ["*@g.us"] }),
    );

    service.handle(
      "inst_auto",
      event({
        chatId: GROUP,
        isGroup: true,
        message: { id: "group", sender: OTHER },
      }),
    );
    service.handle("inst_auto", event({ message: { id: "direct" } }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("inst_auto", DIRECT, REPLY);
  });

  it("shares one cooldown across every sender in a group", () => {
    const { service, send, event } = harness(enabledConfig({ groups: true, cooldownMs: HOUR_MS }));
    const otherGroup = "120363000000000001@g.us";

    service.handle(
      "inst_auto",
      event({
        chatId: GROUP,
        isGroup: true,
        message: { id: "g1", sender: "5511111111111@s.whatsapp.net" },
      }),
    );
    service.handle(
      "inst_auto",
      event({
        chatId: GROUP,
        isGroup: true,
        message: { id: "g2", sender: "5511222222222@s.whatsapp.net" },
      }),
    );
    service.handle(
      "inst_auto",
      event({
        chatId: otherGroup,
        isGroup: true,
        message: { id: "g3", sender: "5511111111111@s.whatsapp.net" },
      }),
    );

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, "inst_auto", GROUP, REPLY);
    expect(send).toHaveBeenNthCalledWith(2, "inst_auto", otherGroup, REPLY);
  });

  it("limits replies to the configured instances", () => {
    const { service, send, event } = harness(enabledConfig({ instances: ["inst_other"] }));

    service.handle("inst_auto", event({ message: { id: "skip" } }));
    service.handle("inst_other", event({ message: { id: "keep" } }));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("inst_other", DIRECT, REPLY);
  });

  it("keeps a shared cooldown after a new service is created", async () => {
    const store = memoryAutoReplyCooldownStore();
    let now = 1_700_000_000_000;
    const firstSend = vi.fn(async () => undefined);
    const first = new AutoReplyService(
      enabledConfig({ cooldownMs: HOUR_MS }),
      firstSend,
      () => now,
      store,
    );
    first.handle("inst_auto", incoming({}, now));
    await Promise.resolve();
    expect(firstSend).toHaveBeenCalledTimes(1);

    now += 60_000;
    const secondSend = vi.fn(async () => undefined);
    const second = new AutoReplyService(
      enabledConfig({ cooldownMs: HOUR_MS }),
      secondSend,
      () => now,
      store,
    );
    second.handle("inst_auto", incoming({ message: { id: "later" } }, now));

    expect(secondSend).not.toHaveBeenCalled();
  });

  it("does not persist a pending enqueue and releases failures for retry", async () => {
    const store = memoryAutoReplyCooldownStore();
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    const send = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(undefined);
    const service = new AutoReplyService(
      enabledConfig({ ratePerMinute: 1 }),
      send,
      Date.now,
      store,
    );
    const event = incoming();
    service.handle("inst_auto", event);
    service.handle("inst_auto", incoming({ message: { id: "concurrent" } }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.load("inst_auto", DIRECT)).toBeUndefined();
    reject(new Error("redis unavailable"));
    await vi.waitFor(() => {
      service.handle("inst_auto", event);
      expect(send).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => expect(store.load("inst_auto", DIRECT)).toBeTypeOf("number"));
    const restartedSend = vi.fn(async () => undefined);
    new AutoReplyService(enabledConfig(), restartedSend, Date.now, store).handle(
      "inst_auto",
      incoming({ message: { id: "after-restart" } }),
    );
    expect(restartedSend).not.toHaveBeenCalled();
  });

  it("isolates pending reservations and persisted cooldowns by instance", async () => {
    const store = memoryAutoReplyCooldownStore();
    const send = vi.fn(async () => undefined);
    const service = new AutoReplyService(
      enabledConfig({ ratePerMinute: 1 }),
      send,
      Date.now,
      store,
    );
    service.handle("first", incoming());
    service.handle("second", incoming());
    expect(send).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    service.handle("first", incoming({ message: { id: "later" } }));
    service.handle("second", incoming({ message: { id: "later" } }));
    expect(send).toHaveBeenCalledTimes(2);
    expect(store.load("first", DIRECT)).toBeTypeOf("number");
    expect(store.load("second", DIRECT)).toBeTypeOf("number");
  });

  it("keeps a local cooldown if persistence fails after the queue accepts the reply", async () => {
    const send = vi.fn(async () => undefined);
    const store = {
      load: () => undefined,
      save: () => {
        throw new Error("database unavailable");
      },
    };
    const service = new AutoReplyService(enabledConfig(), send, Date.now, store);
    service.handle("inst_auto", incoming());
    await Promise.resolve();
    service.handle("inst_auto", incoming({ message: { id: "later" } }));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("uses supplied group sender phone aliases before the LID mapping exists", () => {
    const { service, send, event } = harness(enabledConfig({ groups: true, ignoreJids: [DIRECT] }));
    service.handle(
      "inst_auto",
      event({ chatId: GROUP, isGroup: true, message: { sender: "123@lid", senderPn: DIRECT } }),
    );
    expect(send).not.toHaveBeenCalled();
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
      memoryAutoReplyCooldownStore(),
    );

    handlers[0]?.("message.sent", "inst_auto", incoming({ message: { id: "sent" } }));
    handlers[0]?.("message.received", "inst_auto", incoming());
    await vi.waitFor(() => {
      expect(enqueueMessage).toHaveBeenCalledTimes(1);
    });

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

describe("auto-reply contact identity", () => {
  it("uses the phone JID from the chat and the adapter mapping", async () => {
    const fromPair = await resolveAutoReplyContact(
      incoming({
        chatId: DIRECT,
        chatLid: "1999991111@lid",
        message: { sender: DIRECT, senderLid: "1999991111@lid" },
      }),
    );
    expect(fromPair.contactKey).toBe(DIRECT);
    expect(fromPair.aliases).toEqual(expect.arrayContaining([DIRECT, "1999991111@lid"]));

    const fromLookup = await resolveAutoReplyContact(
      incoming({
        chatId: "1999991111:8@lid",
        chatLid: "1999991111@lid",
        message: { sender: "1999991111:8@lid", senderLid: "1999991111@lid" },
      }),
      { resolvePn: async () => DIRECT },
    );
    expect(fromLookup.contactKey).toBe(DIRECT);
    expect(fromLookup.aliases).toContain(DIRECT);

    const group = await resolveAutoReplyContact(
      incoming({
        chatId: GROUP,
        isGroup: true,
        message: { sender: "1999991111@lid", senderLid: "1999991111@lid" },
      }),
      { resolvePn: async () => DIRECT },
    );
    expect(group.contactKey).toBe(GROUP);
    expect(group.aliases).toContain(DIRECT);
  });

  it("uses the adapter phone mapping and the account's own ids", async () => {
    const handlers: Array<
      (event: string, instanceId: string, payload: NormalizedMessageEvent) => void
    > = [];
    const enqueueMessage = vi.fn(async () => ({ status: "queued" as const, jobId: "job-1" }));
    const resolvePn = vi.fn(async () => DIRECT);
    const subscription = startAutoReply(
      {
        onAnyEvent: (handler) => {
          handlers.push(handler);
          return () => undefined;
        },
        getInstanceChannel: () => "baileys",
        getAdapter: () =>
          ({
            resolvePn,
            getLifecycleStatus: () => ({ phone: "5511000000000@s.whatsapp.net", lid: null }),
          }) as never,
      },
      { enqueueMessage },
      enabledConfig({ cooldownMs: HOUR_MS }),
      memoryAutoReplyCooldownStore(),
    );

    handlers[0]?.(
      "message.received",
      "inst_auto",
      incoming({
        chatId: "1999991111@lid",
        message: { id: "lid", sender: "1999991111@lid" },
      }),
    );
    await vi.waitFor(() => {
      expect(enqueueMessage).toHaveBeenCalledTimes(1);
    });
    expect(resolvePn).toHaveBeenCalledWith("1999991111@lid");

    handlers[0]?.(
      "message.received",
      "inst_auto",
      incoming({ chatId: DIRECT, message: { id: "pn" } }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(enqueueMessage).toHaveBeenCalledTimes(1);

    handlers[0]?.(
      "message.received",
      "inst_auto",
      incoming({
        chatId: "5511000000000@s.whatsapp.net",
        message: { id: "own", sender: OTHER },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    subscription.stop();
  });
});

describe("auto-reply cooldown table", () => {
  it("survives a new service and is removed with the instance", async () => {
    const instanceId = `test_${randomUUID()}`;
    const now = 1_700_000_000_000;
    db.insert(instances)
      .values({ id: instanceId, name: "auto reply", createdAt: now, updatedAt: now })
      .run();

    try {
      const firstSend = vi.fn(async () => undefined);
      const first = new AutoReplyService(
        enabledConfig({ cooldownMs: HOUR_MS }),
        firstSend,
        () => now,
        sqliteAutoReplyCooldownStore,
      );
      first.handle(instanceId, incoming({}, now));
      await Promise.resolve();
      expect(firstSend).toHaveBeenCalledTimes(1);
      expect(sqliteAutoReplyCooldownStore.load(instanceId, DIRECT)).toBe(now);

      const secondSend = vi.fn(async () => undefined);
      const second = new AutoReplyService(
        enabledConfig({ cooldownMs: HOUR_MS }),
        secondSend,
        () => now + 60_000,
        sqliteAutoReplyCooldownStore,
      );
      second.handle(instanceId, incoming({ message: { id: "restart" } }, now + 60_000));
      expect(secondSend).not.toHaveBeenCalled();
    } finally {
      db.delete(instances).where(eq(instances.id, instanceId)).run();
    }

    expect(sqliteAutoReplyCooldownStore.load(instanceId, DIRECT)).toBeUndefined();
  });

  it("reads last_reply_at without a camelCase alias", () => {
    expect(AUTO_REPLY_COOLDOWN_SELECT_SQL).toBe(
      "SELECT last_reply_at FROM auto_reply_cooldowns WHERE instance_id = ? AND contact_key = ?",
    );
    expect(AUTO_REPLY_COOLDOWN_SELECT_SQL.toLowerCase()).not.toContain(" as ");
    expect(cooldownTimestamp({ last_reply_at: 42 })).toBe(42);
    expect(cooldownTimestamp({ lastreplyat: 42 })).toBeUndefined();
    expect(cooldownTimestamp({ lastReplyAt: 42 })).toBeUndefined();
    expect(AUTO_REPLY_COOLDOWNS_TABLE_SQL).toContain(
      "CREATE TABLE IF NOT EXISTS auto_reply_cooldowns",
    );
    expect(AUTO_REPLY_COOLDOWNS_TABLE_SQL).not.toContain("@");
    expect(AUTO_REPLY_COOLDOWNS_TABLE_SQL).not.toContain("?");
  });
});

describe("message lid fields", () => {
  function message(key: WAMessage["key"]): WAMessage {
    return {
      key,
      message: { conversation: "hello" },
      messageTimestamp: 1_700_000_000,
    } as WAMessage;
  }

  it("keeps the lid on chatLid and senderLid after phone normalization", () => {
    const direct = normalizeMessagesUpsert("inst_auto", {
      type: "notify",
      messages: [
        message({
          id: "pn",
          remoteJid: DIRECT,
          remoteJidAlt: "1999991111@lid",
          fromMe: false,
        }),
      ],
    } as Parameters<typeof normalizeMessagesUpsert>[1])[0];
    expect(direct?.chatId).toBe(DIRECT);
    expect(direct?.chatLid).toBe("1999991111@lid");
    expect(direct?.message.senderLid).toBe("1999991111@lid");

    const swapped = messageIdentityFields(
      message({
        id: "swap",
        remoteJid: "1999991111@lid",
        remoteJidAlt: DIRECT,
        fromMe: false,
      }),
    );
    const swappedEvent = normalizeMessagesUpsert("inst_auto", {
      type: "notify",
      messages: [
        message({
          id: "swap",
          remoteJid: "1999991111@lid",
          remoteJidAlt: DIRECT,
          fromMe: false,
        }),
      ],
    } as Parameters<typeof normalizeMessagesUpsert>[1])[0];
    expect(swapped.chatLid).toBe("1999991111@lid");
    expect(swappedEvent?.chatId).toBe(DIRECT);
    expect(swappedEvent?.chatLid).toBe("1999991111@lid");

    const group = normalizeMessagesUpsert("inst_auto", {
      type: "notify",
      messages: [
        message({
          id: "group",
          remoteJid: GROUP,
          participant: DIRECT,
          participantAlt: "1999991111@lid",
          fromMe: false,
        }),
      ],
    } as Parameters<typeof normalizeMessagesUpsert>[1])[0];
    expect(group?.chatId).toBe(GROUP);
    expect(group?.chatLid).toBeUndefined();
    expect(group?.message.sender).toBe(DIRECT);
    expect(group?.message.senderLid).toBe("1999991111@lid");

    const senderIsLid = messageIdentityFields(
      message({
        id: "sender-lid",
        remoteJid: GROUP,
        participant: "1999991111@lid",
        participantAlt: DIRECT,
        fromMe: false,
      }),
    );
    expect(senderIsLid.senderLid).toBe("1999991111@lid");
    expect(senderIsLid.chatLid).toBeUndefined();
  });
});
