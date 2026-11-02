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
import { MEDIA_LIMITS } from "../../constants.js";
import type { GroupStatusContent } from "../../types/channel.types.js";

export const DEFAULT_GROUP_STATUS_BACKGROUND = "#233E4F";
export const DEFAULT_GROUP_STATUS_FONT = 6;
export const DEFAULT_GROUP_STATUS_TEXT_ARGB = 0xffffffff;
export const MAX_GROUP_STATUS_CAPTION_LENGTH = 1024;
/** Base64 length of the larger image/video byte cap. HTTPS URLs are shorter. */
export const MAX_GROUP_STATUS_MEDIA_CHARS = Math.ceil((MEDIA_LIMITS.video * 4) / 3);

/**
 * rc14's relayMessage reads getMediaType() on the raw message before calling
 * patchMessageBeforeSending, then stores that same raw object in
 * messageRetryManager. A later retry with `participant` encodes the cached
 * object and does not call the patch. The wrap is therefore decided from the
 * payload: an envelope is left as-is, and a top-level text/image/video node
 * with contextInfo.isGroupStatus is wrapped. Calling this twice is safe.
 */
export function wrapGroupStatusMessage(message: proto.IMessage): proto.IMessage {
  if (message.groupStatusMessageV2) return message;
  const node = message.extendedTextMessage ?? message.imageMessage ?? message.videoMessage;
  if (node?.contextInfo?.isGroupStatus !== true) return message;

  const secret = message.messageContextInfo?.messageSecret
    ? Buffer.from(message.messageContextInfo.messageSecret)
    : randomBytes(32);
  const inner = proto.Message.decode(proto.Message.encode(message).finish());
  inner.messageContextInfo = null;

  return proto.Message.create({
    messageContextInfo: { messageSecret: secret },
    groupStatusMessageV2: { message: inner },
  });
}

export function patchGroupStatusMessage<T extends proto.IMessage>(message: T): T {
  return wrapGroupStatusMessage(message) as T;
}

export function groupStatusMetaNode(): BinaryNode {
  return {
    tag: "meta",
    attrs: {
      is_group_status: "true",
      origin: "group_status",
    },
  };
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

  // generateWAMessage in rc14 always writes `text` to extendedTextMessage
  // (src/Utils/messages.ts). This branch does not run for that output.
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

  const messageId = full.key.id;
  if (!messageId) throw new Error("Baileys did not return a group status message ID");
  return { message, messageId };
}

function groupStatusBody(
  content: GroupStatusContent,
  resolveMedia: (input: string) => { url: string } | Buffer,
): AnyMessageContent {
  if (content.caption !== undefined && content.caption.length > MAX_GROUP_STATUS_CAPTION_LENGTH) {
    throw new Error(`caption exceeds ${MAX_GROUP_STATUS_CAPTION_LENGTH} characters`);
  }
  if (content.media !== undefined && content.media.length > MAX_GROUP_STATUS_MEDIA_CHARS) {
    throw new Error(`media exceeds ${MAX_GROUP_STATUS_MEDIA_CHARS} characters`);
  }
  if (content.type === "text") {
    if (!content.text) throw new Error("text is required when type is text");
    return { text: content.text, linkPreview: null };
  }
  if (!content.media) throw new Error("media is required when type is image or video");
  const media = resolveMedia(content.media);
  if (content.type === "image") return { image: media, caption: content.caption };
  return { video: media, caption: content.caption };
}
