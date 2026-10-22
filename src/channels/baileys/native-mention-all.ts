import { generateWAMessageContent, type WAMediaUploadFunction } from "@whiskeysockets/baileys";
import { createChildLogger } from "../../utils/logger.js";

const logger = createChildLogger({ service: "baileys-native-mention-all" });

const unusedUpload: WAMediaUploadFunction = async () => {
  throw new Error("Media upload is not used when detecting native group @all");
};

let detected: Promise<boolean> | undefined;

/**
 * Baileys encodes native group @all as contextInfo.nonJidMentions = 1 and leaves
 * mentionedJid / groupMentions empty. Listing every participant is a different send.
 */
export function baileysSupportsNativeGroupMentionAll(): Promise<boolean> {
  detected ??= detectNativeGroupMentionAll();
  return detected;
}

async function detectNativeGroupMentionAll(): Promise<boolean> {
  try {
    const generated = await generateWAMessageContent(
      { text: "@all", mentionAll: true },
      { upload: unusedUpload },
    );
    const context = generated.extendedTextMessage?.contextInfo;
    const mentionedJid = context?.mentionedJid ?? [];
    const groupMentions = context?.groupMentions ?? [];
    return context?.nonJidMentions === 1 && mentionedJid.length === 0 && groupMentions.length === 0;
  } catch (error) {
    logger.warn({ err: error }, "Native group @all support could not be detected");
    return false;
  }
}
