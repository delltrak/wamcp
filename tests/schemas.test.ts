import { describe, it, expect } from "vitest";

// Messaging schemas
import {
  SendTextSchema,
  SendImageSchema,
  SendVideoSchema,
  SendAudioSchema,
  SendDocumentSchema,
  SendLocationSchema,
  SendContactSchema,
  SendPollSchema,
  SendReactionSchema,
  SendLinkPreviewSchema,
  ForwardMessageSchema,
  EditMessageSchema,
  DeleteMessageSchema,
  PinMessageSchema,
  SendViewOnceSchema,
  SendPresenceSchema,
  MarkReadSchema,
} from "../src/schemas/messaging.schema.js";

// Instance schemas
import {
  CreateInstanceSchema,
  ConnectInstanceSchema,
  DisconnectInstanceSchema,
  DeleteInstanceSchema,
  RestartInstanceSchema,
  GetQrCodeSchema,
  GetPairingCodeSchema,
  SetCloudCredentialsSchema,
} from "../src/schemas/instance.schema.js";

// Chat schemas
import {
  ArchiveChatSchema,
  PinChatSchema,
  MuteChatSchema,
  DeleteChatSchema,
  ClearChatSchema,
} from "../src/schemas/chat.schema.js";

// Contact schemas
import {
  CheckNumberExistsSchema,
  BlockContactSchema,
  UnblockContactSchema,
  GetBusinessProfileSchema,
} from "../src/schemas/contact.schema.js";

// Group schemas
import {
  CreateGroupSchema,
  AddParticipantsSchema,
  RemoveParticipantsSchema,
  PromoteParticipantSchema,
  DemoteParticipantSchema,
  UpdateSubjectSchema,
  UpdateDescriptionSchema,
  UpdateSettingsSchema,
  LeaveGroupSchema,
  GetInviteCodeSchema,
  RevokeInviteSchema,
  JoinGroupSchema,
  ToggleEphemeralSchema,
  HandleJoinRequestSchema,
} from "../src/schemas/group.schema.js";

// Profile schemas
import {
  UpdateProfilePictureSchema,
  RemoveProfilePictureSchema,
  UpdateProfileNameSchema,
  UpdateProfileStatusSchema,
  UpdatePrivacySchema,
} from "../src/schemas/profile.schema.js";

// Status schemas
import {
  SendTextStatusSchema,
  SendImageStatusSchema,
  SendVideoStatusSchema,
} from "../src/schemas/status.schema.js";

// Call schemas
import { RejectCallSchema } from "../src/schemas/call.schema.js";

// Newsletter schemas
import {
  NewsletterFollowSchema,
  NewsletterUnfollowSchema,
  NewsletterSendSchema,
} from "../src/schemas/newsletter.schema.js";

// ============================================================
// Messaging Schemas
// ============================================================

describe("SendTextSchema", () => {
  it("accepts valid input", () => {
    const result = SendTextSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      text: "Hello!",
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional quotedMessageId", () => {
    const result = SendTextSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      text: "Reply",
      quotedMessageId: "msg_123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty instanceId", () => {
    const result = SendTextSchema.safeParse({
      instanceId: "",
      to: "5511999999999",
      text: "Hello!",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty text", () => {
    const result = SendTextSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      text: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects text exceeding max length", () => {
    const result = SendTextSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      text: "a".repeat(65537),
    });
    expect(result.success).toBe(false);
  });

  it("rejects short 'to' field", () => {
    const result = SendTextSchema.safeParse({
      instanceId: "inst_abc123",
      to: "123",
      text: "Hello!",
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra fields (strict mode)", () => {
    const result = SendTextSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      text: "Hello!",
      extraField: "not allowed",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    const result = SendTextSchema.safeParse({
      instanceId: "inst_abc123",
    });
    expect(result.success).toBe(false);
  });
});

describe("SendImageSchema", () => {
  it("accepts valid input with caption", () => {
    const result = SendImageSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      image: "https://example.com/image.jpg",
      caption: "Check this out",
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid input without optional fields", () => {
    const result = SendImageSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      image: "base64data",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty image", () => {
    const result = SendImageSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      image: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("SendVideoSchema", () => {
  it("accepts valid input", () => {
    const result = SendVideoSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      video: "https://example.com/video.mp4",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing video", () => {
    const result = SendVideoSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
    });
    expect(result.success).toBe(false);
  });
});

describe("SendAudioSchema", () => {
  it("accepts valid input with ptt default", () => {
    const result = SendAudioSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      audio: "https://example.com/audio.ogg",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ptt).toBe(false);
    }
  });

  it("accepts ptt flag", () => {
    const result = SendAudioSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      audio: "base64audio",
      ptt: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ptt).toBe(true);
    }
  });
});

describe("SendDocumentSchema", () => {
  it("accepts valid input", () => {
    const result = SendDocumentSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      document: "https://example.com/doc.pdf",
      fileName: "report.pdf",
      mimeType: "application/pdf",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing fileName", () => {
    const result = SendDocumentSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      document: "https://example.com/doc.pdf",
      mimeType: "application/pdf",
    });
    expect(result.success).toBe(false);
  });
});

