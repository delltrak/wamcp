import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BaileysEventMap, GroupMetadata, WAMessage, WASocket } from "@whiskeysockets/baileys";
import { eq } from "drizzle-orm";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import {
  newsletterMembershipAction,
  newsletterMuteState,
} from "../src/channels/baileys/baileys.events.js";
import { db } from "../src/db/client.js";
import { instances } from "../src/db/schema.js";
import {
  getEventWebhookStatus,
  loadEventWebhookConfig,
} from "../src/services/event-webhook-config.js";
import {
  normalizeEventWebhookPayload,
  normalizeGrokBotRoutineWebhookPayload,
  registerEventWebhookHandler,
  shouldSendEventWebhook,
  type EventWebhookJob,
} from "../src/services/event-webhook.js";
import { InstanceManager } from "../src/services/instance-manager.js";
import type { ChannelEvent, ChannelEventPayload } from "../src/types/channel.types.js";

const ACCOUNT_ID = "5500000000002:1@s.whatsapp.net";
const SELF = "5500000000002@s.whatsapp.net";
const OTHER = "5500000000099@s.whatsapp.net";
const GROUP_ID = "120363000000000119@g.us";
const NEWSLETTER_ID = "120363000000000119@newsletter";
const CREATED_NEWSLETTER_ID = "120363000000000120@newsletter";
const CHAT_ID = "5511999999999@s.whatsapp.net";

const OPTIONAL_EVENTS = [
  "group.joined",
  "label.association",
  "newsletter.joined",
  "newsletter.left",
  "newsletter.message",
  "newsletter.mute",
] as const;

function newsletterMessage(isFromMe = false): ChannelEventPayload["newsletter.message"] {
  return {
    instanceId: "inst_1234abcd",
    newsletterId: NEWSLETTER_ID,
    chatId: NEWSLETTER_ID,
    message: {
      id: "99",
      serverId: "99",
      sender: NEWSLETTER_ID,
      timestamp: 1_700_000_000,
      type: "text",
      text: "channel post",
      views: null,
      isFromMe,
    },
  };
}

function groupMetadata(
  participants: GroupMetadata["participants"],
  overrides: Partial<GroupMetadata> = {},
): GroupMetadata {
  return {
    id: GROUP_ID,
    owner: SELF,
    subject: "Weekend",
    desc: "Plans",
    authorPn: OTHER,
    participants,
    ...overrides,
  };
}

function textMessage(
  id: string,
  chatId: string,
  options: { timestampMs?: number; fromMe?: boolean } = {},
): WAMessage {
  return {
    key: { id, remoteJid: chatId, fromMe: options.fromMe ?? false },
    message: { conversation: `fixture ${id}` },
    messageTimestamp: Math.floor((options.timestampMs ?? Date.now()) / 1000),
  } as WAMessage;
}

interface Fixture {
  instanceId: string;
  adapter: BaileysAdapter;
  socket: WASocket;
  dispatch: (events: Partial<BaileysEventMap>) => Promise<void>;
}

