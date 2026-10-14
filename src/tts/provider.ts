export interface TtsVoiceSettings {
  stability?: number;
  similarityBoost?: number;
  style?: number;
  speed?: number;
  useSpeakerBoost?: boolean;
}

export interface TtsSynthesizeOptions {
  voiceId: string;
  modelId?: string;
  languageCode?: string;
  voiceSettings?: TtsVoiceSettings;
  previousText?: string;
  nextText?: string;
}

export interface TtsAudio {
  audio: Buffer;
  mimeType: string;
}

export interface TtsVoice {
  voiceId: string;
  name: string;
  category?: string;
  description?: string;
  labels?: Record<string, string>;
}

export interface TtsProvider {
  synthesize(text: string, opts: TtsSynthesizeOptions): Promise<TtsAudio>;
  listVoices?(): Promise<TtsVoice[]>;
}
