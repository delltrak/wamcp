import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { WAMessage } from "@whiskeysockets/baileys";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import {
  extractMessageDetails,
  normalizeMessageEdit,
  normalizeMessagesUpsert,
} from "../src/channels/baileys/baileys.events.js";
import { sqlite } from "../src/db/client.js";
import type { NormalizedMessageEvent } from "../src/types/channel.types.js";
import {
  normalizeEventWebhookPayload,
  normalizeGrokBotWebhookPayload,
} from "../src/services/event-webhook.js";
import { registerEventNotifications } from "../src/notifications/events.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const SYNTHETIC_JID = "5500000000000@s.whatsapp.net";
const SYNTHETIC_CHAT = "5500000000000@s.whatsapp.net";

function messageWith(message: Record<string, unknown>, id = "SYNTHETIC-MESSAGE"): WAMessage {
  return {
    key: { id, remoteJid: SYNTHETIC_CHAT, fromMe: false },
    message: message as unknown as WAMessage["message"],
    messageTimestamp: 1_700_000_000,
    pushName: "Synthetic Sender",
  } as WAMessage;
}

function notifyEvent(message: WAMessage): NormalizedMessageEvent {
  const events = normalizeMessagesUpsert("synthetic-instance", {
    type: "notify",
    messages: [message],
  } as Parameters<typeof normalizeMessagesUpsert>[1]);
  const event = events[0];
  if (!event) throw new Error("Synthetic message did not normalize");
  return event;
}

