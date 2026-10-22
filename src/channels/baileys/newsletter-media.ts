// ============================================================
// WA MCP — Channel post media extraction and download
// ============================================================

import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  downloadContentFromMessage,
  proto,
  type BinaryNode,
  type DownloadableMessage,
  type MediaType,
} from "@whiskeysockets/baileys";
import { mediaResponseToBuffer } from "../../services/media.js";

export type NewsletterDownloadType = "image" | "video" | "ptv" | "audio" | "document" | "sticker";

/** WhatsApp's default media host. Channel uploads publish plaintext at this origin. */
const CHANNEL_MEDIA_ORIGIN = "https://mmg.whatsapp.net";

export interface NewsletterMediaSource {
  messageId: string;
  serverId: string;
  mediaType: NewsletterDownloadType;
  mimeType: string;
  fileName?: string;
  fileLength?: number;
  /**
   * Current Baileys Channel uploads omit `mediaKey` and publish the raw file.
   * Older posts that still carry a key stay on the decrypt path.
   */
  encrypted: boolean;
  downloadable?: DownloadableMessage;
  directPath?: string;
  url?: string;
  fileSha256?: Uint8Array;
}

export type NewsletterMediaLookup =
  | { status: "ready"; media: NewsletterMediaSource }
  | { status: "missing" }
  | { status: "no-media"; messageId: string };

const MEDIA_FIELDS: Array<{
  field:
    | "imageMessage"
    | "videoMessage"
    | "ptvMessage"
    | "audioMessage"
    | "documentMessage"
    | "stickerMessage";
  mediaType: NewsletterDownloadType;
  fallbackMimeType: string;
}> = [
  { field: "imageMessage", mediaType: "image", fallbackMimeType: "image/jpeg" },
  { field: "videoMessage", mediaType: "video", fallbackMimeType: "video/mp4" },
  { field: "ptvMessage", mediaType: "ptv", fallbackMimeType: "video/mp4" },
  { field: "audioMessage", mediaType: "audio", fallbackMimeType: "audio/ogg" },
  { field: "documentMessage", mediaType: "document", fallbackMimeType: "application/octet-stream" },
  { field: "stickerMessage", mediaType: "sticker", fallbackMimeType: "image/webp" },
];

const MESSAGE_WRAPPERS = [
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
  "editedMessage",
  "deviceSentMessage",
] as const;

interface ProtoMediaFields {
  url?: string | null;
  directPath?: string | null;
  mediaKey?: Uint8Array | null;
  fileSha256?: Uint8Array | null;
  mimetype?: string | null;
  fileLength?: number | { toNumber?: () => number } | null;
  fileName?: string | null;
}

/** Locate one Channel post inside a newsletter `messages` IQ and describe its media. */
export function findNewsletterPostMedia(
  response: unknown,
  messageId: string,
): NewsletterMediaLookup {
  if (!isBinaryNode(response)) return { status: "missing" };
  const messagesNode = findBinaryNode(response, "messages");
  const messages = messagesNode ? findBinaryNodes(messagesNode, "message") : [];
  const match = messages.find((node) => messageNodeMatches(node, messageId));
  if (!match) return { status: "missing" };

  const serverId = match.attrs.server_id ?? match.attrs.message_id ?? match.attrs.id ?? messageId;
  const id = match.attrs.id ?? match.attrs.message_id ?? serverId;
  const bytes = plaintextBytes(match);
  if (!bytes) return { status: "no-media", messageId: id };

  let decoded: proto.IMessage;
  try {
    decoded = proto.Message.decode(bytes);
  } catch {
    return { status: "no-media", messageId: id };
  }

  const message = unwrapMessage(decoded);
  for (const candidate of MEDIA_FIELDS) {
    const raw = message[candidate.field];
    if (!raw || typeof raw !== "object") continue;
    const media = raw as ProtoMediaFields;
    const described = describeMedia(id, serverId, candidate, media);
    if (described) return { status: "ready", media: described };
  }

  return { status: "no-media", messageId: id };
}

