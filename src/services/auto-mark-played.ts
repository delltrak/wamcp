// ============================================================
// WA MCP — Optional played receipt after audio transcription
// Off unless WA_AUTO_MARK_PLAYED=true. wa_mark_played stays available either way.
// ============================================================

import type { ChannelAdapter } from "../channels/channel.interface.js";
import { createChildLogger } from "../utils/logger.js";

const logger = createChildLogger({ service: "auto-mark-played" });

export interface AutoMarkPlayedConfig {
  enabled: boolean;
}

function readBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const value = env[key];
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`Invalid ${key}; expected true or false`);
}

/** Read the auto played-receipt flag. Invalid values throw. The default is off. */
export function loadAutoMarkPlayedConfig(
  env: NodeJS.ProcessEnv = process.env,
): AutoMarkPlayedConfig {
  return { enabled: readBoolean(env, "WA_AUTO_MARK_PLAYED", false) };
}

/** False when the flag is off or invalid. Invalid values are logged instead of failing transcription. */
export function isAutoMarkPlayedEnabled(): boolean {
  try {
    return loadAutoMarkPlayedConfig().enabled;
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "Auto mark played configuration is invalid",
    );
    return false;
  }
}

/**
 * After a stored audio message is transcribed, send a played receipt when the flag is on.
 * Receipt failures are logged and do not fail the transcription.
 */
export async function markTranscribedAudioPlayed(
  getAdapter: () => Pick<ChannelAdapter, "markPlayedMessage">,
  messageId: string,
  options: { isFromMe?: boolean; chatId?: string } = {},
): Promise<void> {
  if (options.isFromMe) return;

  let config: AutoMarkPlayedConfig;
  try {
    config = loadAutoMarkPlayedConfig();
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "Auto mark played configuration is invalid",
    );
    return;
  }
  if (!config.enabled) return;

  const id = messageId.trim();
  if (!id) return;
  try {
    await getAdapter().markPlayedMessage(id, options.chatId);
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error), messageId: id },
      "Auto mark played failed",
    );
  }
}