describe("SendLocationSchema", () => {
  it("accepts valid coordinates", () => {
    const result = SendLocationSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      latitude: -23.5505,
      longitude: -46.6333,
    });
    expect(result.success).toBe(true);
  });

  it("rejects out-of-range latitude", () => {
    const result = SendLocationSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      latitude: 91,
      longitude: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects out-of-range longitude", () => {
    const result = SendLocationSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      latitude: 0,
      longitude: 181,
    });
    expect(result.success).toBe(false);
  });

  it("accepts optional name and address", () => {
    const result = SendLocationSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      latitude: -23.5505,
      longitude: -46.6333,
      name: "Office",
      address: "123 Main St",
    });
    expect(result.success).toBe(true);
  });
});

describe("SendContactSchema", () => {
  it("accepts valid input", () => {
    const result = SendContactSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      contactName: "John Doe",
      contactPhone: "5511888888888",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty contactName", () => {
    const result = SendContactSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      contactName: "",
      contactPhone: "5511888888888",
    });
    expect(result.success).toBe(false);
  });
});

describe("SendPollSchema", () => {
  it("accepts valid poll", () => {
    const result = SendPollSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      question: "Best framework?",
      options: ["React", "Vue", "Angular"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects fewer than 2 options", () => {
    const result = SendPollSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      question: "?",
      options: ["Only one"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than 12 options", () => {
    const result = SendPollSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      question: "?",
      options: Array.from({ length: 13 }, (_, i) => `Option ${i}`),
    });
    expect(result.success).toBe(false);
  });

  it("defaults multiSelect to false", () => {
    const result = SendPollSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      question: "Pick",
      options: ["A", "B"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.multiSelect).toBe(false);
    }
  });
});

describe("SendReactionSchema", () => {
  it("accepts valid reaction", () => {
    const result = SendReactionSchema.safeParse({
      instanceId: "inst_abc123",
      chatId: "5511999999999@s.whatsapp.net",
      messageId: "msg_123",
      emoji: "👍",
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty emoji (remove reaction)", () => {
    const result = SendReactionSchema.safeParse({
      instanceId: "inst_abc123",
      chatId: "5511999999999@s.whatsapp.net",
      messageId: "msg_123",
      emoji: "",
    });
    expect(result.success).toBe(true);
  });
});

describe("SendLinkPreviewSchema", () => {
  it("accepts valid input", () => {
    const result = SendLinkPreviewSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      text: "Check this link",
      url: "https://example.com",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid URL", () => {
    const result = SendLinkPreviewSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      text: "Check this link",
      url: "not-a-url",
    });
    expect(result.success).toBe(false);
  });
});

describe("ForwardMessageSchema", () => {
  it("accepts valid input", () => {
    const result = ForwardMessageSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      messageId: "msg_123",
      fromChatId: "5511888888888@s.whatsapp.net",
    });
    expect(result.success).toBe(true);
  });
});

describe("EditMessageSchema", () => {
  it("accepts valid input", () => {
    const result = EditMessageSchema.safeParse({
      instanceId: "inst_abc123",
      chatId: "5511999999999@s.whatsapp.net",
      messageId: "msg_123",
      newText: "Updated text",
    });
    expect(result.success).toBe(true);
  });
});

describe("DeleteMessageSchema", () => {
  it("accepts valid input", () => {
    const result = DeleteMessageSchema.safeParse({
      instanceId: "inst_abc123",
      chatId: "5511999999999@s.whatsapp.net",
      messageId: "msg_123",
    });
    expect(result.success).toBe(true);
  });
});

