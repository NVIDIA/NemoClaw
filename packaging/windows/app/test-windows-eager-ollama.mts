// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { compileEagerOllamaRuntime } from "./openclaw-app-resources.mts";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return path.resolve(process.argv[index + 1]);
}
const source = argument("--source-root");
const tools = argument("--tool-root");
const relative = "dist/stream-api-DUG3zQPW.js";
const original = fs.readFileSync(path.join(source, relative), "utf8");
const adapted = compileEagerOllamaRuntime(relative, original);
const require = createRequire(import.meta.url);
const compiler = require(path.join(tools, "node_modules/esbuild")) as typeof import("esbuild");
assert.equal(compiler.version, "0.27.4");
assert.equal(compileEagerOllamaRuntime("dist/unrelated.js", original), original);
assert.throws(() => compileEagerOllamaRuntime(relative, original + "\n"), /reviewed eager Ollama/);

// Both modules reference the same real, integrity-checked upstream runtime.
// No export implementation is replaced for this comparison.
const moduleUrl = pathToFileURL(path.join(source, relative));
const absoluteAdapted = adapted.replace(/"(\.\/[^"\n]+)"/g, (_match, specifier: string) =>
  JSON.stringify(new URL(specifier, moduleUrl).href),
);
const baseline = await import(moduleUrl.href);
const candidate = await import(
  "data:text/javascript;base64," + Buffer.from(absoluteAdapted).toString("base64")
);
assert.deepEqual(Object.keys(candidate), ["a", "c", "i", "n", "o", "r", "s", "t"]);
assert.deepEqual(Object.keys(candidate), Object.keys(baseline));
for (const name of Object.keys(baseline)) assert.equal(candidate[name], baseline[name], name);

// Fixture boundaries exercise eager initialization order, all exported bindings,
// failure propagation and the real compiler's synchronous CJS output.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ollama-eager-control-"));
const exports = [
  "OLLAMA_NATIVE_BASE_URL",
  "resolveOllamaBaseUrlForRun",
  "buildOllamaChatRequest",
  "convertToOllamaMessages",
  "buildAssistantMessage",
  "parseNdjsonStream",
  "createOllamaStreamFn",
  "createConfiguredOllamaStreamFn",
];
const marker = "nemoclaw.ollama-eager.control";
const observations = globalThis as typeof globalThis & { [marker]?: string[] };
try {
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
  for (const name of ["lazy-runtime-CgCh8H_K.js", "lazy-promise-DGqyc4Y4.js"])
    fs.copyFileSync(path.join(source, "dist", name), path.join(root, name));
  fs.writeFileSync(
    path.join(root, "stream-compat-DSz3ALUi.js"),
    `globalThis[${JSON.stringify(marker)}].push("compat");\n`,
  );
  const body =
    `globalThis[${JSON.stringify(marker)}].push("runtime");\n` +
    exports.map((name) => `export const ${name}=${JSON.stringify(name)};`).join("\n");
  fs.writeFileSync(path.join(root, "stream.runtime.js"), body);
  fs.writeFileSync(path.join(root, "adapted.js"), adapted);
  const compiled = await compiler.build({
    entryPoints: [path.join(root, "adapted.js")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22.23",
    write: false,
  });
  const output = path.join(root, "compiled.cjs");
  fs.writeFileSync(output, compiled.outputFiles[0].contents);
  observations[marker] = [];
  const loaded = require(output) as Record<string, string>;
  assert.deepEqual(observations[marker], ["compat", "runtime"]);
  assert.deepEqual(Object.keys(loaded).sort(), Object.keys(baseline).sort());
  assert.deepEqual(Object.values(loaded).sort(), exports.toSorted());
  assert.equal(require(output), loaded, "Repeated loads share the same module instance.");
  assert.deepEqual(observations[marker], ["compat", "runtime"]);

  for (const [label, code] of [
    ["upstream", original],
    ["adapted", adapted],
  ]) {
    const directory = path.join(root, label);
    fs.mkdirSync(directory);
    for (const name of [
      "lazy-runtime-CgCh8H_K.js",
      "lazy-promise-DGqyc4Y4.js",
      "stream-compat-DSz3ALUi.js",
    ])
      fs.copyFileSync(path.join(root, name), path.join(directory, name));
    fs.writeFileSync(
      path.join(directory, "stream.runtime.js"),
      'throw new Error("owned-runtime-init-failure");\n' +
        exports.map((name) => `export const ${name}=null;`).join("\n"),
    );
    const entry = path.join(directory, "entry.js");
    fs.writeFileSync(entry, code);
    await assert.rejects(import(pathToFileURL(entry).href), /owned-runtime-init-failure/);
    if (label === "adapted") {
      const failedBuild = await compiler.build({
        entryPoints: [entry],
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node22.23",
        write: false,
      });
      const failedOutput = path.join(directory, "compiled.cjs");
      fs.writeFileSync(failedOutput, failedBuild.outputFiles[0].contents);
      assert.throws(() => require(failedOutput), /owned-runtime-init-failure/);
    }
  }
  console.log(
    JSON.stringify({
      passed: true,
      canonicalExports: Object.keys(baseline),
      cjsEagerOrder: true,
      cachedModuleIdentity: true,
      initializationFailurePropagates: true,
      hashDriftRejected: true,
    }),
  );
} finally {
  delete observations[marker];
  fs.rmSync(root, { recursive: true, force: true });
}
