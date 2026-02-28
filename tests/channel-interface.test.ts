import { describe, it, expect } from "vitest";
import { CloudApiAdapter } from "../src/channels/cloud-api/cloud.adapter.js";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import type { ChannelAdapter } from "../src/channels/channel.interface.js";

// List of all methods that ChannelAdapter requires
const CHANNEL_ADAPTER_METHODS: (keyof ChannelAdapter)[] = [
  // Lifecycle
  "connect",
  "disconnect",
  "getStatus",
  // Authentication
  "getQrCode",
  "getPairingCode",
  "setCredentials",
  // Messaging
  "sendMessage",
  "editMessage",
  "deleteMessage",
  "forwardMessage",
  "sendReaction",
  "pinMessage",
  "sendViewOnce",
  "sendLinkPreview",
  // Presence
  "sendPresence",
  "markRead",
  // Chats
  "modifyChat",
  // Groups
  "createGroup",
  "modifyGroup",
  "modifyParticipants",
  "getGroupMetadata",
  "getGroupInviteCode",
  "joinGroup",
  "handleJoinRequest",
  // Contacts
  "checkNumberExists",
  "blockContact",
  "unblockContact",
  "getBlocklist",
  "getBusinessProfile",
  // Profile
  "updateProfilePicture",
  "removeProfilePicture",
  "updateProfileName",
  "updateProfileStatus",
  "updatePrivacy",
  "getPrivacySettings",
  "getProfilePicture",
  // Status / Stories
  "sendStatus",
  // Newsletter / Channels
  "newsletterFollow",
  "newsletterUnfollow",
  "newsletterSend",
  // Calls
  "rejectCall",
  // Data access
  "getContacts",
  "getChats",
  "getMessages",
  "getProfileInfo",
  // Events
  "on",
  "off",
];

describe("CloudApiAdapter implements ChannelAdapter", () => {
  const adapter = new CloudApiAdapter("test_instance");

  for (const method of CHANNEL_ADAPTER_METHODS) {
    it(`has method: ${method}`, () => {
      expect(typeof adapter[method]).toBe("function");
    });
  }
});

describe("BaileysAdapter implements ChannelAdapter", () => {
  const adapter = new BaileysAdapter("test_instance");

  for (const method of CHANNEL_ADAPTER_METHODS) {
    it(`has method: ${method}`, () => {
      expect(typeof adapter[method]).toBe("function");
    });
  }
});