function createFixture(): Fixture {
  const instanceId = `webhook_events_${randomUUID()}`;
  const now = Date.now();
  db.insert(instances)
    .values({
      id: instanceId,
      name: "Webhook events fixture",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  let processEvents: ((events: Partial<BaileysEventMap>) => Promise<void> | void) | undefined;
  const socket = {
    user: { id: ACCOUNT_ID },
    newsletterFollow: vi.fn(async () => undefined),
    newsletterUnfollow: vi.fn(async () => undefined),
    newsletterCreate: vi.fn(async () => ({
      id: CREATED_NEWSLETTER_ID,
      name: "Channel",
      description: "Bio",
    })),
    groupAcceptInvite: vi.fn(async () => GROUP_ID),
    ev: {
      on: vi.fn(),
      process: vi.fn((handler: (events: Partial<BaileysEventMap>) => Promise<void> | void) => {
        processEvents = handler;
      }),
    },
  } as unknown as WASocket;
  const adapter = new BaileysAdapter(instanceId);
  const internals = adapter as unknown as {
    sock: WASocket;
    status: string;
    bindEvents: (sock: WASocket) => void;
  };
  internals.sock = socket;
  internals.status = "connected";
  internals.bindEvents(socket);

  return {
    instanceId,
    adapter,
    socket,
    dispatch: async (events) => {
      if (!processEvents) throw new Error("Baileys event processor was not registered");
      await processEvents(events);
    },
  };
}

function collect<E extends ChannelEvent>(
  adapter: BaileysAdapter,
  event: E,
): ChannelEventPayload[E][] {
  const received: ChannelEventPayload[E][] = [];
  adapter.on(event, (payload) => {
    received.push(payload);
  });
  return received;
}

const createdInstances = new Set<string>();

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const instanceId of createdInstances) {
    db.delete(instances).where(eq(instances.id, instanceId)).run();
  }
  createdInstances.clear();
});

function useFixture(): Fixture {
  const fixture = createFixture();
  createdInstances.add(fixture.instanceId);
  return fixture;
}

describe("newsletter membership helpers", () => {
  it("maps join and leave actions and ignores role changes", () => {
    expect(newsletterMembershipAction(" JOIN ")).toBe("joined");
    expect(newsletterMembershipAction("subscribe")).toBe("joined");
    expect(newsletterMembershipAction("unfollow")).toBe("left");
    expect(newsletterMembershipAction("promote")).toBeNull();
    expect(newsletterMembershipAction("demote")).toBeNull();
  });

  it("reads mute flags and ignores name or description updates", () => {
    expect(newsletterMuteState({ mute: "ON" })).toBe("on");
    expect(newsletterMuteState({ mute_state: "OFF" })).toBe("off");
    expect(newsletterMuteState({ muted: false })).toBe("off");
    expect(newsletterMuteState({ muted: true })).toBe("on");
    expect(newsletterMuteState({ name: "Renamed", description: "About" })).toBeNull();
    expect(newsletterMuteState("ON")).toBeNull();
    expect(newsletterMuteState(null)).toBeNull();
  });
});

