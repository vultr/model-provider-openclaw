import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeModel, type ModelDocument } from "@vultr/model-catalog";

import {
  readSpeechSettings,
  responseFormat,
  speechBody,
  speechModels,
  speechSettingsFrom,
  toVoiceOptions,
  transcriptionModels,
  uploadName,
} from "../src/audio.ts";

// Trimmed from the live catalog.
const tts: ModelDocument = {
  schema_version: "2.4",
  id: "qwen3-tts-12hz-1.7b",
  name: "Qwen 3 TTS 12Hz 1.7B",
  input_modalities: [{ type: "text", supported_inputs: { max_prompt_length: { value: 6000, unit: "character" } } }],
  output_modalities: [
    {
      type: "speech",
      streaming: true,
      supported_parameters: { voice: { type: "enum", values: ["vivian", "ryan", "design", "clone"] } },
      pricing: [{ type: "completion", unit: "second", cost_usd: "0.00028" }],
    },
  ],
};

const whisper: ModelDocument = {
  schema_version: "2.4",
  id: "whisper-large-v3-turbo",
  name: "Whisper Large V3 Turbo",
  input_modalities: [{ type: "audio", pricing: [{ type: "prompt", unit: "second", cost_usd: "0.00001111" }] }],
  output_modalities: [{ type: "transcription", streaming: false }],
};

const omni: ModelDocument = {
  schema_version: "2.4",
  id: "mimo-v2.6-flash-rl",
  name: "MiMo",
  input_modalities: [{ type: "text" }, { type: "audio" }],
  output_modalities: [{ type: "text" }],
};

const catalog = [tts, whisper, omni].map(normalizeModel);

test("speech and transcription models are picked by what they produce", () => {
  assert.deepEqual(speechModels(catalog), ["qwen3-tts-12hz-1.7b"]);
  // A chat model that listens to audio is not a transcription model.
  assert.deepEqual(transcriptionModels(catalog), ["whisper-large-v3-turbo"]);
});

test("a model that is not ready is not offered", () => {
  assert.deepEqual(speechModels([normalizeModel({ ...tts, is_ready: false })]), []);
});

test("settings come from tts.providers.vultr, with the legacy block as a fallback", () => {
  assert.deepEqual(speechSettingsFrom({ providers: { vultr: { model: "m", speakerVoice: "ryan", speed: 1.2 } } }), {
    model: "m",
    voice: "ryan",
    speed: 1.2,
  });
  assert.deepEqual(speechSettingsFrom({ vultr: { voice: "vivian" } }), { voice: "vivian" });
  assert.deepEqual(speechSettingsFrom(undefined), {});
});

test("OpenClaw's voice keys are read in its order", () => {
  assert.equal(readSpeechSettings({ speakerVoice: "a", voice: "b" }).voice, "a");
  assert.equal(readSpeechSettings({ voiceId: "c" }).voice, "c");
  assert.equal(readSpeechSettings({ modelId: "m" }).model, "m");
});

test("an unknown response format is refused", () => {
  assert.equal(readSpeechSettings({ responseFormat: "WAV" }).responseFormat, "wav");
  assert.throws(() => readSpeechSettings({ responseFormat: "aac" }), /mp3, opus, flac, wav, pcm/);
});

test("a voice note is Opus unless a format is configured", () => {
  assert.equal(responseFormat("voice-note", undefined), "opus");
  assert.equal(responseFormat("audio-file", undefined), "mp3");
  assert.equal(responseFormat("voice-note", "wav"), "wav");
});

test("the request body carries only what is set, overrides first", () => {
  assert.deepEqual(
    speechBody({ text: "hi", model: "m", settings: {}, overrides: undefined, format: "mp3" }),
    { model: "m", input: "hi", response_format: "mp3" },
  );
  assert.deepEqual(
    speechBody({
      text: "hi",
      model: "m",
      settings: { voice: "vivian", speed: 1, instructions: "calm", language: "en" },
      overrides: { voice: "ryan", speed: 1.5 },
      format: "opus",
    }),
    { model: "m", input: "hi", response_format: "opus", voice: "ryan", speed: 1.5, instructions: "calm", language: "en" },
  );
});

test("voices from /v1/audio/voices become OpenClaw voice options", () => {
  const payload = {
    object: "list",
    model: "qwen3-tts-12hz-1.7b",
    data: [
      { id: "ryan", name: "Ryan", description: "Dynamic male voice.", mode: "custom_voice", native_language: "English" },
      { id: "design", name: "Voice design", description: "A new voice.", mode: "voice_design" },
      { name: "no id" },
    ],
  };
  assert.deepEqual(toVoiceOptions(payload), [
    { id: "ryan", name: "Ryan", description: "Dynamic male voice. (English)", category: "custom_voice" },
    { id: "design", name: "Voice design", description: "A new voice.", category: "voice_design" },
  ]);
  assert.deepEqual(toVoiceOptions({ error: {} }), []);
});

test("an upload without an extension gets one from its type", () => {
  assert.equal(uploadName("memo.m4a", "audio/mp4"), "memo.m4a");
  assert.equal(uploadName("voice", "audio/ogg; codecs=opus"), "voice.ogg");
  assert.equal(uploadName("", undefined), "audio.mp3");
});
