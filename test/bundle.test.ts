import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const script = (JSON.parse(readFileSync(`${root}package.json`, "utf8")) as { scripts: { build: string } }).scripts.build;

// OpenClaw installs with --ignore-scripts and loads ./dist/index.js, so the bundle is
// committed. It must match the source and carry everything except the host SDK.
test("dist/index.js is the current build", () => {
  const args = script
    .replace(/^esbuild /, "")
    .replace(/ --outfile=\S+/, "")
    .split(" ")
    .map((arg) => arg.replaceAll('"', ""));
  const built = execFileSync(`${root}node_modules/.bin/esbuild`, args, { cwd: root, encoding: "utf8" });
  assert.equal(readFileSync(`${root}dist/index.js`, "utf8"), built, "run npm run build and commit dist/");
});

test("the bundle imports only node builtins and the host SDK", () => {
  const imports = [...readFileSync(`${root}dist/index.js`, "utf8").matchAll(/from "([^".][^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(
    imports.filter((name) => !name?.startsWith("node:") && !name?.startsWith("openclaw/")),
    [],
  );
});
