import { getTtsConfig, type TtsConfig } from "./config.js";
import { normalizeToWhatsAppVoiceNote, type FfmpegRunner } from "./audio.js";
import { createTtsProvider, type TtsProviderDependencies } from "./registry.js";
import type { TtsAudio, TtsProvider, TtsSynthesizeOptions, TtsVoice } from "./provider.js";

export const TTS_CHUNK_MAX_CHARS = 4500;

export interface TtsServiceDependencies {
  config?: TtsConfig;
  provider?: TtsProvider;
  providerDependencies?: TtsProviderDependencies;
  ffmpegRunner?: FfmpegRunner;
}

export function chunkText(text: string, maxChars = TTS_CHUNK_MAX_CHARS): string[] {
  if (!text) return [];
  const characters = Array.from(text);
  const chunks: string[] = [];

  while (characters.length > maxChars) {
    const searchStart = Math.floor(maxChars * 0.6);
    let splitAt = -1;
    for (let index = maxChars - 1; index >= searchStart; index -= 1) {
      if (/\s/u.test(characters[index]!)) {
        splitAt = index + 1;
        break;
      }
    }
    if (splitAt < 1) splitAt = maxChars;
    chunks.push(characters.splice(0, splitAt).join(""));
  }
  if (characters.length > 0) chunks.push(characters.join(""));
  return chunks;
}

export class TtsService {
  readonly maxChars: number;
  private readonly config: TtsConfig;
  private provider: TtsProvider | undefined;
  private readonly providerDependencies: TtsProviderDependencies;
  private readonly ffmpegRunner: FfmpegRunner | undefined;

  constructor(dependencies: TtsServiceDependencies = {}) {
    this.config = dependencies.config ?? getTtsConfig();
    this.maxChars = this.config.maxChars;
    this.provider = dependencies.provider;
    this.providerDependencies = dependencies.providerDependencies ?? {};
    this.ffmpegRunner = dependencies.ffmpegRunner;
  }

  assertConfigured(): void {
    if (!this.config.enabled) {
      throw new Error("TTS is disabled. Set WA_TTS_ENABLED=true to enable voice notes.");
    }
    if (!this.config.apiKey) {
      throw new Error("TTS not configured. Set WA_TTS_API_KEY before using voice notes.");
    }
  }

  assertTextWithinLimit(text: string): void {
    if (text.length > this.maxChars) {
      throw new Error(`Text exceeds the configured TTS limit of ${this.maxChars} characters.`);
    }
  }

  resolveVoiceId(voiceId?: string): string {
    const resolved = voiceId?.trim() || this.config.defaultVoiceId;
    if (!resolved) {
      throw new Error("No TTS voice is configured. Set WA_TTS_DEFAULT_VOICE_ID or pass voiceId.");
    }
    return resolved;
  }

  async synthesize(
    text: string,
    options: Omit<TtsSynthesizeOptions, "voiceId" | "previousText" | "nextText"> & {
      voiceId?: string;
    } = {},
  ): Promise<TtsAudio> {
    this.assertConfigured();
    this.assertTextWithinLimit(text);
    if (!text.trim()) throw new Error("Text to synthesize cannot be empty.");

    const voiceId = this.resolveVoiceId(options.voiceId);
    const chunks = chunkText(text);
    const provider = this.getProvider();
    const generated: TtsAudio[] = [];

    for (let index = 0; index < chunks.length; index += 1) {
      generated.push(
        await provider.synthesize(chunks[index]!, {
          ...options,
          voiceId,
          previousText: index > 0 ? chunks[index - 1] : undefined,
          nextText: index < chunks.length - 1 ? chunks[index + 1] : undefined,
        }),
      );
    }

    return normalizeToWhatsAppVoiceNote(generated, undefined, this.ffmpegRunner);
  }

  async listVoices(): Promise<TtsVoice[]> {
    this.assertConfigured();
    const provider = this.getProvider();
    if (!provider.listVoices)
      throw new Error(`The '${this.config.provider}' TTS provider does not support voice listing.`);
    return provider.listVoices();
  }

  private getProvider(): TtsProvider {
    this.provider ??= createTtsProvider(this.config, this.providerDependencies);
    return this.provider;
  }
}
