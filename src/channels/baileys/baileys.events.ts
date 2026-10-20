// ============================================================
// WA MCP — Baileys Event Normalization
// Maps raw Baileys events to normalized ChannelEvent types.
// ============================================================

import {
  getContentType,
  normalizeMessageContent,
  type BaileysEventMap,
  type WAMessage,
  type WAMessageContent,
  type WAMessageUpdate,
} from "@whiskeysockets/baileys";
import type {
  MessageButton,
  MessageType,
  MessageDeliveryStatus,
  NormalizedMessageEvent,
  NormalizedMessageUpdateEvent,
  NormalizedMessageDeleteEvent,
  NormalizedMessageReactionEvent,
  NormalizedMessageEditEvent,
  NormalizedPresenceEvent,
  NormalizedGroupUpdateEvent,
  NormalizedGroupParticipantsEvent,
  NormalizedContactUpdateEvent,
  NormalizedConnectionEvent,
  NormalizedCallEvent,
  PresenceStatus,
} from "../../types/channel.types.js";
import { messageTimestampToSeconds } from "./message-timestamp.js";
import { createChildLogger } from "../../utils/logger.js";

const logger = createChildLogger({ service: "baileys-events" });
const MAX_ADDITIONAL_UNWRAPS = 12;
const unknownTypesLogged = new Set<string>();

type MessageRecord = Record<string, unknown>;

export interface BaileysMessageDetails {
  type: MessageType;
  content: string | null;
  mediaUrl: string | null;
  mediaMimetype?: string;
  mediaFileName?: string;
  mediaSize?: number;
  mediaCaption?: string;
  buttons?: MessageButton[];
  rawType?: string;
}

function isRecord(value: unknown): value is MessageRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return undefined;
}

