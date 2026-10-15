import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WASocket } from "@whiskeysockets/baileys";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { eq } from "drizzle-orm";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { db } from "../src/db/client.js";
import { instances } from "../src/db/schema.js";
import type { ContactStore } from "../src/services/contact-store.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import type { MessageQueue } from "../src/services/message-queue.js";
import { SendTextStatusSchema } from "../src/schemas/status.schema.js";
import { registerStatusTools } from "../src/tools/status.tools.js";

const OWN_JID = "5500000000001@s.whatsapp.net";
const CONTACT_JID = "5500000000002@s.whatsapp.net";

function createAdapter(options?: { ownJid?: string; contacts?: string[]; maxRecipients?: number }) {
  if (options?.maxRecipients !== undefined) {
    vi.stubEnv("WA_STATUS_MAX_RECIPIENTS", String(options.maxRecipients));
  } else {
    vi.stubEnv("WA_STATUS_MAX_RECIPIENTS", undefined);
  }

  const contactStore = {
    getContacts: vi.fn(() => (options?.contacts ?? []).map((jid) => ({ jid }))),
  } as unknown as ContactStore;
  const sendMessage = vi.fn(async () => ({ key: { id: "SYNTHETIC-STATUS-MESSAGE" } }));
  const sock = {
    user: options?.ownJid ? { id: options.ownJid } : undefined,
    sendMessage,
  } as unknown as WASocket;
  const adapter = new BaileysAdapter("synthetic-status-instance", contactStore);
  Object.assign(adapter, { sock, status: "connected" });
  return { adapter, contactStore, sendMessage };
}

