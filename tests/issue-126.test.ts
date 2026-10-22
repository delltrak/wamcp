import { createHash } from "node:crypto";
import {
  lstat,
  lutimes,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proto, type BinaryNode, type WASocket } from "@whiskeysockets/baileys";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { BaileysAdapter } from "../src/channels/baileys/baileys.adapter.js";
import * as newsletterMedia from "../src/channels/baileys/newsletter-media.js";
import { CloudApiAdapter } from "../src/channels/cloud-api/cloud.adapter.js";
import type { ContactStore } from "../src/services/contact-store.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import type { MessageQueue } from "../src/services/message-queue.js";
import { ExportGroupParticipantsSchema } from "../src/schemas/group.schema.js";
import { DownloadNewsletterMediaSchema } from "../src/schemas/newsletter.schema.js";
import { registerGroupTools } from "../src/tools/group.tools.js";
import { registerNewsletterTools } from "../src/tools/newsletter.tools.js";
import { EXPORT_RETENTION_MS, saveDataDirectoryFile } from "../src/services/data-export.js";
import { renderGroupParticipantsCsv } from "../src/utils/group-participants-csv.js";

type RegisteredTool = {
  inputSchema: z.ZodType;
  handler: (params: unknown) => Promise<unknown>;
};

type ToolResult = { isError?: boolean; content: Array<{ text?: string }> };

const INSTANCE_ID = "issue-126";
const GROUP_JID = "120363000000000000@g.us";
const NEWSLETTER_JID = "123456789012345@newsletter";
const OWN_PN = "5511999990000@s.whatsapp.net";
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.WA_DATABASE_PATH;
  delete process.env.WA_MEDIA_DOWNLOAD_DIR;
  delete process.env.WA_GROUP_WRITES_ENABLED;
  delete process.env.WA_APP_STATE_WRITES_ENABLED;
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function resultData(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

function register(
  registerFn: (
    server: McpServer,
    instanceManager: InstanceManager,
    messageQueue: MessageQueue,
  ) => void,
  adapter: unknown,
): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (name: string, options: unknown, handler: unknown) => {
      tools.set(name, {
        inputSchema: (options as { inputSchema: z.ZodType }).inputSchema,
        handler: handler as (params: unknown) => Promise<unknown>,
      });
    },
  } as unknown as McpServer;
  const instanceManager = { getAdapter: () => adapter } as unknown as InstanceManager;
  registerFn(server, instanceManager, {} as MessageQueue);
  return tools;
}

async function tempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function newsletterMessage(serverId: string, id: string, message: proto.IMessage): BinaryNode {
  return {
    tag: "message",
    attrs: { id, server_id: serverId, t: "1700000000" },
    content: [{ tag: "plaintext", attrs: {}, content: proto.Message.encode(message).finish() }],
  };
}

function newsletterIq(messages: BinaryNode[]): BinaryNode {
  return {
    tag: "iq",
    attrs: { type: "result" },
    content: [{ tag: "messages", attrs: {}, content: messages }],
  };
}