describe("optional webhook event selection", () => {
  it("keeps the new events out of the default filter and accepts them when listed", () => {
    const defaults = loadEventWebhookConfig({});
    expect(defaults.events).toEqual(["message.received"]);
    for (const event of OPTIONAL_EVENTS) {
      expect(defaults.events).not.toContain(event);
    }

    const selected = loadEventWebhookConfig({
      WA_EVENT_WEBHOOK_EVENTS: OPTIONAL_EVENTS.join(","),
    });
    expect(selected.events).toEqual([...OPTIONAL_EVENTS]);

    const routine = getEventWebhookStatus({
      WA_EVENT_WEBHOOK_URL: "https://hooks.example.test/receive",
      WA_EVENT_WEBHOOK_PRESET: "grok-bot",
      WA_EVENT_WEBHOOK_EVENTS: "message.received,newsletter.joined,call.received",
    });
    expect(routine.droppedEvents).toEqual(["call.received"]);
    expect(routine.eventCount).toBe(2);
  });

  it("normalizes the new event payloads and applies ignore-from-me only when selected", () => {
    const joined = normalizeEventWebhookPayload("group.joined", "inst_1234abcd", {
      instanceId: "inst_1234abcd",
      groupId: GROUP_ID,
      chatId: GROUP_ID,
      subject: null,
      description: null,
      memberCount: 40,
      author: OTHER,
      timestamp: 1_700_000_100,
    });
    expect(joined).toMatchObject({
      event: "group.joined",
      chat: GROUP_ID,
      subject: null,
      description: null,
      memberCount: 40,
      timestamp: 1_700_000_100,
      text: "Você entrou em um grupo",
    });
    expect(joined).not.toHaveProperty("participants");

    const association = normalizeEventWebhookPayload("label.association", "inst_1234abcd", {
      instanceId: "inst_1234abcd",
      labelId: "label-1",
      labeled: false,
      chatId: CHAT_ID,
      messageId: "message-1",
      label: { id: "label-1", name: "Later", color: 1, deleted: false },
      association: { type: "message", chatId: CHAT_ID, messageId: "message-1" },
    });
    expect(association).toMatchObject({
      event: "label.association",
      chat: CHAT_ID,
      labeled: false,
      labelId: "label-1",
      text: 'Etiqueta "Later" removida',
    });

    const membership = normalizeEventWebhookPayload("newsletter.joined", "inst_1234abcd", {
      instanceId: "inst_1234abcd",
      newsletterId: NEWSLETTER_ID,
      chatId: NEWSLETTER_ID,
      name: null,
      description: null,
      role: "subscriber",
    });
    expect(membership).toMatchObject({
      event: "newsletter.joined",
      chat: NEWSLETTER_ID,
      newsletterId: NEWSLETTER_ID,
      description: null,
      role: "subscriber",
      text: "Você entrou em um canal",
    });
    expect(membership).not.toHaveProperty("name");

    const muted = normalizeEventWebhookPayload("newsletter.mute", "inst_1234abcd", {
      instanceId: "inst_1234abcd",
      newsletterId: NEWSLETTER_ID,
      chatId: NEWSLETTER_ID,
      mute: "on",
    });
    expect(muted).toMatchObject({
      event: "newsletter.mute",
      mute: "on",
      chat: NEWSLETTER_ID,
      text: "Canal silenciado",
    });

    const post = normalizeEventWebhookPayload(
      "newsletter.message",
      "inst_1234abcd",
      newsletterMessage(),
    );
    expect(post).toMatchObject({
      event: "newsletter.message",
      chat: NEWSLETTER_ID,
      text: "channel post",
      serverId: "99",
      views: null,
      newsletterId: NEWSLETTER_ID,
    });
    const emptyPost = newsletterMessage();
    emptyPost.message.text = null;
    expect(
      normalizeEventWebhookPayload("newsletter.message", "inst_1234abcd", emptyPost),
    ).toMatchObject({ text: "Nova mensagem no canal" });
    expect(
      normalizeEventWebhookPayload("newsletter.joined", "inst_1234abcd", {
        instanceId: "inst_1234abcd",
        newsletterId: NEWSLETTER_ID,
        chatId: NEWSLETTER_ID,
        name: "Tech News",
        description: "Atualizações",
        role: "subscriber",
      }),
    ).toMatchObject({ text: "Você entrou no canal Tech News", name: "Tech News" });
    expect(
      normalizeEventWebhookPayload("newsletter.left", "inst_1234abcd", {
        instanceId: "inst_1234abcd",
        newsletterId: NEWSLETTER_ID,
        chatId: NEWSLETTER_ID,
        name: null,
        description: null,
        role: "subscriber",
      }),
    ).toMatchObject({ text: "Você saiu de um canal", role: "subscriber" });
    expect(
      normalizeEventWebhookPayload("newsletter.mute", "inst_1234abcd", {
        instanceId: "inst_1234abcd",
        newsletterId: NEWSLETTER_ID,
        chatId: NEWSLETTER_ID,
        mute: "off",
      }),
    ).toMatchObject({ text: "Canal com som", mute: "off" });
    expect(
      normalizeEventWebhookPayload("group.joined", "inst_1234abcd", {
        instanceId: "inst_1234abcd",
        groupId: GROUP_ID,
        chatId: GROUP_ID,
        subject: "Weekend",
        description: null,
        memberCount: 2,
        author: null,
      }),
    ).toMatchObject({ text: "Você entrou no grupo Weekend", subject: "Weekend" });
    expect(
      normalizeEventWebhookPayload("label.association", "inst_1234abcd", {
        instanceId: "inst_1234abcd",
        labelId: "label-1",
        labeled: true,
        chatId: CHAT_ID,
        label: { id: "label-1", name: "Later", color: 1, deleted: false },
        association: { type: "chat", chatId: CHAT_ID },
      }),
    ).toMatchObject({ text: 'Etiqueta "Later" aplicada', labeled: true });

    const selected = {
      events: [...OPTIONAL_EVENTS],
      ignoreFromMe: true,
    };
    expect(shouldSendEventWebhook("newsletter.message", newsletterMessage(), selected)).toBe(true);
    expect(shouldSendEventWebhook("newsletter.message", newsletterMessage(true), selected)).toBe(
      false,
    );
    expect(
      shouldSendEventWebhook("newsletter.message", newsletterMessage(true), {
        ...selected,
        ignoreFromMe: false,
      }),
    ).toBe(true);
    expect(
      shouldSendEventWebhook(
        "group.joined",
        {
          instanceId: "inst_1234abcd",
          groupId: GROUP_ID,
          chatId: GROUP_ID,
          subject: "Weekend",
          description: null,
          memberCount: 2,
          author: null,
        },
        loadEventWebhookConfig({}),
      ),
    ).toBe(false);
    expect(
      shouldSendEventWebhook(
        "newsletter.joined",
        {
          instanceId: "inst_1234abcd",
          newsletterId: NEWSLETTER_ID,
          chatId: NEWSLETTER_ID,
          name: "Channel",
          description: null,
          role: "subscriber",
        },
        {
          events: ["newsletter.joined"],
          ignoreFromMe: true,
          preset: "grok-bot",
        },
      ),
    ).toBe(true);
    expect(
      shouldSendEventWebhook(
        "newsletter.joined",
        {
          instanceId: "inst_1234abcd",
          newsletterId: NEWSLETTER_ID,
          chatId: NEWSLETTER_ID,
          name: "Channel",
          description: null,
          role: "subscriber",
        },
        {
          events: ["message.received"],
          ignoreFromMe: true,
          preset: "grok-bot",
        },
      ),
    ).toBe(false);
  });
});

