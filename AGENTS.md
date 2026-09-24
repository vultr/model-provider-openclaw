# AGENTS.md - vultr/model-provider-openclaw

A native OpenClaw plugin: one provider, `vultr`, fed by the live catalog. `index.ts` is the entry source and holds the hooks; `dist/index.js` is its committed bundle and is what OpenClaw loads; `src/models.ts` is the mapping and is what the tests cover; `openclaw.plugin.json` is the manifest OpenClaw reads before it loads any code.

Human overview, mapping table and install: `README.md`.

## What holds the design up

- **The catalog library does the reading.** `@vultr/model-catalog` fetches
  `GET /v1/models`, parses Model Document 2.4 and normalizes it. This repo
  only maps a normalized model onto what OpenClaw has a place for. A parsing
  or normalization fix belongs in the library, not here
- **Nothing static.** No model id, context window or price is written in this
  repo. A model Vultr adds shows up without a release
- **Never break the host.** No network and no cache means the provider is
  absent or keeps what OpenClaw already had. Startup, listing and requests
  must not raise because the catalog is down
- **Only usable models are offered:** text output, `is_ready`, and a context
  window. Rerankers, image generators and unready models are dropped
- **Requests must be accepted by the engine.** Vultr publishes `max_length`
  equal to the context window for most models. Sent as `max_tokens` that is
  always rejected (prompt + max_tokens > context). Check what OpenClaw does
  with the output limit before changing how it is mapped
- **Reasoning travels as top-level `reasoning_effort`,** limited to the
  model's `supported_efforts`; `none` switches it off unless reasoning is
  mandatory.
- **Siblings:** `model-provider-pi` maps onto almost the same model type (OpenClaw is built on pi). A mapping fix here usually applies there too

## Working here

- `npm run typecheck` and `npm test` must pass. Types come from the real
  `openclaw` package (`openclaw/plugin-sdk/*`); do not redeclare them
- `dist/index.js` is committed and must be current: `npm run build` after any
  source change, in the same commit. `test/bundle.test.ts` fails otherwise.
  OpenClaw rejects a TypeScript entry for anything but a linked checkout, and
  installs with `npm install --omit=dev --ignore-scripts`, so a git dependency
  that builds in `prepare` would arrive empty. That is why the catalog library
  is a devDependency bundled into `dist/`, and why there are no runtime
  dependencies. `--link` hides all of this: test a copy install too
- This must stay a native plugin. A Claude, Codex or Cursor style bundle
  cannot register a provider: OpenClaw does not run bundle code in process
- `catalog` alone is not enough. The list is fed by `catalog.run`, the agent
  runtime by `prepareDynamicModel` and `resolveDynamicModel`. Test both:
  `models list --refresh` and `infer model run --local`
- `openclaw.plugin.json` and `package.json` `openclaw.*` carry the versions
  this was built against. Bump them with the OpenClaw version you test on.
  OpenClaw calls every plugin API experimental
- OpenClaw's behavior is in the installed package, not in web summaries:
  `docs/plugins/sdk-provider-plugins.md`, its `model-catalogs` page, and
  `dist/extensions/openrouter/index.js` as a worked provider
- Test in a throwaway profile (`openclaw --profile <name>`), never in the
  user's own state; remove `~/.openclaw-<name>` afterwards
- Verify against the installed OpenClaw, not only the unit tests. The
  README describes the key-free capture setup
- Put lasting explanation in `docs/` or the README, not in the source. If a
  comment is needed, make it short. Docs describe current behavior, not history
- Write commit messages to the Conventional Commits spec
- No em dashes or en dashes anywhere: prose, comments, commit messages and
  docs use plain hyphens, `·`, or `:`
- No AI trailers on commits (`Co-Authored-By`, `Generated with`, ...)
- Never force-push; never rewrite pushed history