describe("group participant CSV", () => {
  it("writes one spreadsheet row per participant with empty phone and escaped text", () => {
    const csv = renderGroupParticipantsCsv([
      {
        jid: "5511999990000@s.whatsapp.net",
        phone: "5511999990000",
        lid: null,
        name: 'Ana, "Lia"',
        pushName: "=cmd",
        role: "admin",
      },
      {
        jid: "1999990002@lid",
        phone: null,
        lid: "1999990002@lid",
        name: null,
        pushName: "Only Push",
        role: "member",
      },
    ]);

    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.replace(/^\uFEFF/, "").split("\r\n")).toEqual([
      "jid,phone,lid,name,push_name,role",
      '5511999990000@s.whatsapp.net,5511999990000,,"Ana, ""Lia""",\'=cmd,admin',
      "1999990002@lid,,1999990002@lid,,Only Push,member",
      "",
    ]);
  });

  it("saves a CSV in the data directory and returns its path", async () => {
    const directory = await tempDirectory("wamcp-group-csv-");
    process.env.WA_DATABASE_PATH = join(directory, "whatsapp.db");
    delete process.env.WA_GROUP_WRITES_ENABLED;
    delete process.env.WA_APP_STATE_WRITES_ENABLED;
    const findByIdentities = vi.fn(() => ({
      truncated: false,
      contacts: [
        {
          jid: "5511777770000@s.whatsapp.net",
          lid: "1999990001@lid",
          phone: "5511777770000",
          name: "Saved Person",
          notifyName: "Push Person",
        },
      ],
    }));
    const contactStore = { findByIdentities } as unknown as ContactStore;
    const groupMetadata = vi.fn(async () => ({
      id: GROUP_JID,
      subject: "Support",
      participants: [
        { id: OWN_PN, admin: "admin", name: "Owner Saved", notify: "Owner Push" },
        {
          id: "1999990001@lid",
          lid: "1999990001@lid",
          phoneNumber: "5511777770000@s.whatsapp.net",
          admin: "superadmin",
        },
        { id: "1999990002@lid", notify: "Only Push" },
      ],
    }));
    const adapter = new BaileysAdapter(INSTANCE_ID, contactStore);
    Object.assign(adapter, {
      status: "connected",
      sock: {
        user: { id: OWN_PN },
        signalRepository: { lidMapping: { getPNForLID: vi.fn(async () => null) } },
        groupMetadata,
      } as unknown as WASocket,
    });
    const tool = register(registerGroupTools, adapter).get("wa_export_group_participants");
    if (!tool) throw new Error("export tool was not registered");

    const response = (await tool.handler(
      tool.inputSchema.parse({ instanceId: INSTANCE_ID, groupJid: "120363000000000000" }),
    )) as ToolResult;
    const body = resultData(response);
    const savedPath = String(body.path);
    const csv = await readFile(savedPath, "utf8");

    expect(response.isError).toBeUndefined();
    expect(groupMetadata).toHaveBeenCalledWith(GROUP_JID);
    expect(body).toMatchObject({
      groupJid: GROUP_JID,
      participantCount: 3,
      contactsTruncated: false,
      mimeType: "text/csv",
      fileName: "group-120363000000000000_g.us-participants.csv",
    });
    expect(resolve(savedPath).startsWith(await realpath(resolve(directory, "exports")))).toBe(true);
    expect((await stat(savedPath)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(savedPath))).mode & 0o777).toBe(0o700);
    expect(csv.replace(/^\uFEFF/, "").split("\r\n")).toEqual([
      "jid,phone,lid,name,push_name,role",
      `${OWN_PN},5511999990000,,Owner Saved,Owner Push,admin`,
      "1999990001@lid,5511777770000,1999990001@lid,Saved Person,Push Person,superadmin",
      "1999990002@lid,,1999990002@lid,,Only Push,member",
      "",
    ]);
    expect(
      ExportGroupParticipantsSchema.safeParse({ instanceId: INSTANCE_ID, extra: true }).success,
    ).toBe(false);
  });

  it("rejects the export on Cloud API", async () => {
    const tool = register(registerGroupTools, new CloudApiAdapter(INSTANCE_ID)).get(
      "wa_export_group_participants",
    );
    if (!tool) throw new Error("export tool was not registered");
    const response = (await tool.handler(
      tool.inputSchema.parse({ instanceId: INSTANCE_ID, groupJid: GROUP_JID }),
    )) as ToolResult;

    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain("not supported on Cloud API");
  });

  it("refuses an exports directory symlink before deleting files outside the data directory", async () => {
    const directory = await tempDirectory("wamcp-export-link-");
    const outside = await tempDirectory("wamcp-outside-");
    const stalePath = join(outside, "keep.csv");
    await writeFile(stalePath, "private");
    const expired = new Date(Date.now() - EXPORT_RETENTION_MS - 60000);
    await utimes(stalePath, expired, expired);
    await symlink(outside, join(directory, "exports"));
    process.env.WA_DATABASE_PATH = join(directory, "whatsapp.db");
    await expect(saveDataDirectoryFile(Buffer.from("csv"), "group.csv")).rejects.toThrow(
      "symbolic link",
    );
    expect(await readFile(stalePath, "utf8")).toBe("private");
  });

  it.each([" =1+1", "\n=1+1", "\t+1", "\r@SUM(1)"])(
    "neutralizes spreadsheet formulas after whitespace: %j",
    (name) => {
      const csv = renderGroupParticipantsCsv([
        { jid: "12345@lid", phone: null, lid: null, name, pushName: null, role: "member" },
      ]);
      expect(csv).toContain("'" + name);
    },
  );

  it("keeps exports private and deletes files older than the retention window", async () => {
    const directory = await tempDirectory("wamcp-export-retention-");
    process.env.WA_DATABASE_PATH = join(directory, "whatsapp.db");
    const saved = await saveDataDirectoryFile(Buffer.from("fresh"), "fresh.csv");
    const exportsDir = dirname(saved.path);
    const stalePath = join(exportsDir, "stale.csv");
    const recentPath = join(exportsDir, "recent.csv");
    const outside = join(directory, "secret.txt");
    const linkPath = join(exportsDir, "link.csv");
    await writeFile(stalePath, "old", { mode: 0o600 });
    await writeFile(recentPath, "recent", { mode: 0o600 });
    await writeFile(outside, "keep", { mode: 0o600 });
    await symlink(outside, linkPath);
    const expired = new Date(Date.now() - EXPORT_RETENTION_MS - 60_000);
    await utimes(stalePath, expired, expired);
    await lutimes(linkPath, expired, expired);

    await saveDataDirectoryFile(Buffer.from("again"), "again.csv");

    expect((await stat(exportsDir)).mode & 0o777).toBe(0o700);
    await expect(stat(stalePath)).rejects.toThrow();
    expect((await stat(recentPath)).isFile()).toBe(true);
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(outside, "utf8")).toBe("keep");
  });
});

