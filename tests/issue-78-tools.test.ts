import { createCipheriv, createHash, createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BufferJSON,
  generateWAMessage,
  proto,
  type BaileysEventMap,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MessageContent } from "../src/types/channel.types.js";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { CloudApiAdapter } from "../src/channels/cloud-api/cloud.adapter.js";
import { sqlite } from "../src/db/client.js";
import { registerMessagingTools } from "../src/tools/messaging.tools.js";
import { registerGroupTools } from "../src/tools/group.tools.js";
import { registerProfileTools } from "../src/tools/profile.tools.js";
import { MediaService } from "../src/services/media.js";
import type { ContactStore } from "../src/services/contact-store.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import type { MessageQueue } from "../src/services/message-queue.js";
import type { z } from "zod";

const ACCOUNT_ID = "5500000000002@s.whatsapp.net";
const ACCOUNT_LID = "9000000000002@lid";
const POLL_CREATOR = "5500000000010@s.whatsapp.net";
const VOTER = "5500000000011@s.whatsapp.net";
const VOTER_LID = "9000000000011@lid";
const SECOND_VOTER = "5500000000012@s.whatsapp.net";
const SECOND_VOTER_LID = "9000000000012@lid";
const THIRD_VOTER = "5500000000013@s.whatsapp.net";
const GROUP_ID = "120363000000000001@g.us";
const CONTACT_ID = "5500000000003@s.whatsapp.net";
const initialAppStateWritesEnabled = process.env.WA_APP_STATE_WRITES_ENABLED;

type RegisteredTool = {
  inputSchema: z.ZodType;
  handler: (params: unknown) => Promise<unknown>;
};

type ToolResponse = {
  isError?: boolean;
  content: Array<{ text?: string }>;
};

function messageForSend(jid: string, content: unknown): WAMessage {
  const payload = content as Record<string, unknown>;
  let message: WAMessage["message"] = {};
  if (payload.poll && typeof payload.poll === "object") {
    const poll = payload.poll as { name: string; values: string[]; selectableCount: number };
    message = {
      pollCreationMessageV3: {
        name: poll.name,
        selectableOptionsCount: poll.selectableCount,
        options: poll.values.map((optionName) => ({ optionName })),
      },
      messageContextInfo: { messageSecret: Buffer.alloc(32, 0x42) },
    };
  } else if (payload.audio !== undefined) {
    message = { audioMessage: { mimetype: "audio/ogg; codecs=opus" } };
  } else if (payload.image !== undefined) {
    message = { imageMessage: {} };
  } else if (payload.video !== undefined) {
    message = { videoMessage: {} };
  } else if (payload.location && typeof payload.location === "object") {
    message = {
      locationMessage: payload.location as NonNullable<WAMessage["message"]>["locationMessage"],
    };
  } else if (payload.contacts && typeof payload.contacts === "object") {
    message = {
      contactsArrayMessage: payload.contacts as NonNullable<
        WAMessage["message"]
      >["contactsArrayMessage"],
    };
  } else if (payload.groupInvite && typeof payload.groupInvite === "object") {
    message = {
      groupInviteMessage: payload.groupInvite as NonNullable<
        WAMessage["message"]
      >["groupInviteMessage"],
    };
  } else if (typeof payload.text === "string") {
    message = { conversation: payload.text };
  }
  return {
    key: { remoteJid: jid, id: `sent-${randomUUID()}`, fromMe: true },
    message,
    messageTimestamp: Math.floor(Date.now() / 1000),
  } as WAMessage;
}

function encryptPollVote(
  messageSecret: Uint8Array,
  pollMessageId: string,
  pollCreatorJid: string,
  voterJid: string,
  options: string[],
): { encPayload: Uint8Array; encIv: Uint8Array } {
  const sign = Buffer.concat([
    Buffer.from(pollMessageId),
    Buffer.from(pollCreatorJid),
    Buffer.from(voterJid),
    Buffer.from("Poll Vote"),
    Buffer.from([1]),
  ]);
  const key0 = createHmac("sha256", Buffer.alloc(32)).update(messageSecret).digest();
  const encryptionKey = createHmac("sha256", key0).update(sign).digest();
  const iv = Buffer.alloc(12, 0x31);
  const aad = Buffer.from(`${pollMessageId}\u0000${voterJid}`);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(aad);
  const selectedOptions = options.map((option) =>
    createHash("sha256").update(Buffer.from(option)).digest(),
  );
  const encoded = proto.Message.PollVoteMessage.encode({ selectedOptions }).finish();
  const encPayload = Buffer.concat([cipher.update(encoded), cipher.final(), cipher.getAuthTag()]);
  return { encPayload, encIv: iv };
}

function oggOpusFixture(): Buffer {
  const audio = Buffer.alloc(47);
  audio.write("OggS", 0, "ascii");
  audio[26] = 1;
  audio[27] = 19;
  audio.write("OpusHead", 28, "ascii");
  return audio;
}