describe("webhook delivery of optional events", () => {
  it("enqueues a documented payload only when the event is listed", () => {
    let eventHandler:
      | ((
          event: "newsletter.mute" | "group.joined",
          instanceId: string,
          payload: ChannelEventPayload["newsletter.mute"] | ChannelEventPayload["group.joined"],
        ) => void)
      | undefined;
    const instanceManager = {
      onAnyEvent: (handler: typeof eventHandler) => {
        eventHandler = handler;
        return () => undefined;
      },
    } as unknown as InstanceManager;
    const enqueue = vi.fn((_: EventWebhookJob) => Promise.resolve());
    const listed = loadEventWebhookConfig({
      WA_EVENT_WEBHOOK_URL: "https://hooks.example.test/receive",
      WA_EVENT_WEBHOOK_EVENTS: "newsletter.mute",
      WA_EVENT_WEBHOOK_PRESET: "grok-bot",
    });
    const unsubscribe = registerEventWebhookHandler(instanceManager, listed, enqueue);
    eventHandler?.("group.joined", "inst_1234abcd", {
      instanceId: "inst_1234abcd",
      groupId: GROUP_ID,
      chatId: GROUP_ID,
      subject: "Weekend",
      description: null,
      memberCount: 12,
      author: null,
    });
    eventHandler?.("newsletter.mute", "inst_1234abcd", {
      instanceId: "inst_1234abcd",
      newsletterId: NEWSLETTER_ID,
      chatId: NEWSLETTER_ID,
      mute: "on",
      timestamp: 1_700_000_200,
    });
    expect(enqueue).toHaveBeenCalledOnce();
    const delivered = enqueue.mock.calls[0]?.[0].payload;
    expect(delivered).toMatchObject({
      event: "newsletter.mute",
      instanceId: "inst_1234abcd",
      chatId: NEWSLETTER_ID,
      senderId: null,
      messageId: "",
      isGroup: false,
      type: "newsletter.mute",
      text: "Canal silenciado",
      timestamp: 1_700_000_200,
      mute: "on",
      newsletterId: NEWSLETTER_ID,
    });
    expect(delivered).not.toHaveProperty("chat");
    expect(delivered).not.toHaveProperty("participants");
    unsubscribe();
  });

  it("keeps the standard body when the grok-bot preset is off", () => {
    const standard = normalizeEventWebhookPayload("newsletter.mute", "inst_1234abcd", {
      instanceId: "inst_1234abcd",
      newsletterId: NEWSLETTER_ID,
      chatId: NEWSLETTER_ID,
      mute: "on",
    });
    expect(standard).toMatchObject({
      event: "newsletter.mute",
      chat: NEWSLETTER_ID,
      sender: null,
      text: "Canal silenciado",
      timestamp: null,
    });
    expect(standard).not.toHaveProperty("chatId");

    const observed = 1_700_000_300;
    const grok = normalizeGrokBotRoutineWebhookPayload("group.joined", "inst_1234abcd", {
      instanceId: "inst_1234abcd",
      groupId: GROUP_ID,
      chatId: GROUP_ID,
      subject: "Weekend",
      description: null,
      memberCount: 12,
      author: OTHER,
      timestamp: observed,
    });
    expect(grok).toMatchObject({
      event: "group.joined",
      chatId: GROUP_ID,
      senderId: OTHER,
      messageId: "",
      timestamp: observed,
      memberCount: 12,
      isGroup: true,
      text: "Você entrou no grupo Weekend",
    });
    expect(grok).not.toHaveProperty("participants");

    const post = normalizeGrokBotRoutineWebhookPayload(
      "newsletter.message",
      "inst_1234abcd",
      newsletterMessage(),
    );
    expect(post.timestamp).toBe(1_700_000_000);
    expect(post.messageId).toBe("99");
    expect(post.chatId).toBe(NEWSLETTER_ID);
    expect(post.senderId).toBe(NEWSLETTER_ID);
  });
});