function positiveSize(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function asRecord(value: unknown): MessageRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function recordAt(record: MessageRecord | undefined, key: string): MessageRecord | undefined {
  return record ? asRecord(record[key]) : undefined;
}

/**
 * Normalize standard Baileys future-proof wrappers, then handle protocol edits
 * and any standard wrappers beyond Baileys' five-layer helper limit.
 */
export function unwrapMessageContent(
  content: WAMessageContent | null | undefined,
  options: { unwrapProtocolEdits?: boolean } = {},
): MessageRecord | undefined {
  if (!content) return undefined;

  const normalized = normalizeMessageContent(content);
  let current = asRecord(normalized ?? content);
  if (!current) return undefined;

  for (let depth = 0; depth < MAX_ADDITIONAL_UNWRAPS; depth++) {
    const protocolEdit: MessageRecord | undefined =
      options.unwrapProtocolEdits === false
        ? undefined
        : recordAt(recordAt(current, "protocolMessage"), "editedMessage");
    if (protocolEdit) {
      current = protocolEdit;
      continue;
    }

    const wrapperKeys = [
      "ephemeralMessage",
      "viewOnceMessage",
      "viewOnceMessageV2",
      "viewOnceMessageV2Extension",
      "documentWithCaptionMessage",
      "deviceSentMessage",
      "editedMessage",
    ];
    let inner: MessageRecord | undefined;
    for (const key of wrapperKeys) {
      const wrapper = recordAt(current, key);
      const wrapperMessage = recordAt(wrapper, "message");
      if (wrapperMessage) {
        inner = wrapperMessage;
        break;
      }
    }
    if (!inner) break;
    current = inner;
  }

  return current;
}

function messageContent(msg: WAMessage): MessageRecord | undefined {
  return unwrapMessageContent(msg.message);
}

/** Read WhatsApp's forwarded marker from the content field that carries contextInfo. */
export function isMessageForwarded(msg: WAMessage | undefined): boolean {
  if (!msg) return false;
  const content = messageContent(msg);
  if (!content) return false;

  for (const value of Object.values(content)) {
    const contextInfo = recordAt(asRecord(value), "contextInfo");
    if (
      contextInfo?.isForwarded === true ||
      (typeof contextInfo?.forwardingScore === "number" && contextInfo.forwardingScore > 0)
    ) {
      return true;
    }
  }

  return false;
}

function typeName(content: MessageRecord | undefined): string | undefined {
  if (!content) return undefined;
  const baileysType = getContentType(content as WAMessageContent);
  if (baileysType) return baileysType;
  return Object.keys(content).find((key) => key !== "senderKeyDistributionMessage");
}

function pushText(parts: string[], value: unknown): void {
  const text = stringValue(value);
  if (text && !parts.includes(text)) parts.push(text);
}

function hsmText(value: unknown): string | undefined {
  const hsm = asRecord(value);
  if (!hsm) return stringValue(value);

  const params = Array.isArray(hsm.params)
    ? hsm.params.map(stringValue).filter((item): item is string => !!item)
    : [];
  if (params.length) return params.join(" ");

  const localizedParams = Array.isArray(hsm.localizableParams) ? hsm.localizableParams : [];
  const localizedText = localizedParams
    .map((parameter) => {
      const entry = asRecord(parameter);
      return firstString(entry?.default);
    })
    .filter((item): item is string => !!item);
  return localizedText.length ? localizedText.join(" ") : undefined;
}

function safeJsonRecord(value: unknown): MessageRecord | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function makeButton(
  type: string,
  text: unknown,
  extras: { url?: unknown; id?: unknown; phone?: unknown } = {},
): MessageButton {
  const url = stringValue(extras.url);
  const id = stringValue(extras.id);
  const phone = stringValue(extras.phone);
  const display = firstString(text, url, phone, id) ?? type;
  return {
    type,
    text: display,
    ...(url ? { url } : {}),
    ...(id ? { id } : {}),
    ...(phone ? { phone } : {}),
  };
}

function nativeFlowButton(button: unknown): MessageButton | undefined {
  const entry = asRecord(button);
  if (!entry) return undefined;
  const type = firstString(entry.name) ?? "native_flow";
  const params = safeJsonRecord(entry.buttonParamsJson);
  if (!params) return makeButton(type, type);
  return makeButton(type, params.display_text ?? params.text ?? params.title, {
    url: params.url ?? params.link ?? params.cta_url,
    id: params.id ?? params.row_id,
    phone: params.phone_number ?? params.phone,
  });
}

function collectNativeFlowButtons(buttons: unknown, result: MessageButton[]): void {
  if (!Array.isArray(buttons)) return;
  for (const button of buttons.slice(0, 100)) {
    const parsed = nativeFlowButton(button);
    if (parsed) result.push(parsed);
  }
}

function collectHydratedTemplateButtons(buttons: unknown, result: MessageButton[]): void {
  if (!Array.isArray(buttons)) return;
  for (const value of buttons.slice(0, 100)) {
    const entry = asRecord(value);
    if (!entry) continue;
    for (const [key, kind] of [
      ["urlButton", "url"],
      ["callButton", "call"],
      ["quickReplyButton", "quick_reply"],
    ] as const) {
      const body = recordAt(entry, key);
      if (!body) continue;
      result.push(
        makeButton(kind, body.displayText, {
          url: body.url,
          id: body.id,
          phone: body.phoneNumber,
        }),
      );
    }
  }
}

function collectFourRowButtons(buttons: unknown, result: MessageButton[]): void {
  if (!Array.isArray(buttons)) return;
  for (const value of buttons.slice(0, 100)) {
    const entry = asRecord(value);
    if (!entry) continue;
    for (const [key, kind] of [
      ["urlButton", "url"],
      ["callButton", "call"],
      ["quickReplyButton", "quick_reply"],
    ] as const) {
      const body = recordAt(entry, key);
      if (!body) continue;
      result.push(
        makeButton(kind, hsmText(body.displayText), {
          url: hsmText(body.url),
          id: body.id,
          phone: hsmText(body.phoneNumber),
        }),
      );
    }
  }
}

function collectButtonsMessageButtons(buttons: unknown, result: MessageButton[]): void {
  if (!Array.isArray(buttons)) return;
  for (const value of buttons.slice(0, 100)) {
    const entry = asRecord(value);
    if (!entry) continue;
    const nativeInfo = recordAt(entry, "nativeFlowInfo");
    const params = safeJsonRecord(nativeInfo?.paramsJson);
    result.push(
      makeButton(
        firstString(nativeInfo?.name) ?? "response",
        recordAt(entry, "buttonText")?.displayText ?? params?.display_text,
        {
          url: params?.url ?? params?.link,
          id: entry.buttonId ?? params?.id,
          phone: params?.phone_number,
        },
      ),
    );
  }
}

function collectMedia(candidate: MessageRecord | undefined):
  | {
      type: MessageType;
      mediaUrl: string | null;
      mediaMimetype?: string;
      mediaFileName?: string;
      mediaSize?: number;
      caption?: string;
    }
  | undefined {
  if (!candidate) return undefined;
  for (const [key, type] of [
    ["imageMessage", "image"],
    ["videoMessage", "video"],
    ["documentMessage", "document"],
    ["audioMessage", "audio"],
    ["stickerMessage", "sticker"],
  ] as const) {
    const media = recordAt(candidate, key);
    if (!media) continue;
    const mediaMimetype = firstString(media.mimetype);
    const mediaFileName = firstString(media.fileName);
    const mediaSize = positiveSize(media.fileLength);
    const caption = firstString(media.caption);
    return {
      type,
      mediaUrl: firstString(media.url) ?? null,
      ...(mediaMimetype ? { mediaMimetype } : {}),
      ...(mediaFileName ? { mediaFileName } : {}),
      ...(mediaSize ? { mediaSize } : {}),
      ...(caption ? { caption } : {}),
    };
  }
  return undefined;
}

function addTemplateContent(
  template: MessageRecord | undefined,
  parts: string[],
  buttons: MessageButton[],
): { media?: ReturnType<typeof collectMedia> } {
  if (!template) return {};
  let media: ReturnType<typeof collectMedia>;

  for (const key of ["hydratedTemplate", "hydratedFourRowTemplate"]) {
    const hydrated = recordAt(template, key);
    if (!hydrated) continue;
    pushText(parts, hydrated.hydratedTitleText);
    pushText(parts, hydrated.hydratedContentText);
    pushText(parts, hydrated.hydratedFooterText);
    collectHydratedTemplateButtons(hydrated.hydratedButtons, buttons);
    media ??= collectMedia(hydrated);
  }

  const fourRow = recordAt(template, "fourRowTemplate");
  if (fourRow) {
    const legacyTitle = asRecord(fourRow.title);
    pushText(parts, hsmText(legacyTitle ?? fourRow.highlyStructuredMessage));
    pushText(parts, hsmText(fourRow.content));
    pushText(parts, hsmText(fourRow.footer));
    collectFourRowButtons(fourRow.buttons, buttons);
    media ??= collectMedia(fourRow);
  }

  const interactiveTemplate = recordAt(template, "interactiveMessageTemplate");
  if (interactiveTemplate) {
    const interactive = addInteractiveContent(interactiveTemplate, parts, buttons);
    media ??= interactive.media;
  }

  return { ...(media ? { media } : {}) };
}

function addInteractiveContent(
  interactive: MessageRecord | undefined,
  parts: string[],
  buttons: MessageButton[],
): { media?: ReturnType<typeof collectMedia> } {
  if (!interactive) return {};
  const header = recordAt(interactive, "header");
  const body = recordAt(interactive, "body");
  const footer = recordAt(interactive, "footer");
  pushText(parts, header?.title);
  pushText(parts, header?.subtitle);
  pushText(parts, body?.text);
  pushText(parts, footer?.text);
  collectNativeFlowButtons(recordAt(interactive, "nativeFlowMessage")?.buttons, buttons);

  let media = collectMedia(header);
  const carousel = recordAt(interactive, "carouselMessage");
  const cards = Array.isArray(carousel?.cards) ? carousel.cards.slice(0, 25) : [];
  for (const cardValue of cards) {
    const card = asRecord(cardValue);
    if (!card) continue;
    const cardHeader = recordAt(card, "header");
    const cardBody = recordAt(card, "body");
    const cardFooter = recordAt(card, "footer");
    pushText(parts, cardHeader?.title);
    pushText(parts, cardHeader?.subtitle);
    pushText(parts, cardBody?.text);
    pushText(parts, cardFooter?.text);
    collectNativeFlowButtons(recordAt(card, "nativeFlowMessage")?.buttons, buttons);
    media ??= collectMedia(cardHeader);
  }
  return { ...(media ? { media } : {}) };
}

function renderButtons(buttons: MessageButton[]): string[] {
  return buttons.map((button) => {
    const destination = button.url ?? button.phone;
    const suffix = destination ? ` — ${destination}` : button.id ? ` (${button.id})` : "";
    return `Button: ${button.text}${suffix}`;
  });
}

function messageDetails(content: MessageRecord | undefined): BaileysMessageDetails {
  if (!content) return { type: "text", content: null, mediaUrl: null };

  const rawType = typeName(content);
  const parts: string[] = [];
  const buttons: MessageButton[] = [];
  let media: ReturnType<typeof collectMedia>;

  pushText(parts, content.conversation);
  pushText(parts, recordAt(content, "extendedTextMessage")?.text);
  pushText(parts, recordAt(content, "imageMessage")?.caption);
  pushText(parts, recordAt(content, "videoMessage")?.caption);
  pushText(parts, recordAt(content, "documentMessage")?.caption);
  const eventMessage = recordAt(content, "eventMessage");
  pushText(parts, eventMessage?.name);
  pushText(parts, eventMessage?.description);
  pushText(parts, recordAt(eventMessage, "location")?.name);
  pushText(parts, recordAt(eventMessage, "location")?.address);
  media = collectMedia(content);

  const template = addTemplateContent(recordAt(content, "templateMessage"), parts, buttons);
  media ??= template.media;

  const interactive = addInteractiveContent(
    recordAt(content, "interactiveMessage"),
    parts,
    buttons,
  );
  media ??= interactive.media;

  const buttonsMessage = recordAt(content, "buttonsMessage");
  if (buttonsMessage) {
    pushText(parts, buttonsMessage.contentText ?? buttonsMessage.text);
    pushText(parts, buttonsMessage.footerText);
    collectButtonsMessageButtons(buttonsMessage.buttons, buttons);
    media ??= collectMedia(buttonsMessage);
  }

  const listMessage = recordAt(content, "listMessage");
  if (listMessage) {
    pushText(parts, listMessage.title);
    pushText(parts, listMessage.description);
    pushText(parts, listMessage.buttonText);
    const sections = Array.isArray(listMessage.sections) ? listMessage.sections.slice(0, 100) : [];
    for (const sectionValue of sections) {
      const section = asRecord(sectionValue);
      if (!section) continue;
      pushText(parts, section.title);
      const rows = Array.isArray(section.rows) ? section.rows.slice(0, 100) : [];
      for (const rowValue of rows) {
        const row = asRecord(rowValue);
        if (!row) continue;
        const title = firstString(row.title);
        const description = firstString(row.description);
        if (title) pushText(parts, description ? `${title} — ${description}` : title);
        buttons.push(makeButton("list_row", title ?? row.rowId, { id: row.rowId }));
      }
    }
    pushText(parts, listMessage.footerText);
  }

  const hsm = recordAt(content, "highlyStructuredMessage");
  if (hsm) {
    const hydrated = addTemplateContent(recordAt(hsm, "hydratedHsm"), parts, buttons);
    media ??= hydrated.media;
    pushText(parts, hsmText(hsm));
  }

  const buttonsResponse = recordAt(content, "buttonsResponseMessage");
  if (buttonsResponse) {
    const selectedText = firstString(
      buttonsResponse.selectedDisplayText,
      buttonsResponse.selectedButtonId,
    );
    pushText(parts, selectedText);
    if (selectedText) {
      buttons.push(
        makeButton("buttons_response", selectedText, { id: buttonsResponse.selectedButtonId }),
      );
    }
  }

  const templateReply = recordAt(content, "templateButtonReplyMessage");
  if (templateReply) {
    const selectedText = firstString(templateReply.selectedDisplayText, templateReply.selectedId);
    pushText(parts, selectedText);
    if (selectedText) {
      buttons.push(
        makeButton("template_button_reply", selectedText, { id: templateReply.selectedId }),
      );
    }
  }

  const listResponse = recordAt(content, "listResponseMessage");
  if (listResponse) {
    const selectedRowId = asRecord(listResponse.singleSelectReply)?.selectedRowId;
    pushText(parts, listResponse.title);
    pushText(parts, listResponse.description);
    if (selectedRowId) {
      buttons.push(
        makeButton("list_response", listResponse.title ?? selectedRowId, { id: selectedRowId }),
      );
    }
  }

  const interactiveResponse = recordAt(content, "interactiveResponseMessage");
  if (interactiveResponse) {
    pushText(parts, recordAt(interactiveResponse, "body")?.text);
    const response = recordAt(interactiveResponse, "nativeFlowResponseMessage");
    if (response) {
      const parsed = safeJsonRecord(response.paramsJson);
      const name = firstString(response.name) ?? "native_flow_response";
      const button = makeButton(name, parsed?.display_text ?? parsed?.text ?? parsed?.title, {
        id: parsed?.id ?? parsed?.row_id,
        url: parsed?.url ?? parsed?.link,
        phone: parsed?.phone_number,
      });
      buttons.push(button);
      pushText(parts, button.text);
    }
  }

  if (!media) {
    for (const nested of [
      recordAt(content, "templateMessage"),
      recordAt(content, "buttonsMessage"),
      recordAt(content, "interactiveMessage"),
    ]) {
      media = collectMedia(nested);
      if (media) break;
    }
  }
  if (media?.caption) pushText(parts, media.caption);

  const knownTypes: Record<string, MessageType> = {
    conversation: "text",
    extendedTextMessage: "text",
    templateMessage: "text",
    interactiveMessage: "text",
    buttonsMessage: "text",
    listMessage: "text",
    highlyStructuredMessage: "text",
    buttonsResponseMessage: "text",
    templateButtonReplyMessage: "text",
    listResponseMessage: "text",
    interactiveResponseMessage: "text",
    locationMessage: "location",
    liveLocationMessage: "location",
    contactMessage: "contact",
    contactsArrayMessage: "contact",
    pollCreationMessage: "poll",
    pollCreationMessageV2: "poll",
    pollCreationMessageV3: "poll",
    eventMessage: "event",
    albumMessage: "album",
    reactionMessage: "reaction",
    stickerMessage: "sticker",
    imageMessage: "image",
    videoMessage: "video",
    audioMessage: "audio",
    documentMessage: "document",
  };
  const mediaType = media?.type;
  const mappedType = rawType ? knownTypes[rawType] : undefined;
  const type: MessageType = mediaType ?? mappedType ?? "text";
  const unknownRawType = mediaType || mappedType ? undefined : rawType;
  if (unknownRawType && !unknownTypesLogged.has(unknownRawType)) {
    unknownTypesLogged.add(unknownRawType);
    logger.debug({ rawType: unknownRawType }, "Unknown Baileys message content type");
  }

  const contentText = [...parts, ...renderButtons(buttons)].join("\n") || null;
  const uniqueButtons = buttons.filter(
    (button, index) =>
      buttons.findIndex(
        (candidate) =>
          candidate.type === button.type &&
          candidate.text === button.text &&
          candidate.url === button.url &&
          candidate.id === button.id &&
          candidate.phone === button.phone,
      ) === index,
  );

  return {
    type,
    content: contentText,
    mediaUrl: media?.mediaUrl ?? null,
    ...(media?.mediaMimetype ? { mediaMimetype: media.mediaMimetype } : {}),
    ...(media?.mediaFileName ? { mediaFileName: media.mediaFileName } : {}),
    ...(media?.mediaSize ? { mediaSize: media.mediaSize } : {}),
    ...(media?.caption ? { mediaCaption: media.caption } : {}),
    ...(uniqueButtons.length ? { buttons: uniqueButtons } : {}),
    ...(unknownRawType ? { rawType: unknownRawType } : {}),
  };
}

/** Extract normalized content and display metadata from any supported Baileys message. */
export function extractMessageDetails(msg: WAMessage): BaileysMessageDetails {
  return messageDetails(messageContent(msg));
}

/** Extract the message type from a Baileys WAMessage. */
export function extractMessageType(msg: WAMessage): MessageType {
  return extractMessageDetails(msg).type;
}

/** Extract text content from a Baileys WAMessage. */
export function extractTextContent(msg: WAMessage): string | null {
  return extractMessageDetails(msg).content;
}

/** Extract quoted message ID from a Baileys WAMessage. */
export function extractQuotedMessageId(msg: WAMessage): string | null {
  const content = messageContent(msg);
  if (!content) return null;
  const context =
    recordAt(content, "extendedTextMessage")?.contextInfo ??
    recordAt(content, "imageMessage")?.contextInfo ??
    recordAt(content, "videoMessage")?.contextInfo ??
    recordAt(content, "audioMessage")?.contextInfo ??
    recordAt(content, "documentMessage")?.contextInfo ??
    recordAt(content, "templateMessage")?.contextInfo ??
    recordAt(content, "interactiveMessage")?.contextInfo ??
    recordAt(content, "listMessage")?.contextInfo;
  return stringValue(asRecord(context)?.stanzaId) ?? null;
}

/**
 * Swap LID/PN in message keys: when remoteJid is a LID and remoteJidAlt has the PN, use the PN.
 * This follows the Evolution API pattern for Baileys v7.
 */
export function normalizeLidInMessage(msg: WAMessage): void {
  const key = msg.key as Record<string, unknown>;
  if (
    key.remoteJid &&
    typeof key.remoteJid === "string" &&
    key.remoteJid.endsWith("@lid") &&
    key.remoteJidAlt
  ) {
    const lid = key.remoteJid;
    key.remoteJid = key.remoteJidAlt;
    key.remoteJidAlt = lid;
  }
}

/** Get the chat JID for a message (group or individual). */
export function getChatJid(msg: WAMessage): string {
  return msg.key.remoteJid ?? "";
}

/** Get the sender JID for a message. */
export function getSenderJid(msg: WAMessage): string {
  if (msg.key.participant) return msg.key.participant;
  if (!msg.key.fromMe) return msg.key.remoteJid ?? "";
  return "me";
}

// ---- Normalizers ----

/** Normalize a Baileys messages.upsert event to NormalizedMessageEvent[]. */
export function normalizeMessagesUpsert(
  instanceId: string,
  data: BaileysEventMap["messages.upsert"],
): NormalizedMessageEvent[] {
  if (data.type !== "notify" && data.type !== "append") return [];

  return data.messages
    .filter((msg) => {
      const content = unwrapMessageContent(msg.message, { unwrapProtocolEdits: false });
      return !content?.protocolMessage && !content?.pollUpdateMessage;
    })
    .map((msg) => {
      normalizeLidInMessage(msg);
      const details = extractMessageDetails(msg);
      const chatId = getChatJid(msg);
      const isGroup = chatId.endsWith("@g.us");
      return {
        instanceId,
        chatId,
        ...(typeof msg.key.remoteJidAlt === "string" && msg.key.remoteJidAlt
          ? { chatIdAlt: msg.key.remoteJidAlt }
          : {}),
        ...(typeof msg.key.participantAlt === "string" && msg.key.participantAlt
          ? { senderAlt: msg.key.participantAlt }
          : {}),
        chatName: isGroup ? null : (msg.pushName ?? null),
        senderName: msg.pushName ?? null,
        isGroup,
        message: {
          id: msg.key.id ?? "",
          sender: getSenderJid(msg),
          timestamp: messageTimestampToSeconds(msg.messageTimestamp, 0),
          type: details.type,
          content: details.content,
          mediaUrl: details.mediaUrl,
          ...(details.mediaMimetype ? { mediaMimetype: details.mediaMimetype } : {}),
          ...(details.mediaMimetype ? { mimeType: details.mediaMimetype } : {}),
          ...(details.mediaFileName
            ? { mediaFileName: details.mediaFileName, fileName: details.mediaFileName }
            : {}),
          ...(details.mediaSize ? { mediaSize: details.mediaSize, size: details.mediaSize } : {}),
          ...(details.mediaCaption
            ? { mediaCaption: details.mediaCaption, caption: details.mediaCaption }
            : {}),
          ...(details.buttons ? { buttons: details.buttons } : {}),
          ...(details.rawType ? { rawType: details.rawType } : {}),
          quotedMessageId: extractQuotedMessageId(msg),
          isFromMe: msg.key.fromMe ?? false,
          isForwarded: isMessageForwarded(msg),
        },
      };
    });
}

/** Normalize a Baileys messages.update event. */
export function normalizeMessagesUpdate(
  instanceId: string,
  updates: WAMessageUpdate[],
): NormalizedMessageUpdateEvent[] {
  return updates
    .filter((u) => u.update.status !== undefined)
    .map((u) => {
      const statusMap: Record<number, MessageDeliveryStatus> = {
        0: "received",
        1: "sent",
        2: "sent",
        3: "delivered",
        4: "read",
        5: "played",
      };

      return {
        instanceId,
        chatId: u.key.remoteJid ?? "",
        messageId: u.key.id ?? "",
        status: statusMap[u.update.status ?? 0] ?? "received",
      };
    });
}

/** Normalize a Baileys messages.delete event. */
export function normalizeMessagesDelete(
  instanceId: string,
  data: BaileysEventMap["messages.delete"],
): NormalizedMessageDeleteEvent[] {
  if ("keys" in data) {
    return data.keys.map((key) => ({
      instanceId,
      chatId: key.remoteJid ?? "",
      messageId: key.id ?? "",
      deletedBy: key.participant ?? key.remoteJid ?? "",
    }));
  }
  return [];
}

/** Normalize a Baileys messages.reaction event. */
export function normalizeMessagesReaction(
  instanceId: string,
  reactions: BaileysEventMap["messages.reaction"],
): NormalizedMessageReactionEvent[] {
  return reactions.map((r) => ({
    instanceId,
    chatId: r.key.remoteJid ?? "",
    messageId: r.key.id ?? "",
    emoji: r.reaction?.text ?? "",
    reactedBy: r.reaction?.key?.participant ?? r.reaction?.key?.remoteJid ?? "",
  }));
}

/** Normalize a Baileys message edit event. */
export function normalizeMessageEdit(
  instanceId: string,
  msg: WAMessage,
  chatId: string,
  content = unwrapMessageContent(msg.message, { unwrapProtocolEdits: false }),
): NormalizedMessageEditEvent {
  const protocolMessage = recordAt(content, "protocolMessage");
  const editedMessage = protocolMessage?.editedMessage;
  const editedContent = editedMessage
    ? (messageDetails(unwrapMessageContent(editedMessage as WAMessageContent)).content ?? "")
    : "";

  return {
    instanceId,
    chatId,
    messageId: stringValue(recordAt(protocolMessage, "key")?.id) ?? msg.key.id ?? "",
    newContent: editedContent,
    editedAt: messageTimestampToSeconds(msg.messageTimestamp, Math.floor(Date.now() / 1000)),
  };
}

/** Normalize a Baileys presence.update event. */
export function normalizePresenceUpdate(
  instanceId: string,
  data: BaileysEventMap["presence.update"],
): NormalizedPresenceEvent[] {
  const results: NormalizedPresenceEvent[] = [];
  const chatId = data.id;

  for (const [participant, presence] of Object.entries(data.presences)) {
    const statusMap: Record<string, PresenceStatus> = {
      composing: "composing",
      recording: "recording",
      paused: "paused",
      available: "available",
      unavailable: "unavailable",
    };

    results.push({
      instanceId,
      chatId,
      participant,
      status: statusMap[presence.lastKnownPresence] ?? "unavailable",
    });
  }

  return results;
}

/** Normalize a Baileys groups.update event. */
export function normalizeGroupsUpdate(
  instanceId: string,
  updates: BaileysEventMap["groups.update"],
): NormalizedGroupUpdateEvent[] {
  return updates.map((update) => ({
    instanceId,
    groupId: update.id ?? "",
    changes: { ...update } as Record<string, unknown>,
  }));
}

/** Normalize a Baileys group-participants.update event. */
export function normalizeGroupParticipantsUpdate(
  instanceId: string,
  data: BaileysEventMap["group-participants.update"],
): NormalizedGroupParticipantsEvent {
  const actionMap: Record<string, "add" | "remove" | "promote" | "demote"> = {
    add: "add",
    remove: "remove",
    promote: "promote",
    demote: "demote",
  };

  return {
    instanceId,
    groupId: data.id,
    action: actionMap[data.action] ?? "add",
    participants: data.participants.map((participant) =>
      typeof participant === "string" ? participant : participant.id,
    ),
  };
}

/** Normalize a Baileys contacts.update event. */
export function normalizeContactsUpdate(
  instanceId: string,
  updates: BaileysEventMap["contacts.update"],
): NormalizedContactUpdateEvent[] {
  return updates.map((contact) => ({
    instanceId,
    contactId: contact.id ?? "",
    changes: { ...contact } as Record<string, unknown>,
  }));
}

/** Normalize a Baileys connection.update event. */
export function normalizeConnectionUpdate(
  instanceId: string,
  update: BaileysEventMap["connection.update"],
): NormalizedConnectionEvent | null {
  if (update.connection === undefined && update.qr === undefined) return null;
  return {
    instanceId,
    status:
      update.connection === "open"
        ? "open"
        : update.connection === "close"
          ? "close"
          : "connecting",
    ...(update.qr ? { qrCode: update.qr } : {}),
  };
}

/** Normalize a Baileys call offer event. */
export function normalizeCallEvent(
  instanceId: string,
  calls: BaileysEventMap["call"],
): NormalizedCallEvent[] {
  return calls.map((call) => ({
    instanceId,
    chatId: call.chatId ?? "",
    callerId: call.from ?? call.callerPn ?? "",
    isVideo: call.isVideo ?? false,
    ...(call.isGroup !== undefined ? { isGroup: call.isGroup } : {}),
    callId: call.id ?? "",
    timestamp: call.date?.getTime() ?? Date.now(),
    status: call.status,
  }));
}