function m4aFixture(): Buffer {
  const audio = Buffer.alloc(24);
  audio.writeUInt32BE(audio.length, 0);
  audio.write("ftyp", 4, "ascii");
  audio.write("M4A ", 8, "ascii");
  audio.write("M4A ", 16, "ascii");
  return audio;
}

function groupMetadata() {
  return {
    id: GROUP_ID,
    subject: "Planning group",
    desc: "Meeting plans",
    owner: ACCOUNT_ID,
    creation: 1_700_000_000,
    participants: [{ id: ACCOUNT_ID, admin: "admin" }],
  };
}

describe("issue 78 messaging and group features", () => {
  const activeInstanceIds = new Set<string>();

  beforeEach(() => {
    process.env.WA_APP_STATE_WRITES_ENABLED = "true";
  });

  afterEach(() => {
    for (const instanceId of activeInstanceIds) {
      sqlite.prepare("DELETE FROM instances WHERE id = ?").run(instanceId);
    }
    activeInstanceIds.clear();
    vi.restoreAllMocks();
    if (initialAppStateWritesEnabled === undefined) delete process.env.WA_APP_STATE_WRITES_ENABLED;
    else process.env.WA_APP_STATE_WRITES_ENABLED = initialAppStateWritesEnabled;
  });

  function createFixture(extraSocket: Record<string, unknown> = {}) {
    const instanceId = `issue-78-${randomUUID()}`;
    activeInstanceIds.add(instanceId);
    sqlite
      .prepare(
        "INSERT INTO instances (id, name, channel, status, created_at, updated_at) VALUES (?, ?, 'baileys', 'connected', 1, 1)",
      )
      .run(instanceId, "Issue 78 simulated instance");

    let processEvents: ((events: Partial<BaileysEventMap>) => Promise<void> | void) | undefined;
    const socket = {
      user: { id: ACCOUNT_ID },
      sendMessage: vi.fn(async (jid: string, content: unknown) => messageForSend(jid, content)),
      chatModify: vi.fn(),
      appPatch: vi.fn(),
      groupCreate: vi.fn(async () => ({
        id: GROUP_ID,
        subject: "Planning group",
        participants: [],
      })),
      groupParticipantsUpdate: vi.fn(async () => []),
      groupUpdateSubject: vi.fn(async () => undefined),
      groupUpdateDescription: vi.fn(async () => undefined),
      groupSettingUpdate: vi.fn(async () => undefined),
      groupInviteCode: vi.fn(async () => "invite-code-78"),
      groupRevokeInvite: vi.fn(async () => "replacement-code-78"),
      groupAcceptInvite: vi.fn(async () => GROUP_ID),
      groupGetInviteInfo: vi.fn(async () => groupMetadata()),
      groupRequestParticipantsList: vi.fn(async () => [{ jid: VOTER, t: "1700000123" }]),
      groupMetadata: vi.fn(async () => groupMetadata()),
      profilePictureUrl: vi.fn(async () => "https://example.test/profile.jpg"),
      updateProfilePicture: vi.fn(async () => undefined),
      removeProfilePicture: vi.fn(async () => undefined),
      ev: {
        on: vi.fn(),
        process: vi.fn((handler: (events: Partial<BaileysEventMap>) => Promise<void> | void) => {
          processEvents = handler;
          return vi.fn();
        }),
      },
      ...extraSocket,
    } as unknown as WASocket;
    const adapter = new BaileysAdapter(instanceId, {
      getContacts: vi.fn(() => []),
      handleHistorySync: vi.fn(async () => undefined),
    } as unknown as ContactStore);
    const internals = adapter as unknown as {
      sock: WASocket;
      status: "connected";
      bindEvents: (sock: WASocket) => void;
    };
    internals.sock = socket;
    internals.status = "connected";
    internals.bindEvents(socket);

    const tools = new Map<string, RegisteredTool>();
    const server = {
      registerTool: (name: string, options: unknown, handler: unknown) => {
        tools.set(name, {
          inputSchema: (options as { inputSchema: z.ZodType }).inputSchema,
          handler: handler as (params: unknown) => Promise<unknown>,
        });
      },
    } as unknown as McpServer;
    const instanceManager = {
      getAdapter: () => adapter,
      getInstanceChannel: () => "baileys",
    } as unknown as InstanceManager;
    const queue = {
      enqueueMessage: async (_id: string, to: string, content: MessageContent) =>
        adapter.sendMessage(to, content),
    } as unknown as MessageQueue;
    registerMessagingTools(server, instanceManager, queue);
    registerGroupTools(server, instanceManager, queue);
    registerProfileTools(server, instanceManager, queue);

    const invoke = async (name: string, params: unknown): Promise<ToolResponse> => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Missing registered tool ${name}`);
      const parsed = tool.inputSchema.parse({ instanceId, ...((params ?? {}) as object) });
      return (await tool.handler(parsed)) as ToolResponse;
    };
    return {
      instanceId,
      adapter,
      socket,
      invoke,
      processEvents: (events: Partial<BaileysEventMap>) => {
        if (!processEvents) throw new Error("Baileys event processor was not registered");
        return processEvents(events);
      },
    };
  }

  it("decrypts poll votes when the stored poll secret uses legacy base64", async () => {
    const { instanceId, invoke, processEvents } = createFixture();
    const secret = Buffer.alloc(32, 0x77);
    const pollMessageId = "stored-poll-78";
    const pollMessage: WAMessage = {
      key: { remoteJid: GROUP_ID, id: pollMessageId, fromMe: false, participant: POLL_CREATOR },
      message: {
        pollCreationMessageV3: {
          name: "Dinner?",
          selectableOptionsCount: 1,
          options: [{ optionName: "Pizza" }, { optionName: "Sushi" }],
        },
        messageContextInfo: { messageSecret: secret },
      },
      messageTimestamp: 1_700_000_100,
    } as WAMessage;
    await processEvents({ "messages.upsert": { type: "notify", messages: [pollMessage] } });

    const savedPoll = sqlite
      .prepare("SELECT raw_data FROM messages WHERE instance_id = ? AND id = ?")
      .get(instanceId, pollMessageId) as { raw_data: string };
    expect(JSON.parse(savedPoll.raw_data, (key, value) => value)).toMatchObject({
      message: { messageContextInfo: expect.any(Object) },
    });
    const legacyPoll = JSON.parse(savedPoll.raw_data) as {
      message: { messageContextInfo: { messageSecret: unknown } };
    };
    legacyPoll.message.messageContextInfo.messageSecret = secret.toString("base64");
    sqlite
      .prepare("UPDATE messages SET raw_data = ? WHERE instance_id = ? AND id = ?")
      .run(JSON.stringify(legacyPoll), instanceId, pollMessageId);

    const pollCreationMessageKey = {
      remoteJid: GROUP_ID,
      id: pollMessageId,
      fromMe: false,
      participant: POLL_CREATOR,
    };
    const encryptedVote = encryptPollVote(secret, pollMessageId, POLL_CREATOR, VOTER, ["Sushi"]);
    const voteMessage: WAMessage = {
      key: { remoteJid: GROUP_ID, id: "poll-vote-78", fromMe: false, participant: VOTER },
      message: { pollUpdateMessage: { pollCreationMessageKey, vote: encryptedVote } },
      messageTimestamp: 1_700_000_101,
    } as WAMessage;
    await processEvents({ "messages.upsert": { type: "notify", messages: [voteMessage] } });

    const response = await invoke("wa_get_poll_results", {
      chatId: GROUP_ID,
      messageId: pollMessageId,
    });
    const results = JSON.parse(response.content[0]?.text ?? "{}") as {
      question: string;
      totalVotes: number;
      totalVoters: number;
      options: Array<{ name: string; count: number; voters: string[] }>;
    };
    expect(results).toMatchObject({ question: "Dinner?", totalVotes: 1, totalVoters: 1 });
    expect(results.options).toEqual([
      { name: "Pizza", count: 0, voters: [] },
      { name: "Sushi", count: 1, voters: [VOTER] },
    ]);
    const savedVotes = sqlite
      .prepare("SELECT raw_data FROM messages WHERE instance_id = ? AND id = ?")
      .get(instanceId, pollMessageId) as { raw_data: string };
    expect(savedVotes.raw_data).toContain("pollUpdates");
  });

  it("decrypts history-fetched poll votes and retries votes that arrive before their poll", async () => {
    const { instanceId, invoke, processEvents } = createFixture();
    const secret = Buffer.alloc(32, 0x78);
    const pollMessageId = "history-poll-vote-78";
    const pollCreationMessageKey = {
      remoteJid: GROUP_ID,
      id: pollMessageId,
      fromMe: false,
      participant: POLL_CREATOR,
    };
    const voteMessage: WAMessage = {
      key: {
        remoteJid: GROUP_ID,
        id: "history-poll-vote-message-78",
        fromMe: false,
        participant: VOTER,
      },
      message: {
        pollUpdateMessage: {
          pollCreationMessageKey,
          vote: encryptPollVote(secret, pollMessageId, POLL_CREATOR, VOTER, ["Sushi"]),
        },
      },
      messageTimestamp: 1_700_000_201,
    } as WAMessage;
    const pollMessage: WAMessage = {
      key: { remoteJid: GROUP_ID, id: pollMessageId, fromMe: false, participant: POLL_CREATOR },
      message: {
        pollCreationMessageV3: {
          name: "History dinner?",
          selectableOptionsCount: 1,
          options: [{ optionName: "Pizza" }, { optionName: "Sushi" }],
        },
        messageContextInfo: { messageSecret: secret },
      },
      messageTimestamp: 1_700_000_200,
    } as WAMessage;

    await processEvents({
      "messaging-history.set": {
        contacts: [],
        chats: [],
        messages: [voteMessage, pollMessage],
        syncType: proto.HistorySync.HistorySyncType.ON_DEMAND,
        peerDataRequestSessionId: "poll-history-request",
      },
    });

    const response = await invoke("wa_get_poll_results", {
      chatId: GROUP_ID,
      messageId: pollMessageId,
    });
    const results = JSON.parse(response.content[0]?.text ?? "{}") as {
      question: string;
      totalVotes: number;
      totalVoters: number;
      options: Array<{ name: string; count: number; voters: string[] }>;
    };
    expect(results).toMatchObject({ question: "History dinner?", totalVotes: 1, totalVoters: 1 });
    expect(results.options).toEqual([
      { name: "Pizza", count: 0, voters: [] },
      { name: "Sushi", count: 1, voters: [VOTER] },
    ]);
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM pending_poll_votes WHERE instance_id = ?")
        .get(instanceId),
    ).toMatchObject({ count: 0 });
  });

  it("sends single-select polls with their message secret stored", async () => {
    const { instanceId, socket, invoke } = createFixture();
    const response = await invoke("wa_send_poll", {
      to: GROUP_ID,
      question: "Lunch?",
      options: ["A", "B"],
    });
    const sent = JSON.parse(response.content[0]?.text ?? "{}") as { messageId: string };
    const call = vi.mocked(socket.sendMessage).mock.calls[0];
    expect(call?.[1]).toMatchObject({
      poll: { name: "Lunch?", values: ["A", "B"], selectableCount: 1 },
    });
    const saved = sqlite
      .prepare("SELECT raw_data FROM messages WHERE instance_id = ? AND id = ?")
      .get(instanceId, sent.messageId) as { raw_data: string };
    expect(saved.raw_data).toContain("messageSecret");
  });

  it("decrypts real votes on polls sent by this account across LID and PN key variants", async () => {
    const pollMessageId = "real-crypto-sent-poll-78";
    const sendMessage = vi.fn(async (jid: string, content: unknown) =>
      generateWAMessage(jid, content as Parameters<typeof generateWAMessage>[1], {
        userJid: ACCOUNT_LID,
        messageId: pollMessageId,
      }),
    );
    const lidToPn = new Map([
      [ACCOUNT_LID, ACCOUNT_ID],
      [VOTER_LID, VOTER],
      [SECOND_VOTER_LID, SECOND_VOTER],
    ]);
    const pnToLid = new Map([...lidToPn].map(([lid, pn]) => [pn, lid]));
    const { instanceId, invoke, processEvents } = createFixture({
      user: { id: ACCOUNT_ID, lid: ACCOUNT_LID },
      signalRepository: {
        lidMapping: {
          getPNForLID: vi.fn(async (lid: string) => lidToPn.get(lid) ?? null),
          getLIDForPN: vi.fn(async (pn: string) => pnToLid.get(pn) ?? null),
        },
      },
      sendMessage,
    });

    const sent = await invoke("wa_send_poll", {
      to: GROUP_ID,
      question: "Real crypto?",
      options: ["Yes", "No"],
    });
    const sentResult = JSON.parse(sent.content[0]?.text ?? "{}") as { messageId: string };
    expect(sentResult.messageId).toBe(pollMessageId);
    const storedPollRow = sqlite
      .prepare("SELECT type, raw_data FROM messages WHERE instance_id = ? AND id = ?")
      .get(instanceId, pollMessageId) as { type: string; raw_data: string };
    expect(storedPollRow.type).toBe("poll");
    const storedPoll = JSON.parse(storedPollRow.raw_data, BufferJSON.reviver) as WAMessage;
    const messageSecret = storedPoll.message?.messageContextInfo?.messageSecret;
    expect(messageSecret).toBeInstanceOf(Uint8Array);
    expect(messageSecret?.byteLength).toBe(32);

    const createVote = (
      id: string,
      voterJid: string,
      voterAltJid: string,
      creatorJid: string,
      creatorAltJid: string,
      encryptedVoterJid: string,
      encryptedCreatorJid: string,
      wrapped = false,
    ): WAMessage => {
      const pollUpdateMessage = {
        pollCreationMessageKey: {
          remoteJid: GROUP_ID,
          id: pollMessageId,
          fromMe: false,
          participant: creatorJid,
          participantAlt: creatorAltJid,
        },
        vote: encryptPollVote(
          messageSecret!,
          pollMessageId,
          encryptedCreatorJid,
          encryptedVoterJid,
          ["Yes"],
        ),
      };
      const voteContent = wrapped
        ? {
            ephemeralMessage: {
              message: {
                viewOnceMessage: {
                  message: {
                    deviceSentMessage: { message: { pollUpdateMessage } },
                  },
                },
              },
            },
          }
        : { pollUpdateMessage };
      return {
        key: {
          remoteJid: GROUP_ID,
          id,
          fromMe: false,
          participant: voterJid,
          participantAlt: voterAltJid,
        },
        message: voteContent,
        messageTimestamp: 1_800_000_000,
      } as unknown as WAMessage;
    };

    const votes = [
      // The actual crypto uses LIDs even though the PN aliases are present and preferred by
      // Baileys' single getKeyAuthor() lookup. This first update is also deeply wrapped.
      createVote(
        "real-crypto-vote-lid-lid",
        VOTER_LID,
        VOTER,
        ACCOUNT_LID,
        ACCOUNT_ID,
        VOTER_LID,
        ACCOUNT_LID,
        true,
      ),
      // The poll key's aliases are reversed, and only the voter is encrypted as a LID.
      createVote(
        "real-crypto-vote-pn-lid",
        SECOND_VOTER_LID,
        SECOND_VOTER,
        ACCOUNT_ID,
        ACCOUNT_LID,
        SECOND_VOTER_LID,
        ACCOUNT_ID,
      ),
      // This PN/PN combination matches Baileys' preferred aliases without a fallback.
      createVote(
        "real-crypto-vote-pn-pn",
        THIRD_VOTER,
        THIRD_VOTER,
        ACCOUNT_LID,
        ACCOUNT_ID,
        THIRD_VOTER,
        ACCOUNT_ID,
      ),
    ];
    await processEvents({ "messages.upsert": { type: "notify", messages: votes } });

    const response = await invoke("wa_get_poll_results", {
      chatId: GROUP_ID,
      messageId: pollMessageId,
    });
    const results = JSON.parse(response.content[0]?.text ?? "{}") as {
      question: string;
      totalVotes: number;
      totalVoters: number;
      options: Array<{ name: string; count: number; voters: string[] }>;
    };
    expect(results).toMatchObject({ question: "Real crypto?", totalVotes: 3, totalVoters: 3 });
    expect(results.options).toEqual([
      { name: "Yes", count: 3, voters: [VOTER, SECOND_VOTER, THIRD_VOTER] },
      { name: "No", count: 0, voters: [] },
    ]);
  });

  it("retries pending poll votes when results are read after a LID mapping arrives", async () => {
    const pollMessageId = "pending-real-crypto-sent-poll-78";
    let voterMappingAvailable = false;
    const sendMessage = vi.fn(async (jid: string, content: unknown) =>
      generateWAMessage(jid, content as Parameters<typeof generateWAMessage>[1], {
        userJid: ACCOUNT_LID,
        messageId: pollMessageId,
      }),
    );
    const { instanceId, invoke, processEvents } = createFixture({
      user: { id: ACCOUNT_ID, lid: ACCOUNT_LID },
      signalRepository: {
        lidMapping: {
          getPNForLID: vi.fn(async (lid: string) => {
            if (lid === ACCOUNT_LID) return ACCOUNT_ID;
            if (lid === VOTER_LID && voterMappingAvailable) return VOTER;
            return null;
          }),
          getLIDForPN: vi.fn(async (pn: string) =>
            pn === ACCOUNT_ID ? ACCOUNT_LID : pn === VOTER ? VOTER_LID : null,
          ),
        },
      },
      sendMessage,
    });

    await invoke("wa_send_poll", {
      to: GROUP_ID,
      question: "Retry?",
      options: ["Yes", "No"],
    });
    const stored = sqlite
      .prepare("SELECT raw_data FROM messages WHERE instance_id = ? AND id = ?")
      .get(instanceId, pollMessageId) as { raw_data: string };
    const poll = JSON.parse(stored.raw_data, BufferJSON.reviver) as WAMessage;
    const messageSecret = poll.message?.messageContextInfo?.messageSecret;
    expect(messageSecret).toBeInstanceOf(Uint8Array);

    const voteMessage: WAMessage = {
      key: {
        remoteJid: GROUP_ID,
        id: "pending-real-crypto-vote-78",
        fromMe: false,
        participant: VOTER_LID,
      },
      message: {
        pollUpdateMessage: {
          pollCreationMessageKey: {
            remoteJid: GROUP_ID,
            id: pollMessageId,
            fromMe: false,
            participant: ACCOUNT_LID,
            participantAlt: ACCOUNT_ID,
          },
          vote: encryptPollVote(messageSecret!, pollMessageId, ACCOUNT_LID, VOTER, ["Yes"]),
        },
      },
      messageTimestamp: 1_800_000_100,
    } as WAMessage;
    await processEvents({ "messages.upsert": { type: "notify", messages: [voteMessage] } });
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM pending_poll_votes WHERE instance_id = ?")
        .get(instanceId),
    ).toMatchObject({ count: 1 });

    voterMappingAvailable = true;
    const response = await invoke("wa_get_poll_results", {
      chatId: GROUP_ID,
      messageId: pollMessageId,
    });
    const results = JSON.parse(response.content[0]?.text ?? "{}") as {
      totalVotes: number;
      options: Array<{ name: string; count: number; voters: string[] }>;
    };
    expect(results.totalVotes).toBe(1);
    expect(results.options).toEqual([
      { name: "Yes", count: 1, voters: [VOTER] },
      { name: "No", count: 0, voters: [] },
    ]);
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM pending_poll_votes WHERE instance_id = ?")
        .get(instanceId),
    ).toMatchObject({ count: 0 });
  });

  it("sends view-once audio and live locations through normal message sends", async () => {
    const { socket, invoke } = createFixture();
    const oggOpus = oggOpusFixture();
    await invoke("wa_send_view_once", {
      to: "5511999999999",
      media: oggOpus.toString("base64"),
      type: "audio",
    });
    expect(vi.mocked(socket.sendMessage).mock.calls[0]?.[1]).toMatchObject({
      audio: expect.any(Buffer),
      ptt: true,
      mimetype: "audio/ogg; codecs=opus",
      viewOnce: true,
    });

    await invoke("wa_send_live_location", {
      to: "5511999999999",
      latitude: -23.5,
      longitude: -46.6,
      accuracyInMeters: 20,
      comment: "Walking to the meeting",
    });
    expect(vi.mocked(socket.sendMessage).mock.calls[1]?.[1]).toMatchObject({
      location: {
        degreesLatitude: -23.5,
        degreesLongitude: -46.6,
        isLive: true,
        accuracyInMeters: 20,
        comment: "Walking to the meeting",
      },
    });
    await invoke("wa_send_location", {
      to: "5511999999999",
      latitude: -23.5,
      longitude: -46.6,
      name: "Office",
      address: "Main Street",
    });
    expect(vi.mocked(socket.sendMessage).mock.calls[2]?.[1]).toMatchObject({
      location: {
        degreesLatitude: -23.5,
        degreesLongitude: -46.6,
        name: "Office",
        address: "Main Street",
      },
    });
    await invoke("wa_send_view_once", {
      to: "5511999999999",
      media: "aW1hZ2U=",
      type: "image",
    });
    await invoke("wa_send_view_once", {
      to: "5511999999999",
      media: "dmlkZW8=",
      type: "video",
    });
    expect(vi.mocked(socket.sendMessage).mock.calls[3]?.[1]).toMatchObject({
      image: expect.any(Buffer),
      viewOnce: true,
    });
    expect(vi.mocked(socket.sendMessage).mock.calls[4]?.[1]).toMatchObject({
      video: expect.any(Buffer),
      viewOnce: true,
    });
    await expect(
      new CloudApiAdapter("cloud-test").sendMessage("5511999999999", {
        type: "location",
        latitude: 0,
        longitude: 0,
        isLive: true,
      }),
    ).rejects.toThrow("Live location messages are not supported on Cloud API");
    await expect(
      new CloudApiAdapter("cloud-test").sendViewOnce("5511999999999", "aGVsbG8=", "audio"),
    ).rejects.toThrow("View-once media is not supported on Cloud API");
  });

  it("uses detected MP3 and M4A MIME types for view-once audio", async () => {
    const { socket, invoke } = createFixture();
    const mp3 = Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00MP3 fixture", "binary");
    await invoke("wa_send_view_once", {
      to: "5511999999999",
      media: `data:audio/mpeg;base64,${mp3.toString("base64")}`,
      type: "audio",
    });
    expect(vi.mocked(socket.sendMessage).mock.calls[0]?.[1]).toMatchObject({
      audio: mp3,
      ptt: false,
      mimetype: "audio/mpeg",
      viewOnce: true,
    });

    const m4a = m4aFixture();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(m4a, { headers: { "content-type": "audio/mp4; codecs=mp4a.40.2" } }),
    );
    await invoke("wa_send_view_once", {
      to: "5511999999999",
      media: "https://audio.example.test/sample.m4a",
      type: "audio",
    });
    expect(vi.mocked(socket.sendMessage).mock.calls[1]?.[1]).toMatchObject({
      audio: m4a,
      ptt: false,
      mimetype: "audio/mp4",
      viewOnce: true,
    });
  });

  it("rejects view-once audio with unknown or unsupported formats", async () => {
    const { adapter } = createFixture();
    await expect(
      adapter.sendViewOnce("5511999999999", Buffer.from("not audio").toString("base64"), "audio"),
    ).rejects.toThrow("Unsupported or unknown view-once audio format");
  });

  it("sends one or more contacts as vCards", async () => {
    const { socket, invoke } = createFixture();
    await invoke("wa_send_contact", {
      to: GROUP_ID,
      contacts: [
        { name: "A Person", phone: "5511999999999" },
        { name: "B Person", phone: "5511888888888" },
      ],
    });
    const payload = vi.mocked(socket.sendMessage).mock.calls[0]?.[1] as {
      contacts: { displayName: string; contacts: Array<{ vcard: string }> };
    };
    expect(payload.contacts.displayName).toBe("2 contacts");
    expect(payload.contacts.contacts.map((entry) => entry.vcard)).toEqual([
      expect.stringContaining("FN:A Person"),
      expect.stringContaining("FN:B Person"),
    ]);
  });

  it("keeps edit, delete-for-everyone, and pin operations on message protocol calls", async () => {
    const { instanceId, socket, invoke } = createFixture();
    await invoke("wa_edit_message", {
      chatId: GROUP_ID,
      messageId: "editable-message",
      newText: "Updated text",
    });
    expect(vi.mocked(socket.sendMessage).mock.calls[0]?.[1]).toMatchObject({
      text: "Updated text",
      edit: { remoteJid: GROUP_ID, id: "editable-message", fromMe: true },
    });

    sqlite
      .prepare(
        "INSERT INTO messages (id, instance_id, chat_id, sender_id, type, is_from_me, status, timestamp) VALUES (?, ?, ?, 'me', 'text', 1, 'sent', 1)",
      )
      .run("deletable-message", instanceId, GROUP_ID);
    await invoke("wa_delete_message", {
      chatId: GROUP_ID,
      messageId: "deletable-message",
    });
    expect(vi.mocked(socket.sendMessage).mock.calls[1]?.[1]).toEqual({
      delete: { remoteJid: GROUP_ID, id: "deletable-message", fromMe: true },
    });

    await invoke("wa_pin_message", {
      chatId: GROUP_ID,
      messageId: "pinnable-message",
      pin: true,
    });
    expect(vi.mocked(socket.sendMessage).mock.calls[2]?.[1]).toMatchObject({
      pin: { remoteJid: GROUP_ID, id: "pinnable-message", fromMe: true },
      type: 1,
      time: 604800,
    });
    await expect(
      new CloudApiAdapter("cloud-test").editMessage(GROUP_ID, "message-id", "edit"),
    ).rejects.toThrow("Editing sent messages is not supported on Cloud API");
  });

  it("accepts invite links and exposes read-only group invite/request helpers", async () => {
    const { adapter, socket, invoke } = createFixture();
    const created = await invoke("wa_create_group", {
      name: "Planning group",
      participants: [CONTACT_ID],
    });
    expect(JSON.parse(created.content[0]?.text ?? "{}")).toMatchObject({ groupId: GROUP_ID });
    expect(socket.groupCreate).toHaveBeenCalledWith("Planning group", [CONTACT_ID]);

    await expect(
      adapter.joinGroup("https://CHAT.WHATSAPP.COM/invite-code-78?mode=abc"),
    ).resolves.toBe(GROUP_ID);
    expect(socket.groupAcceptInvite).toHaveBeenCalledWith("invite-code-78");
    const invite = await invoke("wa_group_get_invite_code", { groupId: GROUP_ID });
    expect(JSON.parse(invite.content[0]?.text ?? "{}").inviteCode).toBe("invite-code-78");
    await invoke("wa_group_revoke_invite", { groupId: GROUP_ID });
    expect(socket.groupRevokeInvite).toHaveBeenCalledWith(GROUP_ID);

    const inviteInfo = await invoke("wa_get_group_invite_info", {
      inviteCode: "https://chat.whatsapp.com/invite-code-78?mode=abc",
    });
    expect(JSON.parse(inviteInfo.content[0]?.text ?? "{}")).toMatchObject({
      subject: "Planning group",
      jid: GROUP_ID,
    });
    expect(socket.groupGetInviteInfo).toHaveBeenCalledWith("invite-code-78");

    const requests = await invoke("wa_group_list_join_requests", { groupId: GROUP_ID });
    expect(JSON.parse(requests.content[0]?.text ?? "{}")).toMatchObject({
      count: 1,
      requests: [{ jid: VOTER, attributes: { t: "1700000123" } }],
    });

    await invoke("wa_send_group_invite_message", {
      to: CONTACT_ID,
      groupId: GROUP_ID,
      text: "Come join",
    });
    expect(vi.mocked(socket.sendMessage).mock.calls[0]?.[1]).toMatchObject({
      groupInvite: {
        inviteCode: "invite-code-78",
        inviteExpiration: 0,
        text: "Come join",
        jid: GROUP_ID,
        subject: "Planning group",
      },
    });
  });

  it("sets announcement and locked group modes with their matching Baileys values", async () => {
    const { adapter, socket } = createFixture();
    await adapter.modifyGroup(GROUP_ID, { action: "updateSettings", value: "announcement" });
    await adapter.modifyGroup(GROUP_ID, { action: "updateSettings", value: "locked" });
    expect(socket.groupSettingUpdate).toHaveBeenNthCalledWith(1, GROUP_ID, "announcement");
    expect(socket.groupSettingUpdate).toHaveBeenNthCalledWith(2, GROUP_ID, "locked");
    await expect(
      adapter.modifyGroup(GROUP_ID, { action: "updateSettings", value: "invalid" }),
    ).rejects.toThrow("Invalid group setting update");
  });

  it("covers participant roles and group metadata and picture changes", async () => {
    const { socket, invoke } = createFixture();
    await invoke("wa_group_add_participants", { groupId: GROUP_ID, participants: [CONTACT_ID] });
    await invoke("wa_group_remove_participants", { groupId: GROUP_ID, participants: [CONTACT_ID] });
    await invoke("wa_group_promote", { groupId: GROUP_ID, participants: [CONTACT_ID] });
    await invoke("wa_group_demote", { groupId: GROUP_ID, participants: [CONTACT_ID] });
    expect(socket.groupParticipantsUpdate).toHaveBeenNthCalledWith(
      1,
      GROUP_ID,
      [CONTACT_ID],
      "add",
    );
    expect(socket.groupParticipantsUpdate).toHaveBeenNthCalledWith(
      2,
      GROUP_ID,
      [CONTACT_ID],
      "remove",
    );
    expect(socket.groupParticipantsUpdate).toHaveBeenNthCalledWith(
      3,
      GROUP_ID,
      [CONTACT_ID],
      "promote",
    );
    expect(socket.groupParticipantsUpdate).toHaveBeenNthCalledWith(
      4,
      GROUP_ID,
      [CONTACT_ID],
      "demote",
    );

    await invoke("wa_group_update_subject", { groupId: GROUP_ID, subject: "New subject" });
    await invoke("wa_group_update_description", {
      groupId: GROUP_ID,
      description: "New description",
    });
    await invoke("wa_group_update_settings", { groupId: GROUP_ID, announce: true, locked: true });
    expect(socket.groupUpdateSubject).toHaveBeenCalledWith(GROUP_ID, "New subject");
    expect(socket.groupUpdateDescription).toHaveBeenCalledWith(GROUP_ID, "New description");
    expect(socket.groupSettingUpdate).toHaveBeenNthCalledWith(1, GROUP_ID, "announcement");
    expect(socket.groupSettingUpdate).toHaveBeenNthCalledWith(2, GROUP_ID, "locked");

    vi.spyOn(MediaService.prototype, "prepareGroupProfilePicture").mockResolvedValue(
      Buffer.from("fake-jpeg"),
    );
    await invoke("wa_group_update_picture", { groupId: GROUP_ID, image: "iVBORw0KGgo=" });
    await invoke("wa_group_remove_picture", { groupId: GROUP_ID });
    expect(socket.updateProfilePicture).toHaveBeenCalledWith(GROUP_ID, Buffer.from("fake-jpeg"));
    expect(socket.removeProfilePicture).toHaveBeenCalledWith(GROUP_ID);
  });

  it("keeps all new tools away from chatModify and appPatch", async () => {
    const { adapter, socket, invoke } = createFixture();
    const poll = await adapter.sendMessage(GROUP_ID, {
      type: "poll",
      question: "New tools?",
      options: ["Yes", "No"],
    });
    await invoke("wa_get_poll_results", { chatId: GROUP_ID, messageId: poll.messageId });
    await invoke("wa_send_live_location", { to: GROUP_ID, latitude: 1, longitude: 2 });
    await invoke("wa_send_contact", {
      to: GROUP_ID,
      contacts: [{ name: "A Person", phone: "5511999999999" }],
    });
    await invoke("wa_get_group_invite_info", { inviteCode: "invite-code-78" });
    await invoke("wa_group_list_join_requests", { groupId: GROUP_ID });
    await invoke("wa_send_group_invite_message", { to: CONTACT_ID, groupId: GROUP_ID });
    const picture = await invoke("wa_get_profile_picture", { jid: CONTACT_ID });
    expect(JSON.parse(picture.content[0]?.text ?? "{}").url).toBe(
      "https://example.test/profile.jpg",
    );
    expect(socket.chatModify).not.toHaveBeenCalled();
    expect(socket.appPatch).not.toHaveBeenCalled();
  });

  it("returns Cloud API unsupported errors for the new Baileys-only tools", async () => {
    const cloud = new CloudApiAdapter("cloud-test");
    await expect(cloud.getPollResults(GROUP_ID, "poll-id")).rejects.toThrow(
      "Poll results are only available on Baileys instances",
    );
    await expect(cloud.getGroupInviteInfo("invite-code")).rejects.toThrow(
      "Group invite lookup is not supported on Cloud API",
    );
    await expect(cloud.listGroupJoinRequests(GROUP_ID)).rejects.toThrow(
      "Group join-request lists are not supported on Cloud API",
    );
    await expect(cloud.sendGroupInviteMessage(CONTACT_ID, GROUP_ID)).rejects.toThrow(
      "Group invite messages are not supported on Cloud API",
    );
  });
});
