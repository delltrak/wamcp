import { describe, it, expect } from "vitest";
import {
  normalizeWebhookPayload,
  type MetaWebhookPayload,
} from "../src/channels/cloud-api/cloud.events.js";

function makePayload(
  overrides: Partial<MetaWebhookPayload> & {
    messages?: unknown[];
    statuses?: unknown[];
    contacts?: unknown[];
  } = {},
): MetaWebhookPayload {
  const {
    messages,
    statuses,
    contacts,
    ...rest
  } = overrides;

  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "entry_1",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "5511999999999",
                phone_number_id: "phone_123",
              },
              contacts: (contacts as never[]) ?? [
                { profile: { name: "Test User" }, wa_id: "5511888888888" },
              ],
              messages: messages as never[],
              statuses: statuses as never[],
            },
            field: "messages",
          },
        ],
      },
    ],
    ...rest,
  };
}

describe("normalizeWebhookPayload", () => {
  describe("text messages", () => {
    it("normalizes a text message webhook to message.received event", () => {
      const payload = makePayload({
        messages: [
          {
            from: "5511888888888",
            id: "wamid.abc123",
            timestamp: "1700000000",
            type: "text",
            text: { body: "Hello from WhatsApp!" },
          },
        ],
      });

      const events = normalizeWebhookPayload(payload);

      expect(events).toHaveLength(1);
      expect(events[0].phoneNumberId).toBe("phone_123");
      expect(events[0].event).toBe("message.received");

      const msg = (events[0].payload as { message: Record<string, unknown> }).message;
      expect(msg.id).toBe("wamid.abc123");
      expect(msg.sender).toBe("5511888888888@s.whatsapp.net");
      expect(msg.timestamp).toBe(1700000000);
      expect(msg.type).toBe("text");
      expect(msg.content).toBe("Hello from WhatsApp!");
      expect(msg.isFromMe).toBe(false);
    });
  });

  describe("image messages", () => {
    it("normalizes an image message with caption", () => {
      const payload = makePayload({
        messages: [
          {
            from: "5511888888888",
            id: "wamid.img123",
            timestamp: "1700000001",
            type: "image",
            image: {
              id: "media_id_123",
              mime_type: "image/jpeg",
              caption: "Check this photo",
            },
          },
        ],
      });

      const events = normalizeWebhookPayload(payload);

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("message.received");

      const msg = (events[0].payload as { message: Record<string, unknown> }).message;
      expect(msg.type).toBe("image");
      expect(msg.content).toBe("Check this photo");
      expect(msg.mediaUrl).toBe("media_id_123");
    });

    it("normalizes an image message without caption", () => {
      const payload = makePayload({
        messages: [
          {
            from: "5511888888888",
            id: "wamid.img456",
            timestamp: "1700000002",
            type: "image",
            image: { id: "media_id_456", mime_type: "image/png" },
          },
        ],
      });

      const events = normalizeWebhookPayload(payload);

      expect(events).toHaveLength(1);
      const msg = (events[0].payload as { message: Record<string, unknown> }).message;
      expect(msg.type).toBe("image");
      expect(msg.content).toBeNull();
      expect(msg.mediaUrl).toBe("media_id_456");
    });
  });

  describe("video messages", () => {
    it("normalizes a video message", () => {
      const payload = makePayload({
        messages: [
          {
            from: "5511888888888",
            id: "wamid.vid123",
            timestamp: "1700000003",
            type: "video",
            video: { id: "media_vid_123", mime_type: "video/mp4", caption: "Watch this" },
          },
        ],
      });

      const events = normalizeWebhookPayload(payload);
      const msg = (events[0].payload as { message: Record<string, unknown> }).message;
      expect(msg.type).toBe("video");
      expect(msg.content).toBe("Watch this");
      expect(msg.mediaUrl).toBe("media_vid_123");
    });
  });

  describe("audio messages", () => {
    it("normalizes an audio message", () => {
      const payload = makePayload({
        messages: [
          {
            from: "5511888888888",
            id: "wamid.aud123",
            timestamp: "1700000004",
            type: "audio",
            audio: { id: "media_aud_123", mime_type: "audio/ogg" },
          },
        ],
      });

      const events = normalizeWebhookPayload(payload);
      const msg = (events[0].payload as { message: Record<string, unknown> }).message;
      expect(msg.type).toBe("audio");
      expect(msg.mediaUrl).toBe("media_aud_123");
    });
  });

  describe("document messages", () => {
    it("normalizes a document message", () => {
      const payload = makePayload({
        messages: [
          {
            from: "5511888888888",
            id: "wamid.doc123",
            timestamp: "1700000005",
            type: "document",
            document: {
              id: "media_doc_123",
              mime_type: "application/pdf",
              caption: "Report",
              filename: "report.pdf",
            },
          },
        ],
      });

      const events = normalizeWebhookPayload(payload);
      const msg = (events[0].payload as { message: Record<string, unknown> }).message;
      expect(msg.type).toBe("document");
      expect(msg.content).toBe("Report");
      expect(msg.mediaUrl).toBe("media_doc_123");
    });
  });

  describe("location messages", () => {
    it("normalizes a location message", () => {
      const payload = makePayload({
        messages: [
          {
            from: "5511888888888",
            id: "wamid.loc123",
            timestamp: "1700000006",
            type: "location",
            location: {
              latitude: -23.5505,
              longitude: -46.6333,
              name: "Sao Paulo",
              address: "123 Main St",
            },
          },
        ],
      });

      const events = normalizeWebhookPayload(payload);
      const msg = (events[0].payload as { message: Record<string, unknown> }).message;
      expect(msg.type).toBe("location");
      expect(msg.content).toContain("lat:-23.5505");
      expect(msg.content).toContain("lng:-46.6333");
      expect(msg.content).toContain("Sao Paulo");
    });
  });

  describe("contact messages", () => {
    it("normalizes a contacts message", () => {
      const payload = makePayload({
        messages: [
          {
            from: "5511888888888",
            id: "wamid.cnt123",
            timestamp: "1700000007",
            type: "contacts",
            contacts: [
              { name: { formatted_name: "John Doe" }, phones: [{ phone: "+5511999999999" }] },
            ],
          },
        ],
      });

      const events = normalizeWebhookPayload(payload);
      const msg = (events[0].payload as { message: Record<string, unknown> }).message;
      expect(msg.type).toBe("contact");
      expect(msg.content).toBe("John Doe");
    });
  });

  describe("reaction messages", () => {
    it("normalizes a reaction as message.reaction event", () => {
      const payload = makePayload({
        messages: [
          {
            from: "5511888888888",
            id: "wamid.react123",
            timestamp: "1700000008",
            type: "reaction",
            reaction: { message_id: "wamid.original123", emoji: "👍" },
          },
        ],
      });

      const events = normalizeWebhookPayload(payload);

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("message.reaction");

      const p = events[0].payload as {
        chatId: string;
        messageId: string;
        emoji: string;
        reactedBy: string;
      };
      expect(p.chatId).toBe("5511888888888@s.whatsapp.net");
      expect(p.messageId).toBe("wamid.original123");
      expect(p.emoji).toBe("👍");
      expect(p.reactedBy).toBe("5511888888888@s.whatsapp.net");
    });
  });

  describe("sticker messages", () => {
    it("normalizes a sticker message", () => {
      const payload = makePayload({
        messages: [
          {
            from: "5511888888888",
            id: "wamid.stk123",
            timestamp: "1700000009",
            type: "sticker",
            sticker: { id: "media_stk_123", mime_type: "image/webp" },
          },
        ],
      });

      const events = normalizeWebhookPayload(payload);
      const msg = (events[0].payload as { message: Record<string, unknown> }).message;
      expect(msg.type).toBe("sticker");
      expect(msg.mediaUrl).toBe("media_stk_123");
    });
  });

  describe("button/interactive messages", () => {
    it("normalizes a button reply as text type", () => {
      const payload = makePayload({
        messages: [
          {
            from: "5511888888888",
            id: "wamid.btn123",
            timestamp: "1700000010",
            type: "button",
            button: { text: "Option A", payload: "opt_a" },
          },
        ],
      });

      const events = normalizeWebhookPayload(payload);
      const msg = (events[0].payload as { message: Record<string, unknown> }).message;
      expect(msg.type).toBe("text");
      expect(msg.content).toBe("Option A");
    });

    it("normalizes an interactive button reply", () => {
      const payload = makePayload({
        messages: [
          {
            from: "5511888888888",
            id: "wamid.inter123",
            timestamp: "1700000011",
            type: "interactive",
            interactive: {
              type: "button_reply",
              button_reply: { id: "btn_1", title: "Yes" },
            },
          },
        ],
      });

      const events = normalizeWebhookPayload(payload);
      const msg = (events[0].payload as { message: Record<string, unknown> }).message;
      expect(msg.type).toBe("text");
      expect(msg.content).toBe("Yes");
    });
  });

  describe("status updates", () => {
    it("normalizes a sent status to message.updated event", () => {
      const payload = makePayload({
        statuses: [
          {
            id: "wamid.msg123",
            status: "sent",
            timestamp: "1700000020",
            recipient_id: "5511888888888",
          },
        ],
      });

      const events = normalizeWebhookPayload(payload);

      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("message.updated");

      const p = events[0].payload as {
        chatId: string;
        messageId: string;
        status: string;
      };
      expect(p.messageId).toBe("wamid.msg123");
      expect(p.chatId).toBe("5511888888888@s.whatsapp.net");
      expect(p.status).toBe("sent");
    });

    it("normalizes delivered status", () => {
      const payload = makePayload({
        statuses: [
          {
            id: "wamid.msg456",
            status: "delivered",
            timestamp: "1700000021",
            recipient_id: "5511888888888",
          },
        ],
      });

      const events = normalizeWebhookPayload(payload);
      expect(events).toHaveLength(1);
      const p = events[0].payload as { status: string };
      expect(p.status).toBe("delivered");
    });

    it("normalizes read status", () => {
      const payload = makePayload({
        statuses: [
          {
            id: "wamid.msg789",
            status: "read",
            timestamp: "1700000022",
            recipient_id: "5511888888888",
          },
        ],
      });

      const events = normalizeWebhookPayload(payload);
      expect(events).toHaveLength(1);
      const p = events[0].payload as { status: string };
      expect(p.status).toBe("read");
    });

    it("maps failed status to sent", () => {
      const payload = makePayload({
        statuses: [
          {
            id: "wamid.msgfail",
            status: "failed",
            timestamp: "1700000023",
            recipient_id: "5511888888888",
            errors: [{ code: 131051, title: "Unsupported message type" }],
          },
        ],
      });

      const events = normalizeWebhookPayload(payload);
      expect(events).toHaveLength(1);
      const p = events[0].payload as { status: string };
      expect(p.status).toBe("sent");
    });
  });

  describe("quoted messages (context)", () => {
    it("includes quotedMessageId when context is present", () => {
      const payload = makePayload({
        messages: [
          {
            from: "5511888888888",
            id: "wamid.reply123",
            timestamp: "1700000030",
            type: "text",
            text: { body: "This is a reply" },
            context: { from: "5511777777777", id: "wamid.original456" },
          },
        ],
      });

      const events = normalizeWebhookPayload(payload);
      const msg = (events[0].payload as { message: Record<string, unknown> }).message;
      expect(msg.quotedMessageId).toBe("wamid.original456");
    });
  });

  describe("edge cases", () => {
    it("returns empty array for non-whatsapp_business_account object", () => {
      const payload: MetaWebhookPayload = {
        object: "page",
        entry: [],
      };

      const events = normalizeWebhookPayload(payload);
      expect(events).toHaveLength(0);
    });

    it("skips changes with field != messages", () => {
      const payload: MetaWebhookPayload = {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "entry_1",
            changes: [
              {
                value: {
                  messaging_product: "whatsapp",
                  metadata: {
                    display_phone_number: "5511999999999",
                    phone_number_id: "phone_123",
                  },
                },
                field: "other_field",
              },
            ],
          },
        ],
      };

      const events = normalizeWebhookPayload(payload);
      expect(events).toHaveLength(0);
    });

    it("handles multiple messages in a single webhook", () => {
      const payload = makePayload({
        messages: [
          {
            from: "5511888888888",
            id: "wamid.m1",
            timestamp: "1700000040",
            type: "text",
            text: { body: "First" },
          },
          {
            from: "5511777777777",
            id: "wamid.m2",
            timestamp: "1700000041",
            type: "text",
            text: { body: "Second" },
          },
        ],
        contacts: [
          { profile: { name: "User A" }, wa_id: "5511888888888" },
          { profile: { name: "User B" }, wa_id: "5511777777777" },
        ],
      });

      const events = normalizeWebhookPayload(payload);
      expect(events).toHaveLength(2);
      expect(events[0].event).toBe("message.received");
      expect(events[1].event).toBe("message.received");
    });

    it("handles mixed messages and statuses", () => {
      const payload = makePayload({
        messages: [
          {
            from: "5511888888888",
            id: "wamid.m1",
            timestamp: "1700000050",
            type: "text",
            text: { body: "Hello" },
          },
        ],
        statuses: [
          {
            id: "wamid.s1",
            status: "delivered",
            timestamp: "1700000051",
            recipient_id: "5511777777777",
          },
        ],
      });

      const events = normalizeWebhookPayload(payload);
      expect(events).toHaveLength(2);

      const messageEvents = events.filter((e) => e.event === "message.received");
      const statusEvents = events.filter((e) => e.event === "message.updated");
      expect(messageEvents).toHaveLength(1);
      expect(statusEvents).toHaveLength(1);
    });

    it("ignores unknown status types", () => {
      const payload = makePayload({
        statuses: [
          {
            id: "wamid.unk",
            status: "unknown_status",
            timestamp: "1700000060",
            recipient_id: "5511888888888",
          },
        ],
      });

      const events = normalizeWebhookPayload(payload);
      expect(events).toHaveLength(0);
    });

    it("sets instanceId to empty string (to be filled by caller)", () => {
      const payload = makePayload({
        messages: [
          {
            from: "5511888888888",
            id: "wamid.inst_check",
            timestamp: "1700000070",
            type: "text",
            text: { body: "Check instanceId" },
          },
        ],
      });

      const events = normalizeWebhookPayload(payload);
      const p = events[0].payload as { instanceId: string };
      expect(p.instanceId).toBe("");
    });
  });
});