describe("Baileys business and interactive message normalization", () => {
  it("extracts hydrated template text and URL, call, and quick reply buttons", () => {
    const details = extractMessageDetails(
      messageWith({
        templateMessage: {
          hydratedTemplate: {
            hydratedTitleText: "Synthetic title",
            hydratedContentText: "Synthetic body",
            hydratedFooterText: "Synthetic footer",
            hydratedButtons: [
              { urlButton: { displayText: "See details", url: "https://example.com/details" } },
              { callButton: { displayText: "Call us", phoneNumber: "+15550000000" } },
              { quickReplyButton: { displayText: "Continue", id: "synthetic-continue" } },
            ],
          },
        },
      }),
    );

    expect(details.type).toBe("text");
    expect(details.content).toContain("Synthetic title\nSynthetic body\nSynthetic footer");
    expect(details.buttons).toEqual([
      { type: "url", text: "See details", url: "https://example.com/details" },
      { type: "call", text: "Call us", phone: "+15550000000" },
      { type: "quick_reply", text: "Continue", id: "synthetic-continue" },
    ]);
  });

  it("extracts hydratedFourRowTemplate content and actions", () => {
    const details = extractMessageDetails(
      messageWith({
        templateMessage: {
          hydratedFourRowTemplate: {
            hydratedTitleText: "Synthetic hydrated heading",
            hydratedContentText: "Synthetic hydrated body",
            hydratedFooterText: "Synthetic hydrated footer",
            hydratedButtons: [
              { urlButton: { displayText: "Open page", url: "https://example.com/page" } },
            ],
          },
        },
      }),
    );

    expect(details.content).toContain("Synthetic hydrated heading\nSynthetic hydrated body");
    expect(details.content).toContain("Button: Open page — https://example.com/page");
    expect(details.buttons?.[0]).toEqual({
      type: "url",
      text: "Open page",
      url: "https://example.com/page",
    });
  });

  it("extracts fourRowTemplate HSM title, content, footer, and quick reply", () => {
    const details = extractMessageDetails(
      messageWith({
        templateMessage: {
          fourRowTemplate: {
            title: "highlyStructuredMessage",
            highlyStructuredMessage: { params: ["Synthetic legacy heading"] },
            content: { params: ["Synthetic legacy body"] },
            footer: { params: ["Synthetic legacy footer"] },
            buttons: [
              {
                quickReplyButton: {
                  displayText: { params: ["Choose option"] },
                  id: "synthetic-option",
                },
              },
            ],
          },
        },
      }),
    );

    expect(details.content).toContain(
      "Synthetic legacy heading\nSynthetic legacy body\nSynthetic legacy footer",
    );
    expect(details.buttons).toContainEqual({
      type: "quick_reply",
      text: "Choose option",
      id: "synthetic-option",
    });
  });

  it("extracts interactive text, native flow button parameters, and header media", () => {
    const details = extractMessageDetails(
      messageWith({
        interactiveMessage: {
          header: {
            title: "Synthetic account notice",
            subtitle: "Synthetic subtitle",
            imageMessage: {
              url: "https://example.com/synthetic-header.jpg",
              mimetype: "image/jpeg",
            },
          },
          body: { text: "Synthetic interactive body" },
          footer: { text: "Synthetic interactive footer" },
          nativeFlowMessage: {
            buttons: [
              {
                name: "cta_url",
                buttonParamsJson: JSON.stringify({
                  display_text: "Review details",
                  url: "https://example.com/review",
                  id: "synthetic-review",
                }),
              },
            ],
          },
        },
      }),
    );

    expect(details.type).toBe("image");
    expect(details.content).toContain(
      "Synthetic account notice\nSynthetic subtitle\nSynthetic interactive body\nSynthetic interactive footer",
    );
    expect(details.content).toContain("Button: Review details — https://example.com/review");
    expect(details.mediaUrl).toBe("https://example.com/synthetic-header.jpg");
    expect(details.mediaMimetype).toBe("image/jpeg");
    expect(details.buttons).toContainEqual({
      type: "cta_url",
      text: "Review details",
      url: "https://example.com/review",
      id: "synthetic-review",
    });
  });

  it("flattens simple interactive carousel cards", () => {
    const details = extractMessageDetails(
      messageWith({
        interactiveMessage: {
          body: { text: "Synthetic carousel intro" },
          carouselMessage: {
            cards: [
              {
                header: { title: "Synthetic card one" },
                body: { text: "Synthetic card detail" },
                footer: { text: "Synthetic card footer" },
                nativeFlowMessage: {
                  buttons: [
                    {
                      name: "cta_url",
                      buttonParamsJson: JSON.stringify({
                        display_text: "View card",
                        url: "https://example.com/card",
                      }),
                    },
                  ],
                },
              },
            ],
          },
        },
      }),
    );

    expect(details.content).toContain("Synthetic carousel intro");
    expect(details.content).toContain(
      "Synthetic card one\nSynthetic card detail\nSynthetic card footer",
    );
    expect(details.buttons).toContainEqual({
      type: "cta_url",
      text: "View card",
      url: "https://example.com/card",
    });
  });

  it("extracts buttonsMessage text, media header, and buttons", () => {
    const details = extractMessageDetails(
      messageWith({
        buttonsMessage: {
          headerType: 4,
          imageMessage: {
            url: "https://example.com/synthetic-buttons.jpg",
            mimetype: "image/jpeg",
          },
          contentText: "Synthetic button body",
          footerText: "Synthetic button footer",
          buttons: [{ buttonId: "synthetic-choice", buttonText: { displayText: "Pick this" } }],
        },
      }),
    );

    expect(details.type).toBe("image");
    expect(details.content).toContain("Synthetic button body\nSynthetic button footer");
    expect(details.mediaUrl).toBe("https://example.com/synthetic-buttons.jpg");
    expect(details.buttons).toContainEqual({
      type: "response",
      text: "Pick this",
      id: "synthetic-choice",
    });
  });

  it("extracts list title, description, button label, sections, and rows", () => {
    const details = extractMessageDetails(
      messageWith({
        listMessage: {
          title: "Synthetic list title",
          description: "Synthetic list description",
          buttonText: "Choose one",
          footerText: "Synthetic list footer",
          sections: [
            {
              title: "Synthetic section",
              rows: [
                {
                  title: "Synthetic row",
                  description: "Synthetic row detail",
                  rowId: "synthetic-row",
                },
              ],
            },
          ],
        },
      }),
    );

    expect(details.content).toContain(
      "Synthetic list title\nSynthetic list description\nChoose one\nSynthetic section\nSynthetic row — Synthetic row detail\nSynthetic list footer",
    );
    expect(details.buttons).toContainEqual({
      type: "list_row",
      text: "Synthetic row",
      id: "synthetic-row",
    });
  });

  it("uses hydratedHsm content as a highly structured message fallback", () => {
    const details = extractMessageDetails(
      messageWith({
        highlyStructuredMessage: {
          hydratedHsm: {
            hydratedTemplate: {
              hydratedTitleText: "Synthetic HSM title",
              hydratedContentText: "Synthetic HSM body",
              hydratedFooterText: "Synthetic HSM footer",
            },
          },
        },
      }),
    );

    expect(details.content).toBe("Synthetic HSM title\nSynthetic HSM body\nSynthetic HSM footer");
  });

  it("extracts button response selection text and identifiers", () => {
    const buttons = extractMessageDetails(
      messageWith({
        buttonsResponseMessage: {
          selectedDisplayText: "Synthetic selected button",
          selectedButtonId: "synthetic-button-id",
        },
      }),
    );
    const template = extractMessageDetails(
      messageWith({
        templateButtonReplyMessage: {
          selectedDisplayText: "Synthetic template selection",
          selectedId: "synthetic-template-id",
        },
      }),
    );
    const list = extractMessageDetails(
      messageWith({
        listResponseMessage: {
          title: "Synthetic selected row",
          description: "Synthetic response detail",
          singleSelectReply: { selectedRowId: "synthetic-row-id" },
        },
      }),
    );

    expect(buttons.content).toContain("Synthetic selected button");
    expect(buttons.buttons?.[0]?.id).toBe("synthetic-button-id");
    expect(template.content).toContain("Synthetic template selection");
    expect(template.buttons?.[0]?.id).toBe("synthetic-template-id");
    expect(list.content).toContain("Synthetic response detail");
    expect(list.buttons?.[0]?.id).toBe("synthetic-row-id");
  });

  it("extracts interactiveResponse body and native flow response parameters", () => {
    const details = extractMessageDetails(
      messageWith({
        interactiveResponseMessage: {
          body: { text: "Synthetic interactive selection" },
          nativeFlowResponseMessage: {
            name: "single_select",
            paramsJson: JSON.stringify({
              display_text: "Synthetic selected item",
              id: "synthetic-response-id",
              url: "https://example.com/selected",
            }),
          },
        },
      }),
    );

    expect(details.content).toContain("Synthetic interactive selection");
    expect(details.content).toContain("Synthetic selected item");
    expect(details.buttons).toContainEqual({
      type: "single_select",
      text: "Synthetic selected item",
      id: "synthetic-response-id",
      url: "https://example.com/selected",
    });
  });

  it.each([
    [
      "ephemeralMessage",
      { ephemeralMessage: { message: { conversation: "Synthetic wrapped text" } } },
    ],
    [
      "viewOnceMessage",
      { viewOnceMessage: { message: { conversation: "Synthetic wrapped text" } } },
    ],
    [
      "viewOnceMessageV2",
      { viewOnceMessageV2: { message: { conversation: "Synthetic wrapped text" } } },
    ],
    [
      "viewOnceMessageV2Extension",
      { viewOnceMessageV2Extension: { message: { conversation: "Synthetic wrapped text" } } },
    ],
    ["editedMessage", { editedMessage: { message: { conversation: "Synthetic wrapped text" } } }],
  ])("unwraps %s before extracting text", (_name, wrapped) => {
    expect(extractMessageDetails(messageWith(wrapped)).content).toBe("Synthetic wrapped text");
  });

  it("unwraps documentWithCaptionMessage and returns its media metadata", () => {
    const details = extractMessageDetails(
      messageWith({
        documentWithCaptionMessage: {
          message: {
            documentMessage: {
              caption: "Synthetic document caption",
              fileName: "synthetic.pdf",
              mimetype: "application/pdf",
              url: "https://example.com/synthetic.pdf",
            },
          },
        },
      }),
    );

    expect(details.type).toBe("document");
    expect(details.content).toBe("Synthetic document caption");
    expect(details.mediaMimetype).toBe("application/pdf");
    expect(details.mediaUrl).toBe("https://example.com/synthetic.pdf");
  });

  it("preserves the normal image, video, audio, and document media kinds", () => {
    const cases = [
      [
        { imageMessage: { caption: "Synthetic image caption", mimetype: "image/jpeg" } },
        "image",
        "Synthetic image caption",
        "image/jpeg",
      ],
      [
        { videoMessage: { caption: "Synthetic video caption", mimetype: "video/mp4" } },
        "video",
        "Synthetic video caption",
        "video/mp4",
      ],
      [{ audioMessage: { mimetype: "audio/ogg" } }, "audio", null, "audio/ogg"],
      [
        { documentMessage: { caption: "Synthetic file caption", mimetype: "application/pdf" } },
        "document",
        "Synthetic file caption",
        "application/pdf",
      ],
    ] as const;

    for (const [payload, type, content, mimetype] of cases) {
      const details = extractMessageDetails(messageWith(payload));
      expect(details.type).toBe(type);
      expect(details.content).toBe(content);
      expect(details.mediaMimetype).toBe(mimetype);
    }
  });

  it("unwraps protocolMessage.editedMessage for parsing and edit events", () => {
    const message = messageWith({
      protocolMessage: {
        key: { id: "SYNTHETIC-ORIGINAL" },
        type: 14,
        editedMessage: { conversation: "Synthetic edited text" },
      },
    });

    expect(extractMessageDetails(message).content).toBe("Synthetic edited text");
    expect(normalizeMessageEdit("synthetic-instance", message, SYNTHETIC_CHAT).newContent).toBe(
      "Synthetic edited text",
    );
    expect(
      normalizeMessagesUpsert("synthetic-instance", {
        type: "notify",
        messages: [message],
      } as Parameters<typeof normalizeMessagesUpsert>[1]),
    ).toEqual([]);
  });

  it("unwraps deeply nested supported containers within the bounded depth", () => {
    let nested: Record<string, unknown> = { conversation: "Synthetic deep wrapped text" };
    for (let depth = 0; depth < 10; depth++) {
      nested = { ephemeralMessage: { message: nested } };
    }

    expect(extractMessageDetails(messageWith(nested)).content).toBe("Synthetic deep wrapped text");
  });

  it("keeps an unknown Baileys type name instead of silently returning text", () => {
    const details = extractMessageDetails(
      messageWith({ futureBusinessMessage: { opaque: "synthetic" } }),
    );

    expect(details.type).toBe("unknown");
    expect(details.content).toBeNull();
    expect(details.rawType).toBe("futureBusinessMessage");
  });

  it("handles malformed native flow button JSON without throwing", () => {
    const details = extractMessageDetails(
      messageWith({
        interactiveMessage: {
          body: { text: "Synthetic malformed button" },
          nativeFlowMessage: {
            buttons: [{ name: "cta_url", buttonParamsJson: "{not-json" }],
          },
        },
      }),
    );

    expect(details.content).toContain("Synthetic malformed button");
    expect(details.buttons).toEqual([{ type: "cta_url", text: "cta_url" }]);
  });

  it("surfaces normalized content, buttons, media, and raw type to webhooks and notifications", async () => {
    const received = notifyEvent(
      messageWith({
        templateMessage: {
          hydratedTemplate: {
            hydratedTitleText: "Synthetic event title",
            hydratedContentText: "Synthetic event body",
            hydratedButtons: [
              { urlButton: { displayText: "Open", url: "https://example.com/open" } },
            ],
            imageMessage: {
              mimetype: "image/jpeg",
              url: "https://example.com/synthetic-event.jpg",
            },
          },
        },
      }),
    );
    const generic = normalizeEventWebhookPayload(
      "message.received",
      "synthetic-instance",
      received,
    );
    const grok = normalizeGrokBotWebhookPayload("synthetic-instance", received);
    expect(generic.text).toContain("Synthetic event title\nSynthetic event body");
    expect(generic.buttons?.[0]?.url).toBe("https://example.com/open");
    expect(generic.mediaUrl).toBe("https://example.com/synthetic-event.jpg");
    expect(grok.buttons?.[0]?.text).toBe("Open");
    expect(grok.mediaUrl).toBe("https://example.com/synthetic-event.jpg");
    expect(grok.mediaMimetype).toBe("image/jpeg");

    let eventHandler:
      | ((event: "message.received", instanceId: string, payload: NormalizedMessageEvent) => void)
      | undefined;
    const manager = {
      onAnyEvent: (handler: typeof eventHandler) => {
        eventHandler = handler;
        return () => undefined;
      },
    } as unknown as InstanceManager;
    const notification = vi.fn().mockResolvedValue(undefined);
    const server = {
      server: {
        notification,
        sendLoggingMessage: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as McpServer;

    registerEventNotifications(server, manager);
    eventHandler?.("message.received", "synthetic-instance", received);
    await vi.waitFor(() => expect(notification).toHaveBeenCalledTimes(1));
    const sent = notification.mock.calls[0]?.[0] as {
      params: { message: { buttons?: Array<{ text: string }>; content: string | null } };
    };
    expect(sent.params.message.content).toContain("Synthetic event title");
    expect(sent.params.message.buttons?.[0]?.text).toBe("Open");
  });

  it("persists structured message additions for wa_get_messages using existing raw_data storage", async () => {
    const instanceId = `synthetic-business-${randomUUID()}`;
    const id = "SYNTHETIC-STORED-BUSINESS-MESSAGE";
    const message = messageWith(
      {
        interactiveMessage: {
          header: {
            title: "Synthetic stored title",
            imageMessage: {
              mimetype: "image/jpeg",
              url: "https://example.com/synthetic-stored.jpg",
            },
          },
          body: { text: "Synthetic stored body" },
          nativeFlowMessage: {
            buttons: [
              {
                name: "cta_url",
                buttonParamsJson: JSON.stringify({
                  display_text: "See stored details",
                  url: "https://example.com/stored-details",
                  id: "synthetic-stored-id",
                }),
              },
            ],
          },
        },
      },
      id,
    );

    sqlite
      .prepare(
        "INSERT INTO instances (id, name, channel, status, created_at, updated_at) VALUES (?, ?, 'baileys', 'disconnected', 1700000000, 1700000000)",
      )
      .run(instanceId, "Synthetic business fixture");

    try {
      const adapter = new BaileysAdapter(instanceId);
      const event = normalizeMessagesUpsert(instanceId, {
        type: "notify",
        messages: [message],
      } as Parameters<typeof normalizeMessagesUpsert>[1])[0];
      if (!event) throw new Error("Synthetic message did not normalize");
      (
        adapter as unknown as {
          persistMessage: (normalized: NormalizedMessageEvent, source: WAMessage) => void;
        }
      ).persistMessage(event, message);

      const unknownMessage = messageWith(
        { futureBusinessMessage: { opaque: "synthetic" } },
        "SYNTHETIC-STORED-UNKNOWN-MESSAGE",
      );
      const unknownEvent = normalizeMessagesUpsert(instanceId, {
        type: "notify",
        messages: [unknownMessage],
      } as Parameters<typeof normalizeMessagesUpsert>[1])[0];
      if (!unknownEvent) throw new Error("Synthetic unknown message did not normalize");
      (
        adapter as unknown as {
          persistMessage: (normalized: NormalizedMessageEvent, source: WAMessage) => void;
        }
      ).persistMessage(unknownEvent, unknownMessage);

      const stored = await adapter.getMessages(SYNTHETIC_JID, 10);
      const found = stored.find((item) => item.id === id);
      expect(found).toMatchObject({
        type: "image",
        content: expect.stringContaining("Synthetic stored body"),
        mediaUrl: "https://example.com/synthetic-stored.jpg",
        mediaMimetype: "image/jpeg",
        buttons: [
          {
            type: "cta_url",
            text: "See stored details",
            url: "https://example.com/stored-details",
            id: "synthetic-stored-id",
          },
        ],
      });
      expect(stored.find((item) => item.id === unknownMessage.key.id)).toMatchObject({
        type: "unknown",
        rawType: "futureBusinessMessage",
      });
    } finally {
      sqlite.prepare("DELETE FROM instances WHERE id = ?").run(instanceId);
    }
  });
});
