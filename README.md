# @vultr/model-provider-openclaw

Vultr Inference as a model, speech and transcription provider plugin for [OpenClaw](https://openclaw.ai). The model list, context windows, prices, input types and reasoning levels come from the live `GET /v1/models` catalog, and so do the text-to-speech and speech-to-text models.

## Install

```bash
openclaw plugins install clawhub:@vultr/model-provider-openclaw --accept-capabilities
export VULTR_INFERENCE_API_KEY=... # or: openclaw onboard --vultr-api-key <key>
openclaw models list --all --provider vultr --refresh
openclaw infer model run --local --model vultr/glm-5.3 --thinking high --prompt "hello"
```

To install from the Git repository instead:

```bash
openclaw plugins install git:github.com/vultr/model-provider-openclaw --force --accept-capabilities
```

`--force` is required for sources outside ClawHub. A local checkout installs
the same way; OpenClaw copies it:

```bash
openclaw plugins install ~/src/vultr/model-provider-openclaw --force --accept-capabilities
```

For development, link the working tree into a throwaway profile instead of
copying it:

```bash
npm install && npm run build
openclaw --profile vultr-dev plugins install --link . --force --accept-capabilities
```

## How it works

OpenClaw loads `dist/index.js`, a single file built from `index.ts` with
`@vultr/model-catalog` bundled in. It is committed: OpenClaw refuses a
TypeScript entry outside a linked checkout, and it installs dependencies with
`--ignore-scripts`, so nothing can be built on the user's machine.

`index.ts` registers provider `vultr` with three hooks:

- `catalog.run` feeds the model list and picker. Following OpenClaw's
  convention it returns `null` without an API key: listing needs no key, but a
  provider without one cannot be called
- `prepareDynamicModel` and `resolveDynamicModel` are what the agent runtime
  uses to resolve `vultr/<id>`. Without them a model that is in the list still
  fails with `Unknown model`. `prepare` loads the catalog; `resolve` is
  synchronous and answers from what `prepare` loaded

It also registers speech provider `vultr` and an audio media-understanding
provider `vultr`; see [Speech and transcription](#speech-and-transcription).

The last good catalog is kept in `<agent dir>/cache/vultr-model-catalog.json`
and served when the network fails. With neither, the hooks return nothing and
OpenClaw carries on without the provider.

## Mapping

| OpenClaw | Catalog |
| --- | --- |
| `contextWindow` | `contextWindow` |
| `maxTokens` | `outputBudget`: the smallest of `maxOutputTokens`, 65536 and a quarter of the context window |
| `cost` (USD per million) | `pricePerMillion`: prompt, completion, cached prompt, cache write |
| `input` | `text`, `image`, `video`, `audio` as accepted. The runtime model keeps `text` and `image` only |
| `reasoning`, `thinkingLevelMap` | as in `model-provider-pi` |
| `compat` | `maxTokensField: "max_tokens"`, `supportsDeveloperRole: false`, `supportsStore: false`, `supportsReasoningEffort`, `supportedReasoningEfforts`, `supportsTools` |

The output budget exists because OpenClaw sends `maxTokens` as `max_tokens`
without clamping it to the context that is left, and Vultr publishes
`max_length` equal to the context window for most models. Unchanged, every
request would ask for more than the engine can give and be rejected.

## Speech and transcription

| OpenClaw | Vultr |
| --- | --- |
| Speech provider `vultr` | `POST /v1/audio/speech`. Models are the catalog's ready models with `speech` output |
| Its voices (`infer tts voices`) | `GET /v1/audio/voices?model=`, live |
| Media understanding, audio | `POST /v1/audio/transcriptions` (multipart). Models are the catalog's ready models with `transcription` output |

Without a configured model, each uses the catalog's first model of its kind.
Speech asks for mp3, or Opus for a voice note, unless `responseFormat` is set
(`mp3`, `opus`, `flac`, `wav`, `pcm`). The key comes from the provider block's
`apiKey`, then the stored Vultr credential, then `VULTR_INFERENCE_API_KEY`.

```bash
openclaw config set tts.provider vultr
openclaw config set tts.providers.vultr '{"model":"qwen3-tts-12hz-1.7b","speakerVoice":"aiden"}' --strict-json
openclaw config set tools.media.models '[{"provider":"vultr","model":"whisper-large-v3-turbo","capabilities":["audio"]}]' --strict-json
openclaw infer tts voices --provider vultr
openclaw infer tts convert --text "hello" --output ./hello.mp3
openclaw infer audio transcribe --file ./hello.mp3
```

`tts.providers.vultr` also takes `instructions`, `language` and `speed`,
passed to the speech route as is.

OpenClaw reads a speech provider's model list once, at registration. The
plugin refills that list in place whenever it loads the catalog, so a new
model appears without a restart once the gateway has listed models. Set the
model on `tts.providers.vultr` rather than in `agents.defaults.voiceModel`:
OpenClaw silently drops a `voiceModel` ref that is not in the list yet.

## Environment

| Variable | Meaning |
| --- | --- |
| `VULTR_INFERENCE_API_KEY` | Detected by OpenClaw as the provider credential |
| `VULTR_INFERENCE_BASE_URL` | Overrides `https://api.vultrinference.com/v1` for the catalog and for requests |

## Development

```bash
npm install
npm run typecheck
npm run build      # after any source change; commit dist/
npm test
```

Verifying against the real harness needs no API key: serve
`model-catalog-typescript/fixtures/vultr-catalog.json` at `/v1/models` from a
local server that records `POST /v1/chat/completions` and answers with a short
SSE stream, then set `VULTR_INFERENCE_BASE_URL` to it and `VULTR_INFERENCE_API_KEY` to
any value. Read the recorded request body: that is what Vultr would receive.
