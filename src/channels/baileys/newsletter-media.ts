// ============================================================
// WA MCP — Channel post media extraction and download
// ============================================================

import { Buffer } from "node:buffer";
import {
  downloadContentFromMessage,
  proto,
  type BinaryNode,
  type DownloadableMessage,
  type MediaType,
} from "@whiskeysockets/baileys";

export type NewsletterDownloadType = "image" | "video" | "ptv" | "audio" | "document" | "sticker";

export interface NewsletterMediaSource {
  messageId: string;
  serverId: string;
  mediaType: NewsletterDownloadType;
  mimeType: string;
  fileName?: string;
  fileLength?: number;
  downloadable: DownloadableMessage;
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
    const mediaKey = media.mediaKey;
    const directPath = nonEmptyString(media.directPath);
    const url = nonEmptyString(media.url);
    if (!mediaKey || mediaKey.byteLength === 0 || (!directPath && !url)) continue;

    const fileName = nonEmptyString(media.fileName);
    return {
      status: "ready",
      media: {
        messageId: id,
        serverId,
        mediaType: candidate.mediaType,
        mimeType: nonEmptyString(media.mimetype) ?? candidate.fallbackMimeType,
        ...(fileName ? { fileName } : {}),
        ...(numericLength(media.fileLength) !== undefined
          ? { fileLength: numericLength(media.fileLength) }
          : {}),
        downloadable: {
          mediaKey,
          ...(directPath ? { directPath } : {}),
          ...(url ? { url } : {}),
        },
      },
    };
  }

  return { status: "no-media", messageId: id };
}

/** Download and decrypt Channel media, enforcing the same byte cap as received-media downloads. */
export async function readNewsletterMediaBytes(
  media: NewsletterMediaSource,
  maxBytes?: number,
  timeoutMs?: number,
): Promise<Buffer> {
  if (maxBytes !== undefined && media.fileLength !== undefined && media.fileLength > maxBytes) {
    throw new Error(`Media exceeds maximum download size of ${sizeLabel(maxBytes)}`);
  }

  const stream = await downloadContentFromMessage(
    media.downloadable,
    media.mediaType satisfies MediaType,
    timeoutMs ? { options: { signal: AbortSignal.timeout(timeoutMs) } } : {},
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
