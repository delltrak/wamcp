import type { TtsConfig } from "./config.js";
import { ElevenLabsProvider, type ElevenLabsDependencies } from "./elevenlabs.js";
import type { TtsProvider } from "./provider.js";

export interface TtsProviderDependencies {
  elevenLabs?: ElevenLabsDependencies;
}

export function createTtsProvider(
  config: TtsConfig,
  dependencies: TtsProviderDependencies = {},
): TtsProvider {
  switch (config.provider) {
    case "elevenlabs":
      return new ElevenLabsProvider(config, dependencies.elevenLabs);
    default:
      throw new Error(`Unsupported TTS provider '${config.provider}'.`);
  }
}