/** Download Channel media, decrypting only when the post carries a media key. */
export async function readNewsletterMediaBytes(
  media: NewsletterMediaSource,
  maxBytes?: number,
  timeoutMs?: number,
): Promise<Buffer> {
  if (maxBytes !== undefined && media.fileLength !== undefined && media.fileLength > maxBytes) {
    throw new Error(`Media exceeds maximum download size of ${sizeLabel(maxBytes)}`);
  }

  if (!media.encrypted) return readUnencryptedNewsletterMedia(media, maxBytes, timeoutMs);

  if (!media.downloadable?.mediaKey?.byteLength) {
    throw new Error("Channel media is missing a media key");
  }
  const stream = await downloadContentFromMessage(
    {
      mediaKey: media.downloadable.mediaKey,
      url: trustedChannelMediaUrl(media.downloadable.directPath, media.downloadable.url),
    },
    media.mediaType satisfies MediaType,
    {
      options: {
        redirect: "error",
        ...(timeoutMs !== undefined ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      },
    },
  );
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (maxBytes !== undefined && size > maxBytes) {
        stream.destroy();
        throw new Error(`Media exceeds maximum download size of ${sizeLabel(maxBytes)}`);
      }
      chunks.push(buffer);
    }
  } catch (error) {
    stream.destroy();
    throw error;
  }
  return Buffer.concat(chunks, size);
}

function describeMedia(
  messageId: string,
  serverId: string,
  candidate: (typeof MEDIA_FIELDS)[number],
  media: ProtoMediaFields,
): NewsletterMediaSource | undefined {
  const mediaKey = media.mediaKey && media.mediaKey.byteLength > 0 ? media.mediaKey : undefined;
  const directPath = nonEmptyString(media.directPath);
  const url = nonEmptyString(media.url);
  const fileName = nonEmptyString(media.fileName);
  const fileLength = numericLength(media.fileLength);
  const fileSha256 =
    media.fileSha256 && media.fileSha256.byteLength > 0 ? Buffer.from(media.fileSha256) : undefined;
  const shared = {
    messageId,
    serverId,
    mediaType: candidate.mediaType,
    mimeType: nonEmptyString(media.mimetype) ?? candidate.fallbackMimeType,
    ...(fileName ? { fileName } : {}),
    ...(fileLength !== undefined ? { fileLength } : {}),
  };

  if (mediaKey) {
    if (!directPath && !url) return undefined;
    return {
      ...shared,
      encrypted: true,
      downloadable: {
        mediaKey,
        ...(directPath ? { directPath } : {}),
        ...(url ? { url } : {}),
      },
    };
  }

  if (!directPath && !url) return undefined;
  return {
    ...shared,
    encrypted: false,
    ...(directPath ? { directPath } : {}),
    ...(url ? { url } : {}),
    ...(fileSha256 ? { fileSha256 } : {}),
  };
}

async function readUnencryptedNewsletterMedia(
  media: NewsletterMediaSource,
  maxBytes: number | undefined,
  timeoutMs: number | undefined,
): Promise<Buffer> {
  const url = trustedChannelMediaUrl(media.directPath, media.url);
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "error",
      ...(timeoutMs !== undefined ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
  } catch (error) {
    if (isRedirectRejection(error)) {
      throw new Error("Channel media download was redirected", { cause: error });
    }
    throw error;
  }
  if (!response.ok) {
    throw new Error(`Failed to download channel media: HTTP ${response.status}`);
  }

  let data: Buffer;
  try {
    data = await mediaResponseToBuffer(response, maxBytes);
  } catch (error) {
    if (error instanceof Error && error.message.includes("maximum size of")) {
      throw new Error(error.message.replace("maximum size of", "maximum download size of"), {
        cause: error,
      });
    }
    throw error;
  }
  assertFileSha256(data, media.fileSha256);
  return data;
}

/** Resolve only the fixed WhatsApp origin, including legacy URL-only posts. */
function trustedChannelMediaUrl(directPath?: string | null, mediaUrl?: string | null): string {
  if (directPath) return channelMediaUrl(directPath);
  if (mediaUrl) {
    let parsed: URL;
    try {
      parsed = new URL(mediaUrl);
    } catch {
      throw new Error("Channel media URL is not a CDN path");
    }
    if (
      parsed.origin === CHANNEL_MEDIA_ORIGIN &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash
    ) {
      return channelMediaUrl(parsed.pathname + parsed.search);
    }
  }
  throw new Error("Channel media URL is not a CDN path");
}

