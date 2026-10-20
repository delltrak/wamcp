import { describe, expect, it } from "vitest";
import {
  WAMessageStubType,
  makeEventBuffer,
  type BaileysEventMap,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { ownDirectParticipantAdds } from "../src/channels/baileys/group-history-event.js";
import {
  isViewOnceMessage,
  normalizeGroupParticipantsUpdate,
} from "../src/channels/baileys/baileys.events.js";

const GROUP_JID = "120363000000000001@g.us";
const OWN_PN = "5511000000000@s.whatsapp.net";
const OWN_LID = "1000000000@lid";
const MEMBER_PN = "5511000000001@s.whatsapp.net";
const MEMBER_LID = "1000000001@lid";
const own = { phone: OWN_PN, lid: OWN_LID };

const update: BaileysEventMap["group-participants.update"] = {
  id: GROUP_JID,
  author: OWN_LID,
  authorPn: OWN_PN,
  participants: [{ id: MEMBER_LID, phoneNumber: MEMBER_PN }],
  action: "add",
};

function stubMessage(
  messageStubType: WAMessageStubType,
  participant: unknown = { id: MEMBER_LID, phoneNumber: MEMBER_PN },
  id = "stub-1",
): WAMessage {
  return {
    key: {
      remoteJid: GROUP_JID,
      id,
      participant: OWN_LID,
      participantAlt: OWN_PN,
    },
    messageStubType,
    messageStubParameters: [JSON.stringify(participant)],
  } as WAMessage;
}

const silentLogger = {
  level: "silent",
  child() {
    return silentLogger;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

describe("Baileys direct-add stub detection", () => {
  it("reads a direct add from the upsert stub and keeps rc14 author fields on the participant event", () => {
    expect(
      ownDirectParticipantAdds([stubMessage(WAMessageStubType.GROUP_PARTICIPANT_ADD)], own),
    ).toEqual([
      {
        messageId: "stub-1",
        groupJid: GROUP_JID,
        targets: [{ identities: [MEMBER_LID, MEMBER_PN], phoneJid: MEMBER_PN }],
      },
    ]);
    expect(normalizeGroupParticipantsUpdate("instance", update)).toMatchObject({
      groupId: GROUP_JID,
      action: "add",
      participants: [MEMBER_LID],
      participantAliases: [[MEMBER_LID, MEMBER_PN]],
      author: OWN_LID,
      authorPn: OWN_PN,
    });
    expect(normalizeGroupParticipantsUpdate("instance", update)).not.toHaveProperty("directAdd");
  });

  it("accepts our phone number on either author field, including a device suffix", () => {
    const byPhone = stubMessage(WAMessageStubType.GROUP_PARTICIPANT_ADD);
    byPhone.key.participant = "5511000000000:14@s.whatsapp.net";
    byPhone.key.participantAlt = undefined;
    expect(ownDirectParticipantAdds([byPhone], { phone: OWN_PN, lid: null })).toHaveLength(1);

    const byLidAlt = stubMessage(WAMessageStubType.GROUP_PARTICIPANT_ADD);
    byLidAlt.key.participant = "5511000000009@s.whatsapp.net";
    byLidAlt.key.participantAlt = OWN_LID;
    expect(ownDirectParticipantAdds([byLidAlt], { phone: null, lid: OWN_LID })).toHaveLength(1);
  });

  it.each([
    ["invite", WAMessageStubType.GROUP_PARTICIPANT_INVITE],
    ["join request", WAMessageStubType.GROUP_PARTICIPANT_ADD_REQUEST_JOIN],
  ])("ignores a %s stub even when this account is the author", (_name, type) => {
    expect(ownDirectParticipantAdds([stubMessage(type)], own)).toEqual([]);
  });

  it("requires our identity, a group, a message id, and a target", () => {
    const otherAuthor = stubMessage(WAMessageStubType.GROUP_PARTICIPANT_ADD);
    otherAuthor.key.participant = "5511000000009@s.whatsapp.net";
    otherAuthor.key.participantAlt = "5511000000009@s.whatsapp.net";
    expect(ownDirectParticipantAdds([otherAuthor], own)).toEqual([]);

    const otherGroup = stubMessage(WAMessageStubType.GROUP_PARTICIPANT_ADD);
    otherGroup.key.remoteJid = "120363000000000009@g.us";
    expect(ownDirectParticipantAdds([otherGroup], own)[0]?.groupJid).toBe(
      "120363000000000009@g.us",
    );

    const missingId = stubMessage(WAMessageStubType.GROUP_PARTICIPANT_ADD);
    missingId.key.id = undefined;
    expect(ownDirectParticipantAdds([missingId], own)).toEqual([]);

    expect(
      ownDirectParticipantAdds([stubMessage(WAMessageStubType.GROUP_PARTICIPANT_ADD)], {
        phone: null,
        lid: null,
      }),
    ).toEqual([]);
  });

  it("detects the add from the upsert flushed by the real rc14 event buffer, not from the same batch as group-participants.update", () => {
    const ev = makeEventBuffer(silentLogger);
    const batches: Array<Record<string, unknown>> = [];
    ev.process((events) => {
      batches.push(events as Record<string, unknown>);
    });

    const stub = stubMessage(WAMessageStubType.GROUP_PARTICIPANT_ADD);
    ev.buffer();
    ev.emit("group-participants.update", update);
    ev.emit("messages.upsert", { messages: [stub], type: "notify" });

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveProperty("group-participants.update");
    expect(batches[0]).not.toHaveProperty("messages.upsert");
    expect(
      ownDirectParticipantAdds(
        ((batches[0]?.["messages.upsert"] as { messages?: WAMessage[] } | undefined)?.messages ??
          []) as WAMessage[],
        own,
      ),
    ).toEqual([]);

    expect(ev.flush()).toBe(true);
    expect(batches).toHaveLength(2);
    const upsert = batches[1]?.["messages.upsert"] as { messages: WAMessage[] };
    expect(ownDirectParticipantAdds(upsert.messages, own)).toEqual([
      {
        messageId: "stub-1",
        groupJid: GROUP_JID,
        targets: [{ identities: [MEMBER_LID, MEMBER_PN], phoneJid: MEMBER_PN }],
      },
    ]);
    ev.destroy();
  });
});

describe("view-once detection", () => {
  it("recognizes view-once wrappers without treating a quoted view-once message as view-once", () => {
    expect(
      isViewOnceMessage({
        message: { viewOnceMessageV2: { message: { imageMessage: { caption: "secret" } } } },
      }),
    ).toBe(true);
    expect(
      isViewOnceMessage({
        message: {
          ephemeralMessage: {
            message: { viewOnceMessage: { message: { videoMessage: {} } } },
          },
        },
      }),
    ).toBe(true);
    expect(
      isViewOnceMessage({
        message: {
          extendedTextMessage: {
            text: "visible",
            contextInfo: { quotedMessage: { viewOnceMessageV2: { message: {} } } },
          },
        },
      }),
    ).toBe(false);
    expect(isViewOnceMessage({ message: { conversation: "hello" } })).toBe(false);
  });
});