describe("Baileys status audiences", () => {
  beforeEach(() => {
    const now = Date.now();
    db.insert(instances)
      .values({ id: "synthetic-status-instance", name: "test", createdAt: now, updatedAt: now })
      .run();
  });

  afterEach(() => {
    db.delete(instances).where(eq(instances.id, "synthetic-status-instance")).run();
    vi.unstubAllEnvs();
  });

  it("sends the normalized owner and deduplicated individual contacts with text styling", async () => {
    const { adapter, sendMessage } = createAdapter({
      ownJid: "5500000000001:7@s.whatsapp.net",
      contacts: [
        OWN_JID,
        CONTACT_JID,
        "5500000000002:4@s.whatsapp.net",
        "5500000000003-1700000000000@g.us",
        "5500000000004@broadcast",
        "5500000000005@newsletter",
        "status@broadcast",
        "5500000000006@lid",
      ],
    });

    const result = await adapter.sendStatus({
      type: "text",
      text: "Synthetic status",
      backgroundColor: "#FF5733",
      font: 2,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "status@broadcast",
      { text: "Synthetic status" },
      {
        statusJidList: [OWN_JID, CONTACT_JID, "5500000000006@lid"],
        broadcast: true,
        backgroundColor: "#FF5733",
        font: 2,
      },
    );
    expect(result).toEqual({
      messageId: "SYNTHETIC-STATUS-MESSAGE",
      recipientCount: 3,
      omittedRecipientCount: 0,
    });
  });

  it("uses an explicit audience, adds the owner, and normalizes duplicates", async () => {
    const { adapter, sendMessage, contactStore } = createAdapter({
      ownJid: "5500000000001:2@s.whatsapp.net",
      contacts: [CONTACT_JID],
    });

    await adapter.sendStatus({
      type: "image",
      media: "https://example.com/synthetic-image.jpg",
      statusJidList: [
        "5500000000003",
        "5500000000003@s.whatsapp.net",
        "5500000000004:9@s.whatsapp.net",
      ],
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "status@broadcast",
      { image: { url: "https://example.com/synthetic-image.jpg" }, caption: undefined },
      {
        statusJidList: [OWN_JID, "5500000000003@s.whatsapp.net", "5500000000004@s.whatsapp.net"],
        broadcast: true,
      },
    );
    expect(contactStore.getContacts).not.toHaveBeenCalled();
  });

  it("applies the configured recipient cap and reports truncation", async () => {
    const { adapter, sendMessage } = createAdapter({
      ownJid: OWN_JID,
      contacts: [CONTACT_JID, "5500000000003@s.whatsapp.net"],
      maxRecipients: 2,
    });

    const result = await adapter.sendStatus({
      type: "video",
      media: "https://example.com/synthetic-video.mp4",
    });

    expect(result.recipientCount).toBe(2);
    expect(result.omittedRecipientCount).toBe(1);
    expect(result.warning).toContain("WA_STATUS_MAX_RECIPIENTS (2)");
    expect(result.warning).toContain("1 recipient(s) were omitted");
    expect(sendMessage).toHaveBeenCalledWith(
      "status@broadcast",
      { video: { url: "https://example.com/synthetic-video.mp4" }, caption: undefined },
      { statusJidList: [OWN_JID, CONTACT_JID], broadcast: true },
    );
  });

  it("fails when no eligible recipients remain", async () => {
    const { adapter, sendMessage } = createAdapter({
      contacts: ["5500000000003-1700000000000@g.us", "status@broadcast"],
    });

    await expect(adapter.sendStatus({ type: "text", text: "Synthetic status" })).rejects.toThrow(
      "Cannot send status: the audience is empty",
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("returns message IDs, recipient counts, and cap warnings from every send-status tool", async () => {
    const { adapter, sendMessage } = createAdapter({
      ownJid: OWN_JID,
      contacts: [CONTACT_JID, "5500000000003@s.whatsapp.net"],
      maxRecipients: 2,
    });
    const handlers = new Map<string, (params: unknown) => Promise<unknown>>();
    const server = {
      registerTool(name: string, _config: unknown, handler: (params: unknown) => Promise<unknown>) {
        handlers.set(name, handler);
      },
    } as unknown as McpServer;
    const instanceManager = { getAdapter: () => adapter } as unknown as InstanceManager;
    registerStatusTools(server, instanceManager, {} as MessageQueue);

    const cases = [
      ["wa_send_text_status", { text: "Synthetic status" }],
      ["wa_send_image_status", { image: "https://example.com/status.jpg" }],
      ["wa_send_video_status", { video: "https://example.com/status.mp4" }],
    ] as const;
    for (const [toolName, content] of cases) {
      const handler = handlers.get(toolName);
      if (!handler) throw new Error(`Synthetic status tool ${toolName} was not registered`);
      const response = (await handler({
        instanceId: "synthetic-status-instance",
        ...content,
        statusJidList: ["5500000000004", "5500000000005"],
      })) as {
        content: { text: string }[];
      };

      expect(JSON.parse(response.content[0]!.text)).toEqual({
        success: true,
        messageId: "SYNTHETIC-STATUS-MESSAGE",
        recipientCount: 2,
        omittedRecipientCount: 1,
        warning: expect.stringContaining("WA_STATUS_MAX_RECIPIENTS (2)"),
      });
    }
    expect(sendMessage).toHaveBeenCalledWith(
      "status@broadcast",
      { text: "Synthetic status" },
      { statusJidList: [OWN_JID, "5500000000004@s.whatsapp.net"], broadcast: true },
    );
  });

  it("validates explicit recipients and RGB/ARGB colors in the tool schema", () => {
    const base = { instanceId: "synthetic-status-instance", text: "Synthetic status" };

    expect(
      SendTextStatusSchema.safeParse({
        ...base,
        statusJidList: ["5500000000002", "5500000000006@lid"],
        backgroundColor: "#FFFF5733",
        font: 3,
      }).success,
    ).toBe(true);
    expect(SendTextStatusSchema.safeParse({ ...base, backgroundColor: "#GG5733" }).success).toBe(
      false,
    );
    expect(
      SendTextStatusSchema.safeParse({
        ...base,
        statusJidList: ["5500000000003-1700000000000@g.us"],
      }).success,
    ).toBe(false);
  });
});