/** Build `https://mmg.whatsapp.net{directPath}` and reject anything that leaves that host. */
export function channelMediaUrl(directPath: string): string {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(directPath);
  } catch {
    throw new Error("Channel media directPath is not a CDN path");
  }
  if (
    !directPath.startsWith("/") ||
    directPath.startsWith("//") ||
    directPath.includes("\\") ||
    directPath.includes("#") ||
    hasControlOrSpace(directPath) ||
    decodedPath.split("/").some((segment) => segment === ".." || segment === ".")
  ) {
    throw new Error("Channel media directPath is not a CDN path");
  }

  let url: URL;
  try {
    url = new URL(directPath, CHANNEL_MEDIA_ORIGIN);
  } catch {
    throw new Error("Channel media directPath is not a CDN path");
  }
  if (url.origin !== CHANNEL_MEDIA_ORIGIN || url.username || url.password) {
    throw new Error("Channel media directPath is not a CDN path");
  }
  return url.toString();
}

function hasControlOrSpace(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) <= 0x20) return true;
  }
  return false;
}

function assertFileSha256(data: Buffer, expected: Uint8Array | undefined): void {
  if (!expected || expected.byteLength !== 32) {
    throw new Error("Channel media is missing fileSha256");
  }
  const actual = createHash("sha256").update(data).digest();
  const expectedBuffer = Buffer.from(expected);
  if (actual.length !== expectedBuffer.length || !timingSafeEqual(actual, expectedBuffer)) {
    throw new Error("Channel media SHA-256 does not match fileSha256");
  }
}

function isRedirectRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = "cause" in error && error.cause instanceof Error ? error.cause.message : "";
  return /redirect/i.test(`${error.message} ${cause}`);
}

function messageNodeMatches(node: BinaryNode, messageId: string): boolean {
  return (
    node.attrs.server_id === messageId ||
    node.attrs.id === messageId ||
    node.attrs.message_id === messageId
  );
}

function unwrapMessage(message: proto.IMessage): proto.IMessage {
  let current = message;
  for (let depth = 0; depth < MESSAGE_WRAPPERS.length; depth++) {
    const wrapper = MESSAGE_WRAPPERS.find((key) => current[key]?.message);
    const inner = wrapper ? current[wrapper]?.message : undefined;
    if (!inner) break;
    current = inner;
  }
  return current;
}

function plaintextBytes(node: BinaryNode): Uint8Array | undefined {
  const plaintext = findBinaryNode(node, "plaintext");
  const content = plaintext?.content;
  if (content instanceof Uint8Array) return content;
  if (typeof content === "string") return Buffer.from(content, "binary");
  return undefined;
}

function numericLength(value: ProtoMediaFields["fileLength"]): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (value && typeof value === "object" && typeof value.toNumber === "function") {
    const parsed = value.toNumber();
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}

function nonEmptyString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function sizeLabel(maxBytes: number): string {
  return maxBytes < 1024 * 1024 ? `${maxBytes} bytes` : `${Math.round(maxBytes / 1024 / 1024)} MB`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBinaryNode(value: unknown): value is BinaryNode {
  if (!isRecord(value) || typeof value.tag !== "string" || !isRecord(value.attrs)) return false;
  const content = value.content;
  return (
    content === undefined ||
    typeof content === "string" ||
    content instanceof Uint8Array ||
    Array.isArray(content)
  );
}

function binaryNodeChildren(node: BinaryNode): BinaryNode[] {
  if (!Array.isArray(node.content)) return [];
  return node.content.filter((child): child is BinaryNode => isBinaryNode(child));
}

function findBinaryNode(node: BinaryNode, tag: string): BinaryNode | undefined {
  if (node.tag === tag) return node;
  for (const child of binaryNodeChildren(node)) {
    const match = findBinaryNode(child, tag);
    if (match) return match;
  }
  return undefined;
}

function findBinaryNodes(node: BinaryNode, tag: string): BinaryNode[] {
  const matches: BinaryNode[] = node.tag === tag ? [node] : [];
  for (const child of binaryNodeChildren(node)) matches.push(...findBinaryNodes(child, tag));
  return matches;
}
