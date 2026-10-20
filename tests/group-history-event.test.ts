import { describe, expect, it } from "vitest";
import { WAMessageStubType, type BaileysEventMap, type WAMessage } from "@whiskeysockets/baileys";
import { isDirectGroupParticipantAdd } from "../src/channels/baileys/group-history-event.js";
import { normalizeGroupParticipantsUpdate } from "../src/channels/baileys/baileys.events.js";

const GROUP_JID = "120363000000000001@g.us";
const OWN_PN = "5511000000000@s.whatsapp.net";
const OWN_LID = "1000000000@lid";
const MEMBER_PN = "5511000000001@s.whatsapp.net";

const update: BaileysEventMap["group-participants.update"] = {
  id: GROUP_JID,
  author: OWN_LID,
  authorPn: OWN_PN,
  participants: [{ id: MEMBER_PN }],
  action: "add",
};

function stubMessage(messageStubType: WAMessageStubType, participant = MEMBER_PN): WAMessage {
  return {
    key: {
      remoteJid: GROUP_JID,
      participant: OWN_LID,
      participantAlt: OWN_PN,
    },
    messageStubType,
    messageStubParameters: [JSON.stringify({ id: participant })],
  } as WAMessage;
}

describe("Baileys participant-add event correlation", () => {
  it("only identifies a matching direct-add stub and preserves rc14 author fields", () => {
    const rawMessage = stubMessage(WAMessageStubType.GROUP_PARTICIPANT_ADD);
    expect(isDirectGroupParticipantAdd(update, [rawMessage])).toBe(true);

    expect(normalizeGroupParticipantsUpdate("instance", update, true)).toMatchObject({
      groupId: GROUP_JID,
      action: "add",
      participants: [MEMBER_PN],
      participantAliases: [[MEMBER_PN]],
      author: OWN_LID,
      authorPn: OWN_PN,
      directAdd: true,
    });
  });

  it.each([
    ["invite", WAMessageStubType.GROUP_PARTICIPANT_INVITE],
    ["join request", WAMessageStubType.GROUP_PARTICIPANT_ADD_REQUEST_JOIN],
  ])("ignores %s stubs even though rc14 normalizes them to action add", (_name, type) => {
    expect(isDirectGroupParticipantAdd(update, [stubMessage(type)])).toBe(false);
  });

  it("requires matching group, author, and participant data", () => {
    expect(
      isDirectGroupParticipantAdd(
        {
          ...update,
          author: "5511000000009@s.whatsapp.net",
          authorPn: "5511000000009@s.whatsapp.net",
        },
        [stubMessage(WAMessageStubType.GROUP_PARTICIPANT_ADD)],
      ),
    ).toBe(false);
    expect(
      isDirectGroupParticipantAdd(update, [
        stubMessage(WAMessageStubType.GROUP_PARTICIPANT_ADD, "5511000000008@s.whatsapp.net"),
      ]),
    ).toBe(false);
    expect(
      isDirectGroupParticipantAdd(update, [
        {
          ...stubMessage(WAMessageStubType.GROUP_PARTICIPANT_ADD),
          key: { remoteJid: "120363000000000009@g.us", participant: OWN_LID },
        } as WAMessage,
      ]),
    ).toBe(false);
    expect(
      isDirectGroupParticipantAdd({ ...update, author: "" }, [
        stubMessage(WAMessageStubType.GROUP_PARTICIPANT_ADD),
      ]),
    ).toBe(false);
    expect(normalizeGroupParticipantsUpdate("instance", update)).not.toHaveProperty("directAdd");
  });
});
