import type { CatalogModel } from "@vultr/model-catalog";

// What /v1/audio/speech can encode. aac is refused there: the engine has no encoder for it.
export const RESPONSE_FORMATS = ["mp3", "opus", "flac", "wav", "pcm"] as const;
export type ResponseFormat = (typeof RESPONSE_FORMATS)[number];

export type SpeechTarget = "audio-file" | "voice-note" | "telephony";

// The catalog says what a model produces: `speech` for text to speech, `transcription` for speech to text.
function producing(models: CatalogModel[], modality: string): string[] {
  return models.filter((model) => model.isReady && model.outputModalities.includes(modality)).map((model) => model.id);
}

export const speechModels = (models: CatalogModel[]) => producing(models, "speech");
export const transcriptionModels = (models: CatalogModel[]) => producing(models, "transcription");

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const record = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

export interface SpeechSettings {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  voice?: string;
  instructions?: string;
  language?: string;
  speed?: number;
  responseFormat?: ResponseFormat;
}

function format(value: unknown): ResponseFormat | undefined {
  const name = text(value)?.toLowerCase();
  if (name === undefined) {
    return undefined;
  }
  if (!(RESPONSE_FORMATS as readonly string[]).includes(name)) {
    throw new Error(`Vultr speech responseFormat must be one of ${RESPONSE_FORMATS.join(", ")}, not ${name}`);
  }
  return name as ResponseFormat;
}

// One provider block: `tts.providers.vultr`, a persona's block, or Talk's. Voice keys follow OpenClaw's.
export function readSpeechSettings(raw: unknown): SpeechSettings {
  const block = record(raw) ?? {};
  const settings: SpeechSettings = {};
  const assign = <K extends keyof SpeechSettings>(key: K, value: SpeechSettings[K] | undefined) => {
    if (value !== undefined) {
      settings[key] = value;
    }
  };
  assign("apiKey", text(block.apiKey));
  assign("baseUrl", text(block.baseUrl));
  assign("model", text(block.model ?? block.modelId));
  assign("voice", text(block.speakerVoice ?? block.speakerVoiceId ?? block.voice ?? block.voiceId));
  assign("instructions", text(block.instructions));
  assign("language", text(block.language));
  assign("speed", number(block.speed));
  assign("responseFormat", format(block.responseFormat));
  return settings;
}

// `tts.providers.vultr`, with the legacy direct `tts.vultr` block as a fallback.
export function speechSettingsFrom(rawConfig: unknown): SpeechSettings {
  const config = record(rawConfig);
  return readSpeechSettings(record(config?.providers)?.vultr ?? config?.vultr);
}

// A voice note is Opus so channels can send it as one. Everything else defaults to mp3, as OpenAI's does.
export function responseFormat(target: SpeechTarget, configured: ResponseFormat | undefined): ResponseFormat {
  return configured ?? (target === "voice-note" ? "opus" : "mp3");
}

export interface SpeechRequest {
  text: string;
  model: string;
  settings: SpeechSettings;
  overrides: Record<string, unknown> | undefined;
  format: ResponseFormat;
}

// An omitted voice is the model's default speaker.
export function speechBody({ text: input, model, settings, overrides, format: responseFormat }: SpeechRequest) {
  const voice = text(overrides?.voice ?? overrides?.voiceId) ?? settings.voice;
  const speed = number(overrides?.speed) ?? settings.speed;
  return {
    model,
    input,
    response_format: responseFormat,
    ...(voice ? { voice } : {}),
    ...(speed !== undefined ? { speed } : {}),
    ...(settings.instructions ? { instructions: settings.instructions } : {}),
    ...(settings.language ? { language: settings.language } : {}),
  };
}

export interface VoiceOption {
  id: string;
  name?: string;
  description?: string;
  category?: string;
}

// GET /v1/audio/voices answers {data: [{id, name, description, mode, native_language}]}.
export function toVoiceOptions(payload: unknown): VoiceOption[] {
  const data = record(payload)?.data;
  if (!Array.isArray(data)) {
    return [];
  }
  return data.flatMap((entry) => {
    const voice = record(entry);
    const id = text(voice?.id);
    if (!voice || !id) {
      return [];
    }
    const language = text(voice.native_language);
    const description = [text(voice.description), language && `(${language})`].filter(Boolean).join(" ");
    const name = text(voice.name);
    const mode = text(voice.mode);
    return [{ id, ...(name ? { name } : {}), ...(description ? { description } : {}), ...(mode ? { category: mode } : {}) }];
  });
}

// Files sent to /v1/audio/transcriptions need an extension the engine recognizes.
export function uploadName(fileName: string, mime: string | undefined): string {
  if (/\.[a-z0-9]{2,5}$/i.test(fileName)) {
    return fileName;
  }
  const extension: Record<string, string> = {
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/flac": "flac",
    "audio/ogg": "ogg",
    "audio/opus": "ogg",
    "audio/webm": "webm",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "m4a",
  };
  const type = mime?.split(";")[0]?.trim().toLowerCase();
  return `${fileName || "audio"}.${(type && extension[type]) ?? "mp3"}`;
}
