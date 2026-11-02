// Group status (a 24h update visible to one group's members) is not a
// sendMessage content type in @whiskeysockets/baileys 7.0.0-rc14. rc14 only
// unwraps groupStatusMessage / groupStatusMessageV2 while normalizing a
// received message. The send shape below is the one WhatsApp Web's meta node
// and independent clients encode: an ordinary group message wrapped in
// groupStatusMessageV2, contextInfo.isGroupStatus on the inner message, a
// 32-byte messageSecret on the outer message, and
// <meta is_group_status="true" origin="group_status">.

import { randomBytes } from "node:crypto";
import {
  generateWAMessage as generateWaMessage,
  proto,
  type AnyMessageContent,
  type BinaryNode,
  type WAMediaUploadFunction,
} from "@whiskeysockets/baileys";
import type { GroupStatusContent } from "../../types/channel.types.js";

export const DEFAULT_GROUP_STATUS_BACKGROUND = "#233E4F";
export const DEFAULT_GROUP_STATUS_FONT = 6;
export const DEFAULT_GROUP_STATUS_TEXT_ARGB = 0xffffffff;

const pending = new WeakSet<object>();

export function groupStatusMetaNode(): BinaryNode {
  return {
    tag: "meta",
    attrs: {
      is_group_status: "true",
      origin: "group_status",
    },
  };
}

export function markGroupStatusMessage(message: object): void {
  pending.add(message);
}

/**
 * rc14's relayMessage reads getMediaType() on the raw message before calling
 * patchMessageBeforeSending. A media node nested inside groupStatusMessageV2
 * would miss <enc mediatype="image|video">. Callers relay the inner message
 * and let this hook wrap the bytes that are actually encrypted.
 */
export function patchGroupStatusMessage<T extends proto.IMessage>(message: T): T {
  if (!pending.has(message)) return message;
  pending.delete(message);

  const secret = message.messageContextInfo?.messageSecret
    ? Buffer.from(message.messageContextInfo.messageSecret)
    : randomBytes(32);
  const inner = proto.Message.decode(proto.Message.encode(message).finish());
  inner.messageContextInfo = null;

  return proto.Message.create({
    messageContextInfo: { messageSecret: secret },
    groupStatusMessageV2: { message: inner },
  }) as unknown as T;
}

export async function createGroupStatusMessage(
  groupJid: string,
  content: GroupStatusContent,
  deps: {
    userJid: string;
    upload: WAMediaUploadFunction;
    resolveMedia: (input: string) => { url: string } | Buffer;
    generate?: typeof generateWaMessage;
  },
): Promise<{ message: proto.IMessage; messageId: string }> {
  const generate = deps.generate ?? generateWaMessage;
  const body = groupStatusBody(content, deps.resolveMedia);
  const font = content.font ?? DEFAULT_GROUP_STATUS_FONT;
  const full = await generate(groupJid, body, {
    userJid: deps.userJid,
    upload: deps.upload,
    ...(content.type === "text"
      ? {
          backgroundColor: content.backgroundColor ?? DEFAULT_GROUP_STATUS_BACKGROUND,
          font,
        }
      : {}),
  });
  const message = full.message;
  if (!message) throw new Error("Baileys did not build a group status message");

  if (message.conversation) {
    message.extendedTextMessage = {
      ...message.extendedTextMessage,
      text: message.conversation,
    };
    delete message.conversation;
  }

  const node = message.extendedTextMessage ?? message.imageMessage ?? message.videoMessage;
  if (!node) throw new Error("Group status only supports text, image, and video");
  node.contextInfo = { ...(node.contextInfo ?? {}), isGroupStatus: true };

  if (message.extendedTextMessage) {
    message.extendedTextMessage.font = font as proto.Message.ExtendedTextMessage.FontType;
    if (message.extendedTextMessage.textArgb == null) {
      message.extendedTextMessage.textArgb = DEFAULT_GROUP_STATUS_TEXT_ARGB;
    }
  }

  if (!message.messageContextInfo?.messageSecret) {
    message.messageContextInfo = {
      ...message.messageContextInfo,
      messageSecret: randomBytes(32),
    };
  }

  markGroupStatusMessage(message);
  const messageId = full.key.id;
  if (!messageId) throw new Error("Baileys did not return a group status message ID");
  return { message, messageId };
}

function groupStatusBody(
  content: GroupStatusContent,
  resolveMedia: (input: string) => { url: string } | Buffer,
): AnyMessageContent {
  if (content.type === "text") {
    if (!content.text) throw new Error("text is required when type is text");
    return { text: content.text, linkPreview: null };
  }
  if (!content.media) throw new Error("media is required when type is image or video");
  const media = resolveMedia(content.media);
  if (content.type === "image") return { image: media, caption: content.caption };
  return { video: media, caption: content.caption };
}