describe("PinMessageSchema", () => {
  it("accepts valid pin", () => {
    const result = PinMessageSchema.safeParse({
      instanceId: "inst_abc123",
      chatId: "5511999999999@s.whatsapp.net",
      messageId: "msg_123",
      pin: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing pin boolean", () => {
    const result = PinMessageSchema.safeParse({
      instanceId: "inst_abc123",
      chatId: "5511999999999@s.whatsapp.net",
      messageId: "msg_123",
    });
    expect(result.success).toBe(false);
  });
});

describe("SendViewOnceSchema", () => {
  it("accepts valid input", () => {
    const result = SendViewOnceSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      media: "https://example.com/image.jpg",
      type: "image",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid type", () => {
    const result = SendViewOnceSchema.safeParse({
      instanceId: "inst_abc123",
      to: "5511999999999",
      media: "https://example.com/file.txt",
      type: "document",
    });
    expect(result.success).toBe(false);
  });
});

describe("SendPresenceSchema", () => {
  it("accepts valid presence statuses", () => {
    for (const status of ["composing", "recording", "paused", "available", "unavailable"]) {
      const result = SendPresenceSchema.safeParse({
        instanceId: "inst_abc123",
        chatId: "5511999999999@s.whatsapp.net",
        status,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid status", () => {
    const result = SendPresenceSchema.safeParse({
      instanceId: "inst_abc123",
      chatId: "5511999999999@s.whatsapp.net",
      status: "invisible",
    });
    expect(result.success).toBe(false);
  });
});

describe("MarkReadSchema", () => {
  it("accepts valid input", () => {
    const result = MarkReadSchema.safeParse({
      instanceId: "inst_abc123",
      chatId: "5511999999999@s.whatsapp.net",
      messageIds: ["msg_1", "msg_2"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty messageIds array", () => {
    const result = MarkReadSchema.safeParse({
      instanceId: "inst_abc123",
      chatId: "5511999999999@s.whatsapp.net",
      messageIds: [],
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================
// Instance Schemas
// ============================================================

describe("CreateInstanceSchema", () => {
  it("accepts valid input with default channel", () => {
    const result = CreateInstanceSchema.safeParse({ name: "my-bot" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.channel).toBe("baileys");
    }
  });

  it("accepts cloud channel", () => {
    const result = CreateInstanceSchema.safeParse({ name: "cloud-bot", channel: "cloud" });
    expect(result.success).toBe(true);
  });

  it("rejects invalid channel", () => {
    const result = CreateInstanceSchema.safeParse({ name: "bot", channel: "telegram" });
    expect(result.success).toBe(false);
  });

  it("rejects empty name", () => {
    const result = CreateInstanceSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });
});

describe("ConnectInstanceSchema", () => {
  it("accepts valid instanceId", () => {
    const result = ConnectInstanceSchema.safeParse({ instanceId: "inst_abc123" });
    expect(result.success).toBe(true);
  });
});

describe("DisconnectInstanceSchema", () => {
  it("accepts valid instanceId", () => {
    const result = DisconnectInstanceSchema.safeParse({ instanceId: "inst_abc123" });
    expect(result.success).toBe(true);
  });
});

describe("DeleteInstanceSchema", () => {
  it("accepts valid instanceId", () => {
    const result = DeleteInstanceSchema.safeParse({ instanceId: "inst_abc123" });
    expect(result.success).toBe(true);
  });
});

describe("RestartInstanceSchema", () => {
  it("accepts valid instanceId", () => {
    const result = RestartInstanceSchema.safeParse({ instanceId: "inst_abc123" });
    expect(result.success).toBe(true);
  });
});

describe("GetQrCodeSchema", () => {
  it("accepts valid instanceId", () => {
    const result = GetQrCodeSchema.safeParse({ instanceId: "inst_abc123" });
    expect(result.success).toBe(true);
  });
});

describe("GetPairingCodeSchema", () => {
  it("accepts valid input", () => {
    const result = GetPairingCodeSchema.safeParse({
      instanceId: "inst_abc123",
      phoneNumber: "5511999999999",
    });
    expect(result.success).toBe(true);
  });
});

describe("SetCloudCredentialsSchema", () => {
  it("accepts valid credentials", () => {
    const result = SetCloudCredentialsSchema.safeParse({
      instanceId: "inst_abc123",
      accessToken: "EAAsome_token",
      phoneNumberId: "1234567890",
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional businessId", () => {
    const result = SetCloudCredentialsSchema.safeParse({
      instanceId: "inst_abc123",
      accessToken: "EAAsome_token",
      phoneNumberId: "1234567890",
      businessId: "9876543210",
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================
// Chat Schemas
// ============================================================

describe("ArchiveChatSchema", () => {
  it("accepts valid input", () => {
    const result = ArchiveChatSchema.safeParse({
      instanceId: "inst_abc123",
      chatId: "5511999999999@s.whatsapp.net",
      archive: true,
    });
    expect(result.success).toBe(true);
  });
});

describe("PinChatSchema", () => {
  it("accepts valid input", () => {
    const result = PinChatSchema.safeParse({
      instanceId: "inst_abc123",
      chatId: "5511999999999@s.whatsapp.net",
      pin: false,
    });
    expect(result.success).toBe(true);
  });
});

describe("MuteChatSchema", () => {
  it("accepts mute with optional muteUntil", () => {
    const result = MuteChatSchema.safeParse({
      instanceId: "inst_abc123",
      chatId: "5511999999999@s.whatsapp.net",
      mute: true,
      muteUntil: Date.now() + 3600000,
    });
    expect(result.success).toBe(true);
  });
});

describe("DeleteChatSchema", () => {
  it("accepts valid input", () => {
    const result = DeleteChatSchema.safeParse({
      instanceId: "inst_abc123",
      chatId: "5511999999999@s.whatsapp.net",
    });
    expect(result.success).toBe(true);
  });
});

describe("ClearChatSchema", () => {
  it("accepts valid input", () => {
    const result = ClearChatSchema.safeParse({
      instanceId: "inst_abc123",
      chatId: "5511999999999@s.whatsapp.net",
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================
// Contact Schemas
// ============================================================

describe("CheckNumberExistsSchema", () => {
  it("accepts valid phone number", () => {
    const result = CheckNumberExistsSchema.safeParse({
      instanceId: "inst_abc123",
      phoneNumber: "5511999999999",
    });
    expect(result.success).toBe(true);
  });
});

describe("BlockContactSchema", () => {
  it("accepts valid JID", () => {
    const result = BlockContactSchema.safeParse({
      instanceId: "inst_abc123",
      jid: "5511999999999@s.whatsapp.net",
    });
    expect(result.success).toBe(true);
  });
});

describe("UnblockContactSchema", () => {
  it("accepts valid JID", () => {
    const result = UnblockContactSchema.safeParse({
      instanceId: "inst_abc123",
      jid: "5511999999999@s.whatsapp.net",
    });
    expect(result.success).toBe(true);
  });
});

describe("GetBusinessProfileSchema", () => {
  it("accepts valid JID", () => {
    const result = GetBusinessProfileSchema.safeParse({
      instanceId: "inst_abc123",
      jid: "5511999999999@s.whatsapp.net",
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================
// Group Schemas
// ============================================================

describe("CreateGroupSchema", () => {
  it("accepts valid group creation", () => {
    const result = CreateGroupSchema.safeParse({
      instanceId: "inst_abc123",
      name: "My Group",
      participants: ["5511999999999", "5511888888888"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty participants", () => {
    const result = CreateGroupSchema.safeParse({
      instanceId: "inst_abc123",
      name: "My Group",
      participants: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects name longer than 100 chars", () => {
    const result = CreateGroupSchema.safeParse({
      instanceId: "inst_abc123",
      name: "a".repeat(101),
      participants: ["5511999999999"],
    });
    expect(result.success).toBe(false);
  });
});

describe("AddParticipantsSchema", () => {
  it("accepts valid input", () => {
    const result = AddParticipantsSchema.safeParse({
      instanceId: "inst_abc123",
      groupId: "120363000000000000@g.us",
      participants: ["5511999999999"],
    });
    expect(result.success).toBe(true);
  });
});

describe("RemoveParticipantsSchema", () => {
  it("accepts valid input", () => {
    const result = RemoveParticipantsSchema.safeParse({
      instanceId: "inst_abc123",
      groupId: "120363000000000000@g.us",
      participants: ["5511999999999"],
    });
    expect(result.success).toBe(true);
  });
});

describe("PromoteParticipantSchema", () => {
  it("accepts valid input", () => {
    const result = PromoteParticipantSchema.safeParse({
      instanceId: "inst_abc123",
      groupId: "120363000000000000@g.us",
      participants: ["5511999999999"],
    });
    expect(result.success).toBe(true);
  });
});

describe("DemoteParticipantSchema", () => {
  it("accepts valid input", () => {
    const result = DemoteParticipantSchema.safeParse({
      instanceId: "inst_abc123",
      groupId: "120363000000000000@g.us",
      participants: ["5511999999999"],
    });
    expect(result.success).toBe(true);
  });
});

describe("UpdateSubjectSchema", () => {
  it("accepts valid input", () => {
    const result = UpdateSubjectSchema.safeParse({
      instanceId: "inst_abc123",
      groupId: "120363000000000000@g.us",
      subject: "New Group Name",
    });
    expect(result.success).toBe(true);
  });
});

describe("UpdateDescriptionSchema", () => {
  it("accepts valid input including empty description", () => {
    const result = UpdateDescriptionSchema.safeParse({
      instanceId: "inst_abc123",
      groupId: "120363000000000000@g.us",
      description: "",
    });
    expect(result.success).toBe(true);
  });

  it("rejects description longer than 2048 chars", () => {
    const result = UpdateDescriptionSchema.safeParse({
      instanceId: "inst_abc123",
      groupId: "120363000000000000@g.us",
      description: "a".repeat(2049),
    });
    expect(result.success).toBe(false);
  });
});

describe("UpdateSettingsSchema", () => {
  it("accepts valid settings", () => {
    const result = UpdateSettingsSchema.safeParse({
      instanceId: "inst_abc123",
      groupId: "120363000000000000@g.us",
      announce: true,
    });
    expect(result.success).toBe(true);
  });
});

describe("LeaveGroupSchema", () => {
  it("accepts valid input", () => {
    const result = LeaveGroupSchema.safeParse({
      instanceId: "inst_abc123",
      groupId: "120363000000000000@g.us",
    });
    expect(result.success).toBe(true);
  });
});

describe("GetInviteCodeSchema", () => {
  it("accepts valid input", () => {
    const result = GetInviteCodeSchema.safeParse({
      instanceId: "inst_abc123",
      groupId: "120363000000000000@g.us",
    });
    expect(result.success).toBe(true);
  });
});

describe("RevokeInviteSchema", () => {
  it("accepts valid input", () => {
    const result = RevokeInviteSchema.safeParse({
      instanceId: "inst_abc123",
      groupId: "120363000000000000@g.us",
    });
    expect(result.success).toBe(true);
  });
});

describe("JoinGroupSchema", () => {
  it("accepts valid input", () => {
    const result = JoinGroupSchema.safeParse({
      instanceId: "inst_abc123",
      inviteCode: "AbCdEfGh",
    });
    expect(result.success).toBe(true);
  });
});

describe("ToggleEphemeralSchema", () => {
  it("accepts valid duration", () => {
    const result = ToggleEphemeralSchema.safeParse({
      instanceId: "inst_abc123",
      groupId: "120363000000000000@g.us",
      duration: 86400,
    });
    expect(result.success).toBe(true);
  });

  it("accepts 0 to disable", () => {
    const result = ToggleEphemeralSchema.safeParse({
      instanceId: "inst_abc123",
      groupId: "120363000000000000@g.us",
      duration: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects negative duration", () => {
    const result = ToggleEphemeralSchema.safeParse({
      instanceId: "inst_abc123",
      groupId: "120363000000000000@g.us",
      duration: -1,
    });
    expect(result.success).toBe(false);
  });
});

describe("HandleJoinRequestSchema", () => {
  it("accepts approve action", () => {
    const result = HandleJoinRequestSchema.safeParse({
      instanceId: "inst_abc123",
      groupId: "120363000000000000@g.us",
      participantId: "5511999999999@s.whatsapp.net",
      action: "approve",
    });
    expect(result.success).toBe(true);
  });

  it("accepts reject action", () => {
    const result = HandleJoinRequestSchema.safeParse({
      instanceId: "inst_abc123",
      groupId: "120363000000000000@g.us",
      participantId: "5511999999999@s.whatsapp.net",
      action: "reject",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid action", () => {
    const result = HandleJoinRequestSchema.safeParse({
      instanceId: "inst_abc123",
      groupId: "120363000000000000@g.us",
      participantId: "5511999999999@s.whatsapp.net",
      action: "ignore",
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================
// Profile Schemas
// ============================================================

describe("UpdateProfilePictureSchema", () => {
  it("accepts valid input", () => {
    const result = UpdateProfilePictureSchema.safeParse({
      instanceId: "inst_abc123",
      image: "base64imagedata",
    });
    expect(result.success).toBe(true);
  });
});

describe("RemoveProfilePictureSchema", () => {
  it("accepts valid input", () => {
    const result = RemoveProfilePictureSchema.safeParse({
      instanceId: "inst_abc123",
    });
    expect(result.success).toBe(true);
  });
});

describe("UpdateProfileNameSchema", () => {
  it("accepts valid name", () => {
    const result = UpdateProfileNameSchema.safeParse({
      instanceId: "inst_abc123",
      name: "My Bot",
    });
    expect(result.success).toBe(true);
  });

  it("rejects name longer than 25 chars", () => {
    const result = UpdateProfileNameSchema.safeParse({
      instanceId: "inst_abc123",
      name: "a".repeat(26),
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty name", () => {
    const result = UpdateProfileNameSchema.safeParse({
      instanceId: "inst_abc123",
      name: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("UpdateProfileStatusSchema", () => {
  it("accepts valid status", () => {
    const result = UpdateProfileStatusSchema.safeParse({
      instanceId: "inst_abc123",
      status: "Hello World",
    });
    expect(result.success).toBe(true);
  });

  it("rejects status longer than 139 chars", () => {
    const result = UpdateProfileStatusSchema.safeParse({
      instanceId: "inst_abc123",
      status: "a".repeat(140),
    });
    expect(result.success).toBe(false);
  });
});

describe("UpdatePrivacySchema", () => {
  it("accepts valid privacy settings", () => {
    const result = UpdatePrivacySchema.safeParse({
      instanceId: "inst_abc123",
      setting: "lastSeen",
      value: "contacts",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid setting", () => {
    const result = UpdatePrivacySchema.safeParse({
      instanceId: "inst_abc123",
      setting: "location",
      value: "all",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid value", () => {
    const result = UpdatePrivacySchema.safeParse({
      instanceId: "inst_abc123",
      setting: "lastSeen",
      value: "nobody",
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================
// Status Schemas
// ============================================================

describe("SendTextStatusSchema", () => {
  it("accepts valid text status", () => {
    const result = SendTextStatusSchema.safeParse({
      instanceId: "inst_abc123",
      text: "My status update",
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional styling", () => {
    const result = SendTextStatusSchema.safeParse({
      instanceId: "inst_abc123",
      text: "Styled status",
      backgroundColor: "#FF5733",
      font: 2,
    });
    expect(result.success).toBe(true);
  });

  it("rejects font out of range", () => {
    const result = SendTextStatusSchema.safeParse({
      instanceId: "inst_abc123",
      text: "Status",
      font: 6,
    });
    expect(result.success).toBe(false);
  });
});

describe("SendImageStatusSchema", () => {
  it("accepts valid input", () => {
    const result = SendImageStatusSchema.safeParse({
      instanceId: "inst_abc123",
      image: "https://example.com/image.jpg",
    });
    expect(result.success).toBe(true);
  });
});

describe("SendVideoStatusSchema", () => {
  it("accepts valid input", () => {
    const result = SendVideoStatusSchema.safeParse({
      instanceId: "inst_abc123",
      video: "https://example.com/video.mp4",
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================
// Call Schemas
// ============================================================

describe("RejectCallSchema", () => {
  it("accepts valid input", () => {
    const result = RejectCallSchema.safeParse({
      instanceId: "inst_abc123",
      callId: "call_abc123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty callId", () => {
    const result = RejectCallSchema.safeParse({
      instanceId: "inst_abc123",
      callId: "",
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================
// Newsletter Schemas
// ============================================================

describe("NewsletterFollowSchema", () => {
  it("accepts valid input", () => {
    const result = NewsletterFollowSchema.safeParse({
      instanceId: "inst_abc123",
      jid: "newsletter_jid@newsletter",
    });
    expect(result.success).toBe(true);
  });
});

describe("NewsletterUnfollowSchema", () => {
  it("accepts valid input", () => {
    const result = NewsletterUnfollowSchema.safeParse({
      instanceId: "inst_abc123",
      jid: "newsletter_jid@newsletter",
    });
    expect(result.success).toBe(true);
  });
});

describe("NewsletterSendSchema", () => {
  it("accepts valid input", () => {
    const result = NewsletterSendSchema.safeParse({
      instanceId: "inst_abc123",
      jid: "newsletter_jid@newsletter",
      text: "Newsletter message",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty text", () => {
    const result = NewsletterSendSchema.safeParse({
      instanceId: "inst_abc123",
      jid: "newsletter_jid@newsletter",
      text: "",
    });
    expect(result.success).toBe(false);
  });
});
