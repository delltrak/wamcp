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
  "supportsNativeGroupMentionAll",
  "sendEvent",
  "getEventResponses",
  "getPollResults",
  "starMessage",
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
  "markPlayed",
  "markPlayedMessage",
  // Chats
  "modifyChat",
  "markChatUnread",
  "listLabels",
  "createLabel",
  "editLabel",
  "deleteLabel",
  "setChatLabel",
  "setMessageLabel",
  "setDisappearingMessages",
  "createQuickReply",
  "editQuickReply",
  "deleteQuickReply",
  // Groups
  "listGroups",
  "createGroup",
  "modifyGroup",
  "modifyParticipants",
  "getGroupMetadata",
  "exportGroupParticipants",
  "updateGroupPicture",
  "removeGroupPicture",
  "getGroupInviteCode",
  "getGroupInviteInfo",
  "joinGroup",
  "listGroupJoinRequests",
  "sendGroupInviteMessage",
  "handleJoinRequest",
  "setGroupJoinApprovalMode",
  "setGroupMemberAddMode",
  "createCommunity",
  "listCommunities",
  "getCommunityMetadata",
  "getCommunityHierarchy",
  "createCommunityGroup",
  "updateCommunityName",
  "updateCommunityDescription",
  "updateCommunityPicture",
  "getCommunityMembers",
  "updateCommunityParticipants",
  "listCommunityJoinRequests",
  "handleCommunityJoinRequests",
  "getCommunityInviteCode",
  "getCommunityInviteInfo",
  "joinCommunity",
  "joinCommunityV4",
  "revokeCommunityMemberInvite",
  "updateCommunitySetting",
  "resolveCommunityAnnouncementGroup",
  "linkGroupToCommunity",
  "unlinkGroupFromCommunity",
  "leaveCommunity",
  // Contacts
  "checkNumberExists",
  "blockContact",
  "unblockContact",
  "getBlocklist",
  "getContactAbout",
  "getBusinessProfile",
  "resyncContacts",
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
  "createNewsletter",
  "getNewsletterMetadata",
  "updateNewsletterName",
  "updateNewsletterDescription",
  "updateNewsletterPicture",
  "reactToNewsletterMessage",
  "fetchNewsletterMessages",
  "downloadNewsletterMedia",
  "getCatalog",
  "getCollections",
  "createProduct",
  "updateProduct",
  "deleteProducts",
  "getOrderDetails",
  // Calls
  "rejectCall",
  // Data access
  "getContacts",
  "getChats",
  "getMessages",
  "searchMessages",
  "fetchMessageHistory",
  "downloadMessageAudio",
  "downloadMessageMedia",
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

describe("Cloud API contact resync", () => {
  it("returns a clear unsupported-operation error", async () => {
    await expect(new CloudApiAdapter("test_instance").resyncContacts()).rejects.toThrow(
      "Contact resync is not supported on Cloud API",
    );
  });
});