describe("channel post media", () => {
  it("reads image media from a newsletter messages IQ and ignores text posts", () => {
    const image = newsletterMessage("102", "message-102", {
      imageMessage: {
        mimetype: "image/jpeg",
        url: "https://mmg.whatsapp.net/v/example",
        directPath: "/v/example",
        mediaKey: new Uint8Array(32).fill(7),
        fileLength: 12,
        caption: "Photo",
      },
    });
    const wrapped = newsletterIq([
      newsletterMessage("101", "message-101", { conversation: "hello" }),
      image,
    ]);

    expect(newsletterMedia.findNewsletterPostMedia(wrapped, "102")).toMatchObject({
      status: "ready",
      media: {
        messageId: "message-102",
        serverId: "102",
        mediaType: "image",
        mimeType: "image/jpeg",
        fileLength: 12,
        encrypted: true,
      },
    });
    expect(newsletterMedia.findNewsletterPostMedia(wrapped, "101")).toEqual({
      status: "no-media",
      messageId: "message-101",
    });
    expect(newsletterMedia.findNewsletterPostMedia(wrapped, "999")).toEqual({ status: "missing" });
    expect(
      newsletterMedia.findNewsletterPostMedia(
        newsletterIq([
          newsletterMessage("7", "doc-7", {
            documentWithCaptionMessage: {
              message: {
                documentMessage: {
                  mimetype: "application/pdf",
                  fileName: "notes.pdf",
                  directPath: "/v/doc",
                  mediaKey: new Uint8Array(32).fill(1),
                },
              },
            },
          }),
        ]),
        "doc-7",
      ),
    ).toMatchObject({
      status: "ready",
      media: { mediaType: "document", fileName: "notes.pdf", mimeType: "application/pdf" },
    });
  });

  it("refuses media larger than the download cap before fetching bytes", async () => {
    await expect(
      newsletterMedia.readNewsletterMediaBytes(
        {
          messageId: "1",
          serverId: "1",
          mediaType: "image",
          mimeType: "image/jpeg",
          fileLength: 100,
          encrypted: true,
          downloadable: { mediaKey: new Uint8Array(32), url: "https://example.com/media" },
        },
        10,
      ),
    ).rejects.toThrow("maximum download size of 10 bytes");
  });

  it("queries a numeric server id with an exclusive after cursor and saves the file", async () => {
    const directory = await tempDirectory("wamcp-channel-media-");
    process.env.WA_MEDIA_DOWNLOAD_DIR = directory;
    const payload = Buffer.from("jpeg-bytes");
    const readSpy = vi
      .spyOn(newsletterMedia, "readNewsletterMediaBytes")
      .mockResolvedValue(payload);
    const query = vi.fn(async () =>
      newsletterIq([
        newsletterMessage("102", "message-102", {
          imageMessage: {
            mimetype: "image/jpeg",
            url: "https://mmg.whatsapp.net/v/example",
            mediaKey: new Uint8Array(32).fill(3),
            fileLength: payload.length,
          },
        }),
      ]),
    );
    const adapter = new BaileysAdapter(INSTANCE_ID);
    Object.assign(adapter, {
      status: "connected",
      sock: {
        user: { id: OWN_PN },
        generateMessageTag: () => "query-1",
        query,
      } as unknown as WASocket,
    });
    const tool = register(registerNewsletterTools, adapter).get("wa_download_newsletter_media");
    if (!tool) throw new Error("download tool was not registered");

    const response = (await tool.handler(
      tool.inputSchema.parse({
        instanceId: INSTANCE_ID,
        newsletterJid: NEWSLETTER_JID,
        messageId: "102",
      }),
    )) as ToolResult;
    const body = resultData(response);

    expect(query).toHaveBeenCalledTimes(1);
    const request = query.mock.calls[0]?.[0] as BinaryNode;
    expect(request.content?.[0]).toMatchObject({
      tag: "message_updates",
      attrs: { count: "1", since: "0", after: "101" },
    });
    expect(readSpy).toHaveBeenCalledOnce();
    expect(body).toMatchObject({
      newsletterJid: NEWSLETTER_JID,
      messageId: "102",
      mediaType: "image",
      mimeType: "image/jpeg",
      mode: "file",
      fileName: "102.jpg",
      size: payload.length,
    });
    expect(await readFile(String(body.path))).toEqual(payload);
    expect(resolve(String(body.path)).startsWith(await realpath(directory))).toBe(true);
  });

  it("looks up a non-numeric message id in one bounded history page", async () => {
    const query = vi.fn(async () =>
      newsletterIq([
        newsletterMessage("50", "POST-ABC", {
          stickerMessage: {
            mimetype: "image/webp",
            directPath: "/v/sticker",
            mediaKey: new Uint8Array(32).fill(9),
          },
        }),
      ]),
    );
    const adapter = new BaileysAdapter(INSTANCE_ID);
    Object.assign(adapter, {
      status: "connected",
      sock: {
        generateMessageTag: () => "query-2",
        query,
      } as unknown as WASocket,
    });
    vi.spyOn(newsletterMedia, "readNewsletterMediaBytes").mockResolvedValue(Buffer.from("sticker"));

    const downloaded = await adapter.downloadNewsletterMedia(
      NEWSLETTER_JID,
      "POST-ABC",
      100,
      1_000,
    );

    expect(downloaded.mediaType).toBe("sticker");
    const request = query.mock.calls[0]?.[0] as BinaryNode;
    const messages = Array.isArray(request.content) ? request.content[0] : undefined;
    expect(messages && "attrs" in messages ? messages.attrs : {}).toEqual({
      count: "100",
      since: "0",
    });
  });

  it("reports a text post without calling the byte fallback", async () => {
    const query = vi.fn(async () =>
      newsletterIq([newsletterMessage("8", "message-8", { conversation: "text only" })]),
    );
    const adapter = new BaileysAdapter(INSTANCE_ID);
    Object.assign(adapter, {
      status: "connected",
      sock: { generateMessageTag: () => "query-3", query } as unknown as WASocket,
    });

    await expect(adapter.downloadNewsletterMedia(NEWSLETTER_JID, "8")).rejects.toThrow(
      "does not contain downloadable media",
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("downloads a channel post that has no media key and checks fileSha256", async () => {
    const payload = Buffer.from("channel-plain-bytes");
    const fileSha256 = createHash("sha256").update(payload).digest();
    const directPath = "/v/t62.7118-24/12345?ccb=1&oh=abc";
    const lookup = newsletterMedia.findNewsletterPostMedia(
      newsletterIq([
        newsletterMessage("200", "message-200", {
          imageMessage: {
            mimetype: "image/jpeg",
            directPath,
            fileSha256,
            fileLength: payload.length,
            url: `https://mmg.whatsapp.net${directPath}`,
          },
        }),
      ]),
      "200",
    );

    expect(lookup).toMatchObject({
      status: "ready",
      media: { encrypted: false, directPath, mediaType: "image", messageId: "message-200" },
    });
    if (lookup.status !== "ready") throw new Error("expected channel media");
    expect(lookup.media.downloadable).toBeUndefined();

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(payload, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      newsletterMedia.readNewsletterMediaBytes(lookup.media, 1024, 5_000),
    ).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://mmg.whatsapp.net${directPath}`,
      expect.any(Object),
    );

    fetchMock.mockImplementation(async () => new Response(payload, { status: 200 }));
    await expect(
      newsletterMedia.readNewsletterMediaBytes(
        { ...lookup.media, fileSha256: Buffer.alloc(32, 1) },
        1024,
        5_000,
      ),
    ).rejects.toThrow("does not match fileSha256");
  });

  it("rejects an unencrypted channel download that leaves the CDN or exceeds the cap", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const fileSha256 = new Uint8Array(32).fill(4);
    const source = {
      messageId: "1",
      serverId: "1",
      mediaType: "image" as const,
      mimeType: "image/jpeg",
      encrypted: false,
      directPath: "/v/../secret",
      fileSha256,
    };

    await expect(newsletterMedia.readNewsletterMediaBytes(source, 100)).rejects.toThrow(
      "not a CDN path",
    );
    await expect(
      newsletterMedia.readNewsletterMediaBytes({ ...source, directPath: "//evil.example/v" }, 100),
    ).rejects.toThrow("not a CDN path");
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(new Response(Buffer.from("plain"), { status: 200 }));
    await expect(
      newsletterMedia.readNewsletterMediaBytes(
        { ...source, directPath: "/v/plain", fileSha256: undefined },
        100,
      ),
    ).rejects.toThrow("missing fileSha256");

    fetchMock.mockResolvedValue(new Response(new Uint8Array(100), { status: 200 }));
    await expect(
      newsletterMedia.readNewsletterMediaBytes(
        { ...source, directPath: "/v/plain", fileLength: undefined },
        10,
        1_000,
      ),
    ).rejects.toThrow("maximum download size of 10 bytes");
  });

  it("accepts raw URL-only media on the fixed CDN", async () => {
    const payload = Buffer.from("raw-url-only");
    const lookup = newsletterMedia.findNewsletterPostMedia(
      newsletterIq([
        newsletterMessage("201", "raw-201", {
          imageMessage: {
            url: "https://mmg.whatsapp.net/v/raw",
            fileSha256: createHash("sha256").update(payload).digest(),
          },
        }),
      ]),
      "201",
    );
    expect(lookup.status).toBe("ready");
    if (lookup.status !== "ready") throw new Error("missing raw media");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(payload)),
    );
    await expect(
      newsletterMedia.readNewsletterMediaBytes(lookup.media, 100, 1000),
    ).resolves.toEqual(payload);
  });

  it("rejects encrypted URLs outside the CDN before downloading", async () => {
    const fetchMock = vi.fn(() => {
      throw new Error("unexpected network request");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      newsletterMedia.readNewsletterMediaBytes(
        {
          messageId: "1",
          serverId: "1",
          mediaType: "image",
          mimeType: "image/jpeg",
          encrypted: true,
          downloadable: { mediaKey: new Uint8Array(32), url: "http://127.0.0.1/mms/image" },
        },
        100,
        1000,
      ),
    ).rejects.toThrow("not a CDN path");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects the download on Cloud API", async () => {
    const tool = register(registerNewsletterTools, new CloudApiAdapter(INSTANCE_ID)).get(
      "wa_download_newsletter_media",
    );
    if (!tool) throw new Error("download tool was not registered");
    const response = (await tool.handler(
      tool.inputSchema.parse({
        instanceId: INSTANCE_ID,
        newsletterJid: NEWSLETTER_JID,
        messageId: "102",
      }),
    )) as ToolResult;

    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain("not supported on Cloud API");
    expect(
      DownloadNewsletterMediaSchema.safeParse({
        instanceId: INSTANCE_ID,
        newsletterJid: "not-a-channel",
        messageId: "102",
      }).success,
    ).toBe(false);
  });
});
