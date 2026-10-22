import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WASocket } from "@whiskeysockets/baileys";
import { ALL_WA_PATCH_NAMES } from "@whiskeysockets/baileys";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import * as schema from "../src/db/schema.js";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import { CloudApiAdapter } from "../src/channels/cloud-api/cloud.adapter.js";
import type { ChannelAdapter } from "../src/channels/channel.interface.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import type { MessageQueue } from "../src/services/message-queue.js";
import { ContactStore } from "../src/services/contact-store.js";
import { registerContactTools } from "../src/tools/contact.tools.js";

type RegisteredTool = {
  inputSchema: z.ZodType;
  handler: (params: unknown) => Promise<unknown>;
};

type ToolResult = {
  isError?: boolean;
  content: Array<{ text?: string }>;
};

let directory: string | undefined;
let sqlite: Database.Database | undefined;

afterEach(() => {
  sqlite?.close();
  sqlite = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function createStore(): ContactStore {
  directory = mkdtempSync(join(tmpdir(), "wa-mcp-contact-resync-"));
  sqlite = new Database(join(directory, "contacts.db"));
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'baileys',
      status TEXT NOT NULL DEFAULT 'disconnected',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE contacts (
      instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      jid TEXT NOT NULL,
      name TEXT,
      name_source TEXT,
      notify_name TEXT,
      phone TEXT,
      lid TEXT,
      profile_pic_url TEXT,
      is_business INTEGER NOT NULL DEFAULT 0,
      is_blocked INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (instance_id, jid)
    );
    CREATE TABLE chats (
      instance_id TEXT NOT NULL,
      jid TEXT NOT NULL,
      name TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      is_from_me INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL,
      push_name TEXT
    );
  `);
  sqlite
    .prepare(
      "INSERT INTO instances (id, name, channel, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("resync-instance", "Synthetic instance", "baileys", "connected", 1, 1);

  return new ContactStore("resync-instance", drizzle(sqlite, { schema }));
}

function registerTools(adapter: ChannelAdapter): Map<string, RegisteredTool> {
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
  } as unknown as InstanceManager;

  registerContactTools(server, instanceManager, {} as MessageQueue);
  return tools;
}

async function invoke(tool: RegisteredTool, input: unknown): Promise<ToolResult> {
  const params = tool.inputSchema.parse(input);
  return (await tool.handler(params)) as ToolResult;
}

describe("wa_resync_contacts", () => {
  it("runs app-state collections individually and reports partial failures", async () => {
    const contactStore = createStore();
    const jid = "15555550999@s.whatsapp.net";
    let processEvents: ((events: Record<string, unknown>) => Promise<void>) | undefined;
    const socket = {
      ev: {
        on: vi.fn(),
        isBuffering: vi.fn(() => false),
        process: vi.fn((handler: unknown) => {
          processEvents = handler as (events: Record<string, unknown>) => Promise<void>;
        }),
      },
      signalRepository: {
        lidMapping: { getPNForLID: vi.fn(async () => null) },
      },
      resyncAppState: vi.fn(async (collections: readonly string[]) => {
        if (collections[0] === ALL_WA_PATCH_NAMES[0]) {
          await processEvents?.({
            "contacts.upsert": [{ id: jid, name: "Saved app-state name", notify: "Profile name" }],
          });
        }
        if (collections[0] === ALL_WA_PATCH_NAMES[1]) {
          throw new Error("Synthetic collection failure");
        }
      }),
    } as unknown as WASocket;
    const adapter = new BaileysAdapter("resync-instance", contactStore);
    const saveCreds = vi.fn(async () => {});
    Object.assign(
      adapter as unknown as { sock: WASocket | null; status: string; saveCreds: typeof saveCreds },
      {
        sock: socket,
        status: "connected",
        saveCreds,
      },
    );
    (adapter as unknown as { bindEvents: (sock: WASocket) => void }).bindEvents(socket);

    const tool = registerTools(adapter).get("wa_resync_contacts");
    expect(tool).toBeDefined();
    const result = await invoke(tool!, { instanceId: "resync-instance" });
    const data = JSON.parse(result.content[0]?.text ?? "{}");

    expect(result.isError).toBeUndefined();
    expect(data.contactsBefore).toBe(0);
    expect(data.contactsAfter).toBe(1);
    expect(data.added).toBe(1);
    expect(data.sources.appState.collections).toHaveLength(ALL_WA_PATCH_NAMES.length);
    expect(data.sources.appState.collections[0]).toMatchObject({
      collection: ALL_WA_PATCH_NAMES[0],
      success: true,
      contactsAdded: 1,
    });
    expect(data.sources.appState.collections[1]).toMatchObject({
      collection: ALL_WA_PATCH_NAMES[1],
      success: false,
      contactsAdded: 0,
      error: "Synthetic collection failure",
    });
    expect(data.sources.localStore).toEqual({
      chats: { candidates: 0, contactsAdded: 0 },
      messages: { candidates: 0, contactsAdded: 0 },
    });
    expect(socket.resyncAppState).toHaveBeenCalledTimes(ALL_WA_PATCH_NAMES.length);
    for (const collection of ALL_WA_PATCH_NAMES) {
      expect(socket.resyncAppState).toHaveBeenCalledWith([collection], false);
    }
    expect(saveCreds).not.toHaveBeenCalled();
    expect(contactStore.getContacts()).toEqual([
      expect.objectContaining({
        jid,
        name: "Saved app-state name",
        notifyName: "Profile name",
      }),
    ]);
  });

  it("returns a clear unsupported error for the Cloud API channel", async () => {
    const tool = registerTools(new CloudApiAdapter("resync-instance")).get("wa_resync_contacts");
    expect(tool).toBeDefined();

    const result = await invoke(tool!, { instanceId: "resync-instance" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Contact resync is not supported on Cloud API");
  });
});
