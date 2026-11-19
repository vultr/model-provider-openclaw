import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import type {
  OpenClawPluginApi,
  OpenClawPluginDefinition,
  ProviderCatalogContext,
  ProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";

import { VERSION } from "../src/version.ts";

let server: Server;
let baseUrl: string;
const agents: (string | undefined)[] = [];
const keys: (string | undefined)[] = [];

before(async () => {
  server = createServer((req, res) => {
    agents.push(req.headers["user-agent"]);
    keys.push(req.headers["authorization"]);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [] }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

after(() => server.close());

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

test("VERSION is the package version", () => {
  assert.equal(VERSION, version, "set src/version.ts to the package version, then npm run build");
});

// The source and the bundle OpenClaw loads.
for (const entry of ["../index.ts", "../dist/index.js"]) {
  test(`${entry} names the plugin and its version in the catalog request`, async () => {
    const plugin = (await import(entry)).default as OpenClawPluginDefinition;
    let provider: ProviderPlugin | undefined;
    const api = { registerProvider: (registered: ProviderPlugin) => (provider = registered) };
    await plugin.register?.(api as unknown as OpenClawPluginApi);
    const ctx = {
      env: { VULTR_INFERENCE_BASE_URL: baseUrl },
      agentDir: mkdtempSync(join(tmpdir(), "vultr-openclaw-")),
      resolveProviderApiKey: () => ({ apiKey: "key" }),
    };
    agents.length = 0;
    await provider?.catalog?.run(ctx as unknown as ProviderCatalogContext);
    assert.equal(agents.length, 1);
    assert.ok(agents[0]?.startsWith(`vultr-model-provider-openclaw/${version} vultr-model-catalog/`), agents[0]);
  });

  // The gateway answers the catalog for the key that asks, so every read carries the key.
  test(`${entry} sends the provider's key with each catalog read`, async () => {
    const plugin = (await import(entry)).default as OpenClawPluginDefinition;
    let provider: ProviderPlugin | undefined;
    const api = { registerProvider: (registered: ProviderPlugin) => (provider = registered) };
    await plugin.register?.(api as unknown as OpenClawPluginApi);
    const agentDir = mkdtempSync(join(tmpdir(), "vultr-openclaw-"));
    type Prepare = Parameters<NonNullable<ProviderPlugin["prepareDynamicModel"]>>[0];
    const prepare = () => provider?.prepareDynamicModel?.({ agentDir, provider: "vultr", modelId: "m" } as unknown as Prepare);
    const saved = { key: process.env["VULTR_INFERENCE_API_KEY"], url: process.env["VULTR_INFERENCE_BASE_URL"] };
    try {
      process.env["VULTR_INFERENCE_BASE_URL"] = baseUrl;
      delete process.env["VULTR_INFERENCE_API_KEY"];
      keys.length = 0;
      await prepare();
      process.env["VULTR_INFERENCE_API_KEY"] = "env-key";
      await prepare();
      await provider?.catalog?.run({
        env: { VULTR_INFERENCE_BASE_URL: baseUrl },
        agentDir,
        resolveProviderApiKey: () => ({ apiKey: "stored-key" }),
      } as unknown as ProviderCatalogContext);
      // The model hook is handed no key: it reads with the one the catalog last ran with.
      await prepare();
      assert.deepEqual(keys, [undefined, "Bearer env-key", "Bearer stored-key", "Bearer stored-key"]);
    } finally {
      for (const [name, value] of [["VULTR_INFERENCE_API_KEY", saved.key], ["VULTR_INFERENCE_BASE_URL", saved.url]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
}