describe("Baileys optional webhook events", () => {
  it("emits label.association without dropping label.updated", async () => {
    const { adapter, dispatch } = useFixture();
    const updated = collect(adapter, "label.updated");
    const associated = collect(adapter, "label.association");

    await dispatch({
      "labels.association": {
        type: "add",
        association: { type: "label_jid", chatId: CHAT_ID, labelId: "synced-label" },
      },
    });

    expect(updated).toEqual([
      expect.objectContaining({
        action: "associated",
        chatId: CHAT_ID,
      }),
    ]);
    expect(associated).toEqual([
      expect.objectContaining({
        labelId: "synced-label",
        labeled: true,
        chatId: CHAT_ID,
        association: { type: "chat", chatId: CHAT_ID },
      }),
    ]);
  });

  it("emits group.joined only when this account is in a non-empty roster", async () => {
    const { adapter, dispatch, socket } = useFixture();
    const joined = collect(adapter, "group.joined");

    await dispatch({
      "groups.upsert": [
        groupMetadata([{ id: SELF }, { id: OTHER }, { id: "5511000000003@s.whatsapp.net" }]),
        groupMetadata([{ id: OTHER }], { id: "120363000000000120@g.us", subject: "Other" }),
        groupMetadata([], { id: "120363000000000121@g.us", subject: "Empty roster" }),
      ],
    });
    socket.user = undefined;
    await dispatch({
      "groups.upsert": [groupMetadata([{ id: SELF }], { id: "120363000000000122@g.us" })],
    });

    expect(joined.map((event) => event.groupId)).toEqual([GROUP_ID]);
    expect(joined[0]).toMatchObject({
      subject: "Weekend",
      description: "Plans",
      memberCount: 3,
      author: OTHER,
      chatId: GROUP_ID,
    });
    expect(joined[0]).not.toHaveProperty("participants");
    expect(JSON.stringify(joined[0])).not.toContain(SELF);
    expect(JSON.stringify(joined[0])).not.toContain("5511000000003");
  });

  it("emits group.joined for an add of this account and not for someone else", async () => {
    const { adapter, dispatch } = useFixture();
    const changed = collect(adapter, "group.participants_changed");
    const joined = collect(adapter, "group.joined");

    await dispatch({
      "group-participants.update": {
        id: GROUP_ID,
        author: OTHER,
        authorPn: OTHER,
        participants: [{ id: OTHER }],
        action: "add",
      },
    });
    await dispatch({
      "group-participants.update": {
        id: GROUP_ID,
        author: OTHER,
        authorPn: "5500000000099:1@s.whatsapp.net",
        participants: [{ id: SELF }],
        action: "add",
      },
    });

    expect(changed.map((event) => event.participants)).toEqual([[OTHER], [SELF]]);
    expect(joined).toEqual([
      expect.objectContaining({
        groupId: GROUP_ID,
        subject: null,
        description: null,
        memberCount: 1,
        author: "5500000000099:1@s.whatsapp.net",
      }),
    ]);
    expect(joined[0]).not.toHaveProperty("participants");
  });

  it("emits newsletter membership for this account and ignores promote or other users", async () => {
    const { adapter, dispatch } = useFixture();
    const joined = collect(adapter, "newsletter.joined");
    const left = collect(adapter, "newsletter.left");

    await dispatch({
      "newsletter-participants.update": {
        id: NEWSLETTER_ID,
        author: OTHER,
        user: SELF,
        new_role: "subscriber",
        action: "join",
      },
    });
    await dispatch({
      "newsletter-participants.update": {
        id: NEWSLETTER_ID,
        author: OTHER,
        user: OTHER,
        new_role: "subscriber",
        action: "join",
      },
    });
    await dispatch({
      "newsletter-participants.update": {
        id: NEWSLETTER_ID,
        author: OTHER,
        user: SELF,
        new_role: "admin",
        action: "promote",
      },
    });
    await dispatch({
      "newsletter-participants.update": {
        id: NEWSLETTER_ID,
        author: OTHER,
        user: SELF,
        new_role: "",
        action: "leave",
      },
    });

    expect(joined).toEqual([
      expect.objectContaining({
        newsletterId: NEWSLETTER_ID,
        role: "subscriber",
        name: null,
      }),
    ]);
    expect(left).toEqual([expect.objectContaining({ newsletterId: NEWSLETTER_ID, role: null })]);
  });

  it("emits newsletter.mute only when the settings update carries a mute flag", async () => {
    const { adapter, dispatch } = useFixture();
    const muted = collect(adapter, "newsletter.mute");

    await dispatch({
      "newsletter-settings.update": {
        id: NEWSLETTER_ID,
        update: { name: "Renamed", description: "About" },
      },
    });
    await dispatch({
      "newsletter-settings.update": {
        id: NEWSLETTER_ID,
        update: { mute: "ON" },
      },
    });
    await dispatch({
      "newsletter-settings.update": {
        id: "not-a-newsletter",
        update: { mute: "OFF" },
      },
    });

    expect(muted).toEqual([
      expect.objectContaining({ newsletterId: NEWSLETTER_ID, mute: "on", chatId: NEWSLETTER_ID }),
    ]);
  });

  it("emits newsletter.message for fresh posts without stealing message.received", async () => {
    const { adapter, dispatch } = useFixture();
    const posts = collect(adapter, "newsletter.message");
    const received = collect(adapter, "message.received");
    const now = Date.now();

    await dispatch({
      "messages.upsert": {
        type: "append",
        messages: [
          textMessage("append-fresh", NEWSLETTER_ID, { timestampMs: now - 60_000 }),
          textMessage("append-old", NEWSLETTER_ID, { timestampMs: now - 25 * 60 * 60_000 }),
          textMessage("append-direct", CHAT_ID, { timestampMs: now - 60_000 }),
        ],
      },
    });
    await dispatch({
      "messages.upsert": {
        type: "append",
        messages: [textMessage("append-fresh", NEWSLETTER_ID, { timestampMs: now - 60_000 })],
      },
    });
    await dispatch({
      "messages.upsert": {
        type: "notify",
        messages: [textMessage("99", NEWSLETTER_ID, { timestampMs: now })],
      },
    });

    expect(posts.map((event) => event.message.id)).toEqual(["append-fresh", "99"]);
    expect(posts[0]?.message).toMatchObject({
      serverId: null,
      text: "fixture append-fresh",
      views: null,
      isFromMe: false,
    });
    expect(posts[1]?.message.serverId).toBe("99");
    expect(received.map((event) => event.message.id)).toEqual(["append-direct", "99"]);
  });

  it.each(["notify", "append"] as const)(
    "deduplicates %s newsletter posts by channel and message ID",
    async (type) => {
      const { instanceId, adapter, dispatch } = useFixture();
      const posts = collect(adapter, "newsletter.message");
      const manager = new InstanceManager();
      (
        manager as unknown as {
          bindAdapterEvents: (id: string, source: BaileysAdapter) => void;
        }
      ).bindAdapterEvents(instanceId, adapter);
      const enqueue = vi.fn((_: EventWebhookJob) => Promise.resolve());
      const unsubscribe = registerEventWebhookHandler(
        manager,
        loadEventWebhookConfig({
          WA_EVENT_WEBHOOK_URL: "https://hooks.example.test/receive",
          WA_EVENT_WEBHOOK_EVENTS: "newsletter.message",
          WA_EVENT_WEBHOOK_PRESET: "grok-bot",
        }),
        enqueue,
      );
      for (const chatId of [
        NEWSLETTER_ID,
        CREATED_NEWSLETTER_ID,
        NEWSLETTER_ID,
        CREATED_NEWSLETTER_ID,
      ]) {
        await dispatch({
          "messages.upsert": { type, messages: [textMessage("99", chatId)] },
        });
      }
      await dispatch({
        "messages.upsert": {
          type: type === "append" ? "notify" : "append",
          messages: [textMessage("99", NEWSLETTER_ID), textMessage("99", CREATED_NEWSLETTER_ID)],
        },
      });
      await unsubscribe.flush();
      unsubscribe();
      expect(posts.map((event) => [event.newsletterId, event.message.id])).toEqual([
        [NEWSLETTER_ID, "99"],
        [CREATED_NEWSLETTER_ID, "99"],
      ]);
      expect(enqueue.mock.calls.map(([job]) => job.payload)).toEqual([
        expect.objectContaining({
          event: "newsletter.message",
          newsletterId: NEWSLETTER_ID,
          messageId: "99",
        }),
        expect.objectContaining({
          event: "newsletter.message",
          newsletterId: CREATED_NEWSLETTER_ID,
          messageId: "99",
        }),
      ]);
    },
  );

  it("skips recent stored newsletter history on append after upgrading", async () => {
    const { adapter, dispatch } = useFixture();
    const posts = collect(adapter, "newsletter.message");
    const stored = textMessage("stored-post", NEWSLETTER_ID);
    await dispatch({
      "messaging-history.set": {
        contacts: [],
        chats: [],
        messages: [stored],
        isLatest: false,
        progress: 100,
        syncType: 0,
        peerDataRequestSessionId: null,
      },
    });
    await dispatch({
      "messages.upsert": {
        type: "append",
        messages: [stored, textMessage("new-post", NEWSLETTER_ID)],
      },
    });
    expect(posts.map((event) => event.message.id)).toEqual(["new-post"]);
  });

  it("does not emit newsletter.message from history sync", async () => {
    const { adapter, dispatch } = useFixture();
    const posts = collect(adapter, "newsletter.message");

    await dispatch({
      "messaging-history.set": {
        contacts: [],
        chats: [],
        messages: [textMessage("history-post", NEWSLETTER_ID)],
        isLatest: false,
        progress: 100,
        syncType: 0,
        peerDataRequestSessionId: null,
      },
    });

    expect(posts).toEqual([]);
  });

  it("does not emit group.joined for a local invite or a group this account creates", async () => {
    vi.stubEnv("WA_GROUP_WRITES_ENABLED", "true");
    const { adapter, socket } = useFixture();
    const joined = collect(adapter, "group.joined");
    socket.groupCreate = vi.fn(async () => ({ id: "120363000000000130@g.us" }));

    await adapter.joinGroup("AbCdEfGh");
    await adapter.createGroup("Created", [OTHER]);

    expect(joined).toEqual([]);
  });

  it("treats phone mute and follow as best-effort on rc14", async () => {
    const { adapter, dispatch } = useFixture();
    const muted = collect(adapter, "newsletter.mute");
    const joined = collect(adapter, "newsletter.joined");

    await dispatch({
      "newsletter-settings.update": {
        id: NEWSLETTER_ID,
        update: { name: "From phone", description: "Only name and description" },
      },
    });
    await dispatch({
      "newsletter-settings.update": {
        id: NEWSLETTER_ID,
        update: { follow: true, subscribed: true },
      },
    });
    await dispatch({
      "newsletter-settings.update": {
        id: NEWSLETTER_ID,
        update: { mute_state: "ON" },
      },
    });

    expect(joined).toEqual([]);
    expect(muted).toEqual([expect.objectContaining({ newsletterId: NEWSLETTER_ID, mute: "on" })]);
    expect(
      newsletterMuteState({ name: "From phone", description: "Only name and description" }),
    ).toBe(null);
  });

  it("emits local follow, unfollow, create, and a later roster join once across a protocol echo", async () => {
    vi.stubEnv("WA_GROUP_WRITES_ENABLED", "true");
    const { adapter, socket, dispatch } = useFixture();
    const joined = collect(adapter, "newsletter.joined");
    const left = collect(adapter, "newsletter.left");
    const groups = collect(adapter, "group.joined");

    await adapter.newsletterFollow(NEWSLETTER_ID);
    await dispatch({
      "newsletter-participants.update": {
        id: NEWSLETTER_ID,
        author: SELF,
        user: SELF,
        new_role: "subscriber",
        action: "join",
      },
    });
    await adapter.newsletterUnfollow(NEWSLETTER_ID);
    const created = await adapter.createNewsletter("Channel", "Bio");
    const groupId = await adapter.joinGroup("AbCdEfGh");
    await dispatch({
      "groups.upsert": [groupMetadata([{ id: SELF }])],
    });

    expect(socket.newsletterFollow).toHaveBeenCalledWith(NEWSLETTER_ID);
    expect(created).toMatchObject({ id: CREATED_NEWSLETTER_ID, name: "Channel" });
    expect(groupId).toBe(GROUP_ID);
    expect(joined.map((event) => [event.newsletterId, event.role])).toEqual([
      [NEWSLETTER_ID, "subscriber"],
      [CREATED_NEWSLETTER_ID, "owner"],
    ]);
    expect(joined[1]).toMatchObject({ name: "Channel", description: "Bio", role: "owner" });
    expect(left).toHaveLength(1);
    expect(groups).toHaveLength(1);
  });

  it("does not emit membership when group writes are disabled", async () => {
    const { adapter } = useFixture();
    const joined = collect(adapter, "newsletter.joined");

    await expect(adapter.newsletterFollow(NEWSLETTER_ID)).rejects.toThrow(/disabled/);
    expect(joined).toEqual([]);
  });
});
